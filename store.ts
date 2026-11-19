// store.ts — the forge's in-memory data model and git object layer.
//
// Everything the forge serves lives here: repositories, refs, git objects,
// issues, pull requests, labels and comments. All state is deterministic:
// timestamps come from a logical clock (seconds since a fixed epoch), never
// from the wall clock, and ids are assigned in creation order.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The login the scenario's token names (wire.ts buildScenario: users[0]). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** Fixed epoch for the logical clock: 2025-01-01T00:00:00Z. */
export const EPOCH_SEC = 1735689600;

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
}

// ---------------------------------------------------------------- git objects

export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function identityLine(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
}

/** Serialize a commit object. Timestamps are seconds since the epoch. */
export function buildCommit(opts: {
  tree: string;
  parents: readonly string[];
  message: string;
  timestamp: number;
  author?: string;
  committer?: string;
}): Buffer {
  const author = opts.author ?? identityLine();
  const committer = opts.committer ?? identityLine();
  const lines: string[] = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author} ${opts.timestamp} +0000`);
  lines.push(`committer ${committer} ${opts.timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${opts.message}`, 'utf8');
}

/** Parse a commit object's tree, parents and message. */
export function parseCommit(data: Buffer): CommitInfo | null {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (tree === '' || !/^[0-9a-f]{40}$/.test(tree)) return null;
  return { tree, parents, author, committer, message };
}

/** Parse a tag object: returns its target oid and type. */
export function parseTag(data: Buffer): { target: string; type: string } | null {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  let target = '';
  let type = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) target = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
  }
  if (!/^[0-9a-f]{40}$/.test(target)) return null;
  return { target, type };
}

/** Git-style sort: directory entries compare as name + '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize a tree object from entries (sorted git-style). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const mode = data.subarray(pos, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- pack format

const PACK_TYPE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_TYPE_NAME: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a pack (version 2, plain objects, no deltas) for the given objects. */
export function writePack(objects: ReadonlyMap<string, GitObject>): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.size, 8);
  chunks.push(header);
  for (const obj of objects.values()) {
    const typeCode = PACK_TYPE[obj.type];
    const size = obj.data.length;
    const bytes: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>>= 4;
    if (remaining > 0) first |= 0x80;
    bytes.push(first);
    while (remaining > 0) {
      let next = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining > 0) next |= 0x80;
      bytes.push(next);
    }
    chunks.push(Buffer.from(bytes));
    chunks.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta to a base object, returning the result bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('delta varint truncated');
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (pos >= delta.length) throw new Error('delta copy truncated');
          offset |= (delta[pos] as number) << (bit * 8);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          if (pos >= delta.length) throw new Error('delta copy truncated');
          size |= (delta[pos] as number) << (bit * 8);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('delta insert truncated');
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || written !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

export interface ReadPackEntry {
  oid: string;
  type: ObjectType;
  data: Buffer;
}

/** Adler-32, the checksum a zlib stream ends with (big-endian). */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + (data[i] as number)) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate one deflated entry starting at `start`, knowing the uncompressed
 * `size`. inflateSync returns the first stream's bytes and ignores trailing
 * data, so one inflate yields the entry; the stream's end is then found by
 * locating its trailing Adler-32 checksum (verified by a second inflate).
 * Two inflates per entry, no exceptions on the common path — far cheaper
 * than a binary search over the stream end.
 */
function inflateEntry(pack: Buffer, start: number, end: number, size: number): { data: Buffer; next: number } {
  const data = inflateSync(pack.subarray(start, end));
  if (data.length !== size) throw new Error('pack entry size mismatch');
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler32(data), 0);
  let searchFrom = start + 2;
  for (;;) {
    const idx = pack.indexOf(needle, searchFrom);
    if (idx < 0 || idx + 4 > end) throw new Error('pack entry end not found');
    const candidateEnd = idx + 4;
    try {
      const check = inflateSync(pack.subarray(start, candidateEnd));
      if (check.length === size && check.equals(data)) return { data, next: candidateEnd };
    } catch {
      // A false-positive Adler match inside the deflate data; keep scanning.
    }
    searchFrom = idx + 1;
  }
}

/**
 * Parse a pack, resolving OFS/REF deltas. Returns entries in pack order.
 * Throws on a malformed pack or a bad checksum.
 */
export function readPack(pack: Buffer): ReadPackEntry[] {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack magic missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} unsupported`);
  const count = pack.readUInt32BE(8);
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  const actual = pack.subarray(pack.length - 20).toString('hex');
  if (expected !== actual) throw new Error('pack checksum mismatch');
  const end = pack.length - 20;
  let pos = 12;
  const entries: ReadPackEntry[] = [];
  const byOffset = new Map<number, ReadPackEntry>();
  const pendingRefDeltas: Array<{ baseOid: string; delta: Buffer; entryOffset: number }> = [];
  for (let index = 0; index < count; index += 1) {
    if (pos >= end) throw new Error('pack truncated');
    const entryOffset = pos;
    let byte = pack[pos] as number;
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (pos >= end) throw new Error('pack header truncated');
      byte = pack[pos] as number;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA
      if (pos >= end) throw new Error('ofs-delta offset truncated');
      byte = pack[pos] as number;
      pos += 1;
      let offset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (pos >= end) throw new Error('ofs-delta offset truncated');
        byte = pack[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      const baseOffset = entryOffset - offset;
      const { data: delta, next } = inflateEntry(pack, pos, end, size);
      pos = next;
      const base = byOffset.get(baseOffset);
      if (base === undefined) throw new Error(`ofs-delta base at offset ${baseOffset} not in pack`);
      const resolved = applyDelta(base.data, delta);
      const entry: ReadPackEntry = { oid: hashObject(base.type, resolved), type: base.type, data: resolved };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    } else if (typeCode === 7) {
      // REF_DELTA
      if (pos + 20 > end) throw new Error('ref-delta oid truncated');
      const baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const { data: delta, next } = inflateEntry(pack, pos, end, size);
      pos = next;
      pendingRefDeltas.push({ baseOid, delta, entryOffset });
      // Placeholder; resolved below once all entries are known.
      const entry: ReadPackEntry = { oid: '', type: 'blob', data: delta };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    } else {
      const type = PACK_TYPE_NAME[typeCode];
      if (type === undefined) throw new Error(`pack object type ${typeCode} unsupported`);
      const { data, next } = inflateEntry(pack, pos, end, size);
      pos = next;
      const entry: ReadPackEntry = { oid: hashObject(type, data), type, data };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    }
  }
  // Resolve REF deltas (base may be an earlier pack entry or an object the
  // caller already holds — the caller resolves those by oid after this call;
  // here we resolve against pack entries only).
  const byOid = new Map<string, ReadPackEntry>();
  for (const entry of entries) if (entry.oid !== '') byOid.set(entry.oid, entry);
  for (const pending of pendingRefDeltas) {
    const base = byOid.get(pending.baseOid);
    if (base === undefined) throw new Error(`ref-delta base ${pending.baseOid} not in pack`);
    const resolved = applyDelta(base.data, pending.delta);
    const entry = byOffset.get(pending.entryOffset);
    if (entry === undefined) throw new Error('ref-delta entry lost');
    entry.type = base.type;
    entry.data = resolved;
    entry.oid = hashObject(base.type, resolved);
    byOid.set(entry.oid, entry);
  }
  for (const entry of entries) {
    if (entry.oid === '') throw new Error('unresolved ref-delta');
  }
  return entries;
}

