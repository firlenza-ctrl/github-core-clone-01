// gitproto.ts — git smart HTTP: pkt-lines, advertisements, upload-pack
// (v0 and v2), and receive-pack.
//
// The wire shapes here mirror the kit's git-client.ts exactly: v2 ls-refs
// and fetch section framing, v0 advertisement capability placement, and the
// report-status stream inside sideband band 1.

import { readPack, selectFetch, writePack, ZERO_OID, type Repo, type Store } from './store.ts';

export interface GitResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

function flushPkt(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const MAX_DATA = 65515; // pkt-line max 65520 minus 4-byte header minus band byte
  for (let pos = 0; pos < data.length; pos += MAX_DATA) {
    const chunk = data.subarray(pos, Math.min(data.length, pos + MAX_DATA));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

export interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/**
 * Decode a pkt-line stream. Throws on a malformed length, a bad length, or
 * a truncated stream. A flush is '0000', a delim is '0001'.
 */
export function decodePktLines(buf: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('pkt-line truncated');
    const lenText = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`pkt-line bad length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) throw new Error('pkt-line length out of range');
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return packets;
}

function pktLinesToText(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

const UPLOAD_CAPS = 'side-band-64k shallow thin-pack ofs-delta symref=HEAD:refs/heads/main';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs';

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs of a repo, HEAD first, then branches, then tags (peeled). */
function collectRefs(store: Store, repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  out.push({ oid: mainTip ?? ZERO_OID, name: 'HEAD' });
  const branches = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
  for (const ref of branches) {
    out.push({ oid: repo.refs.get(ref) as string, name: ref });
  }
  const tags = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/tags/')).sort();
  for (const ref of tags) {
    const oid = repo.refs.get(ref) as string;
    const peeled = store.peelToCommit(repo, oid);
    const entry: RefLine = { oid, name: ref };
    if (peeled !== null && peeled !== oid) entry.peeled = peeled;
    out.push(entry);
  }
  return out;
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', store: Store, repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), flushPkt()];
  const refs = collectRefs(store, repo);
  if (repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('object-format=sha1\n'),
    flushPkt(),
  ]);
}

export function handleInfoRefs(
  store: Store,
  repo: Repo | undefined,
  service: 'git-upload-pack' | 'git-receive-pack',
  protocolVersion: string | null,
): GitResult {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && protocolVersion === 'version=2') {
    return { status: 200, contentType, body: v2Advertisement() };
  }
  return { status: 200, contentType, body: v0Advertisement(service, store, repo) };
}

// ---------------------------------------------------------------- upload-pack

function lsRefsV2(store: Store, repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  if (repo.refs.size === 0) {
    if (keep('HEAD') && unborn) {
      lines.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
  } else {
    if (keep('HEAD')) {
      const extra = symrefs ? ' symref-target:refs/heads/main' : '';
      lines.push(pktLine(`${mainTip ?? ZERO_OID} HEAD${extra}\n`));
    }
    for (const ref of collectRefs(store, repo)) {
      if (ref.name === 'HEAD') continue;
      if (!keep(ref.name)) continue;
      const extra = peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : '';
      lines.push(pktLine(`${ref.oid} ${ref.name}${extra}\n`));
    }
  }
  lines.push(flushPkt());
  return Buffer.concat(lines);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, done, object-format, agent, filter:
    // acknowledged and ignored.
  }
  return args;
}

function fetchResponseV2(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const selection = selectFetch(store, repo, args.wants, args.haves, args.depth, args.shallow);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (selection.acks.length > 0) {
    for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(flushPkt());
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(flushPkt());
  }
  if (selection.objects.size > 0) {
    const pack = writePack(selection.objects);
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(1, pack));
    parts.push(flushPkt());
  }
  return Buffer.concat(parts);
}

function fetchResponseV0(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const selection = selectFetch(store, repo, args.wants, args.haves, args.depth, args.shallow);
  const parts: Buffer[] = [];
  if (selection.acks.length > 0) {
    for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (selection.objects.size > 0) {
    const pack = writePack(selection.objects);
    parts.push(...sidebandPackets(1, pack));
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

export function handleUploadPack(
  store: Store,
  repo: Repo | undefined,
  body: Buffer,
  protocolVersion: string | null,
): GitResult {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  let packets: Pkt[];
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line' }), 'utf8') };
  }
  const lines = pktLinesToText(packets);
  const contentType = 'application/x-git-upload-pack-result';
  if (protocolVersion === 'version=2') {
    const command = (lines[0] ?? '').replace(/\n$/, '');
    if (command === 'command=ls-refs') {
      const delimIndex = packets.findIndex((p) => p.kind === 'delim');
      const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : [];
      const args = pktLinesToText(argPackets).map((line) => line.replace(/\n$/, ''));
      return { status: 200, contentType, body: lsRefsV2(store, repo, args) };
    }
    if (command === 'command=fetch') {
      const delimIndex = packets.findIndex((p) => p.kind === 'delim');
      const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : [];
      const args = parseFetchArgs(pktLinesToText(argPackets));
      return { status: 200, contentType, body: fetchResponseV2(store, repo, args) };
    }
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'unknown v2 command' }), 'utf8') };
  }
  // v0 fetch: wants/shallow/deepen, flush, haves/done, flush.
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (packet.kind === 'data') {
      (sections[sections.length - 1] as string[]).push(packet.payload.toString('utf8'));
    }
  }
  const allLines = [...(sections[0] ?? []), ...(sections[1] ?? [])];
  const args = parseFetchArgs(allLines);
  return { status: 200, contentType, body: fetchResponseV0(store, repo, args) };
}

// ---------------------------------------------------------------- receive-pack

export function handleReceivePack(store: Store, repo: Repo | undefined, body: Buffer): GitResult {
  const contentType = 'application/x-git-receive-pack-result';
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
  }
  // Split the command pkt-lines from the pack: pkt-lines run until the first flush.
  let pos = 0;
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let packStart = -1;
  try {
    while (pos < body.length) {
      if (pos + 4 > body.length) throw new Error('pkt-line truncated');
      const lenText = body.subarray(pos, pos + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error('pkt-line bad length');
      const len = parseInt(lenText, 16);
      if (len === 0) {
        pos += 4;
        packStart = pos;
        break;
      }
      if (len < 4 || pos + len > body.length) throw new Error('pkt-line length out of range');
      const payload = body.subarray(pos + 4, pos + len).toString('utf8');
      const nul = payload.indexOf('\0');
      const line = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
      if (match === null) throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
      commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
      pos += len;
    }
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line' }), 'utf8') };
  }
  if (packStart < 0) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'missing flush after commands' }), 'utf8') };
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'no push commands' }), 'utf8') };
  }
  const packBytes = body.subarray(packStart);
  const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackError: string | null = null;
  if (hasUpdates) {
    if (packBytes.length === 0) {
      unpackError = 'missing pack';
    } else {
      try {
        const entries = readPack(packBytes);
        for (const entry of entries) {
          store.putObject(repo, entry.type, entry.data);
        }
      } catch (err) {
        unpackError = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  }
  // Apply the ref updates in order. Objects are stored even when a ref is refused.
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) {
        reportLines.push(`ng ${command.ref} invalid command\n`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reportLines.push(`ng ${command.ref} already exists\n`);
          continue;
        }
        if (store.getObject(repo, command.newOid) === undefined) {
          reportLines.push(`ng ${command.ref} object not found\n`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
        continue;
      }
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} reference does not exist\n`);
          continue;
        }
        if (current !== command.oldOid) {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
        continue;
      }
      // Update.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} reference does not exist\n`);
        continue;
      }
      if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      if (store.getObject(repo, command.newOid) === undefined) {
        reportLines.push(`ng ${command.ref} object not found\n`);
        continue;
      }
      if (command.newOid !== command.oldOid && !store.isAncestor(repo, command.oldOid, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    }
  }
  const report = Buffer.from(reportLines.join(''), 'utf8');
  const bodyOut = Buffer.concat([...sidebandPackets(1, report), flushPkt()]);
  return { status: 200, contentType, body: bodyOut };
}