// ---------------------------------------------------------------- the store

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  /** Request counter (X-GitHub-Request-Id) and logical clock, both deterministic. */
  seq = 0;
  clock = 0;

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** ISO timestamp from the logical clock (does not advance it). */
  nowIso(): string {
    return new Date((EPOCH_SEC + this.clock) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** Advance the logical clock by one second and return the new timestamp. */
  tickIso(): string {
    this.clock += 1;
    return this.nowIso();
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(Store.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.repoKey(owner, name));
  }

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  commitInfo(repo: Repo, oid: string): CommitInfo | null {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return null;
    return parseCommit(obj.data);
  }

  /** Resolve a tag to its target commit (peeling annotated tags). */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let depth = 0; depth < 10; depth += 1) {
      const obj = repo.objects.get(current);
      if (obj === undefined) return null;
      if (obj.type === 'commit') return current;
      if (obj.type === 'tag') {
        const tag = parseTag(obj.data);
        if (tag === null) return null;
        current = tag.target;
        continue;
      }
      return null;
    }
    return null;
  }

  /** All ancestor commits of `tip` (including tip), unlimited depth. */
  ancestors(repo: Repo, tip: string): Set<string> {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const info = this.commitInfo(repo, oid);
      if (info === null) continue;
      seen.add(oid);
      for (const parent of info.parents) stack.push(parent);
    }
    return seen;
  }

  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    return this.ancestors(repo, tip).has(ancestor);
  }

  /** Best common ancestor of two commits (deepest by longest path from root). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = this.ancestors(repo, a);
    const ancestorsB = this.ancestors(repo, b);
    const common: string[] = [];
    for (const oid of ancestorsA) if (ancestorsB.has(oid)) common.push(oid);
    if (common.length === 0) return null;
    // Depth = longest chain from a root commit.
    const depthCache = new Map<string, number>();
    const depth = (oid: string): number => {
      const cached = depthCache.get(oid);
      if (cached !== undefined) return cached;
      const info = this.commitInfo(repo, oid);
      let best = 0;
      if (info !== null) {
        for (const parent of info.parents) best = Math.max(best, depth(parent) + 1);
      }
      depthCache.set(oid, best);
      return best;
    };
    let bestOid = common[0] as string;
    let bestDepth = -1;
    for (const oid of common) {
      const d = depth(oid);
      if (d > bestDepth) {
        bestDepth = d;
        bestOid = oid;
      }
    }
    return bestOid;
  }

  /** Flatten a tree (by oid) into path -> {mode, oid}. */
  treeMap(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build nested tree objects from a flat path map; returns the root tree oid. */
  buildTreeFromMap(repo: Repo, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
    const buildLevel = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, value] of flat) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: value.mode, name: rest, oid: value.oid });
        } else {
          dirs.add(rest.slice(0, slash));
        }
      }
      for (const dir of dirs) {
        const childPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
        entries.push({ mode: '40000', name: dir, oid: buildLevel(childPrefix) });
      }
      const data = buildTree(entries);
      return this.putObject(repo, 'tree', data);
    };
    return buildLevel('');
  }

  /** Resolve a ref name (branch, tag, HEAD) to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref === 'HEAD') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip ?? null;
    }
    const oid = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
    return oid ?? null;
  }

  /** The commit oid a branch points at, or null. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }
}

export interface FetchSelection {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * Select the objects a fetch must send.
 *
 * wants: commit/tag oids the client asked for. haves: oids the client holds.
 * depth: when set, only `depth` generations from the wants are included and
 *   the generation-depth-1 commits become the shallow boundaries.
 * oldShallow: the client's current shallow boundaries (from a previous
 *   shallow fetch). A have that is an old boundary is held WITHOUT its
 *   parents; a have that is not a boundary is held WITH its full ancestry.
 */
export function selectFetch(
  store: Store,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | undefined,
  oldShallow: readonly string[],
): FetchSelection {
  const oldBoundary = new Set(oldShallow);
  // Generation of each commit reachable from the wants (0 = want itself).
  const generation = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const want of wants) {
    const peeled = store.peelToCommit(repo, want);
    const start = peeled ?? want;
    if (!generation.has(start)) {
      generation.set(start, 0);
      queue.push({ oid: start, gen: 0 });
    }
  }
  const boundary = new Set<string>();
  while (queue.length > 0) {
    const item = queue.shift() as { oid: string; gen: number };
    if (depth !== undefined && item.gen >= depth - 1) {
      boundary.add(item.oid);
      continue;
    }
    const info = store.commitInfo(repo, item.oid);
    if (info === null) continue;
    for (const parent of info.parents) {
      if (!generation.has(parent)) {
        generation.set(parent, item.gen + 1);
        queue.push({ oid: parent, gen: item.gen + 1 });
      }
    }
  }
  // Objects the client already holds.
  const held = new Set<string>();
  const holdTree = (treeOid: string): void => {
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    if (held.has(treeOid)) return;
    held.add(treeOid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') holdTree(entry.oid);
      else held.add(entry.oid);
    }
  };
  const holdCommitAndTree = (oid: string): void => {
    if (held.has(oid)) return;
    const info = store.commitInfo(repo, oid);
    if (info === null) return;
    held.add(oid);
    holdTree(info.tree);
  };
  for (const have of haves) {
    const peeled = store.peelToCommit(repo, have);
    const start = peeled ?? have;
    if (oldBoundary.has(start) || oldBoundary.has(have)) {
      // Shallow have: held without its parents.
      holdCommitAndTree(start);
      continue;
    }
    // Full have: held with its whole ancestry.
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const info = store.commitInfo(repo, oid);
      if (info === null) continue;
      held.add(oid);
      holdTree(info.tree);
      for (const parent of info.parents) stack.push(parent);
    }
  }
  // Objects reachable from the wants (within depth), minus held objects.
  const send = new Map<string, GitObject>();
  const addObject = (oid: string): void => {
    if (held.has(oid) || send.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj === undefined) return;
    send.set(oid, obj);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      if (info !== null) addObject(info.tree);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) addObject(entry.oid);
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag !== null) addObject(tag.target);
    }
  };
  for (const want of wants) addObject(want);
  for (const oid of generation.keys()) addObject(oid);
  // Only commits inside the depth window count as included for shallow math;
  // a want commit beyond the window is never included (depth >= 1 always
  // includes the want itself, so this only trims tag targets).
  const includedCommits = new Set<string>();
  for (const [oid] of generation) includedCommits.add(oid);
  const shallow = [...boundary].filter((oid) => includedCommits.has(oid));
  const unshallow = oldShallow.filter((oid) => includedCommits.has(oid));
  const acks: string[] = [];
  for (const have of haves) {
    const peeled = store.peelToCommit(repo, have);
    const start = peeled ?? have;
    if (generation.has(start)) acks.push(have);
  }
  return { objects: send, shallow, unshallow, acks };
}
