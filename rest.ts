// rest.ts — the GitHub REST v3 surface: /api/v3.
//
// Routes: root, meta, user, user/repos, repos (get/patch/delete), branches,
// commits, git refs, contents, labels, issues, comments, pulls and merges.
// Every reply is JSON with a non-empty X-GitHub-Request-Id; errors are
// {message}. Auth is enforced by app.ts before dispatch, except for the
// root and meta endpoints, which are public.

import {
  EPOCH_SEC,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  ZERO_OID,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function b64encodeId(kind: string, parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

function iso(): string {
  return new Date(EPOCH_SEC * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: b64encodeId('User', [VIEWER_ID]),
    avatar_url: '',
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    html_url: `https://example.invalid/${VIEWER_LOGIN}`,
    url: `/api/v3/users/${VIEWER_LOGIN}`,
  };
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: b64encodeId('Repository', [repo.id]),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: iso(),
    updated_at: iso(),
    pushed_at: iso(),
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    license: null,
  };
}

function labelJson(label: { name: string; color: string; description: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: b64encodeId('Issue', [repo.id, issue.number]),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { name, color: '000000', description: '' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: iso(),
    updated_at: iso(),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: b64encodeId('PullRequest', [repo.id, pull.number]),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    mergeable: pull.state === 'open',
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: iso(),
    updated_at: iso(),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitTimestamp(repo: Repo, oid: string): number {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return 0;
  const text = obj.data.toString('utf8');
  const match = /committer [^\n]* (\d+) \+0000/.exec(text);
  return match !== null ? parseInt(match[1] as string, 10) : 0;
}

function commitJson(store: Store, repo: Repo, oid: string): Record<string, unknown> {
  const info = store.commitInfo(repo, oid);
  const message = info !== null ? info.message : '';
  const authorLine = info !== null ? info.author : '';
  const committerLine = info !== null ? info.committer : '';
  const person = (line: string): Record<string, string> => {
    const match = /^(.*) <([^>]*)> (\d+) \+0000$/.exec(line);
    if (match === null) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: iso() };
    return {
      name: match[1] as string,
      email: match[2] as string,
      date: new Date(parseInt(match[3] as string, 10) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  };
  return {
    sha: oid,
    commit: {
      message,
      author: person(authorLine),
      committer: person(committerLine),
      tree: { sha: info !== null ? info.tree : '' },
    },
    parents: (info !== null ? info.parents : []).map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${oid}`,
  };
}

// ---------------------------------------------------------------- pagination

interface PageParams {
  page: number;
  perPage: number;
}

function pageParams(query: URLSearchParams): PageParams {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPageRaw = parseInt(query.get('per_page') ?? '30', 10) || 30;
  const perPage = Math.min(100, Math.max(1, perPageRaw));
  return { page, perPage };
}

function paginate<T>(fullUrl: string, query: URLSearchParams, items: readonly T[]): { pageItems: T[]; link: string | null } {
  const { page, perPage } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const base = fullUrl.split('?')[0] as string;
  const linkFor = (p: number): string => `<${base}?page=${p}&per_page=${perPage}>`;
  const parts: string[] = [];
  if (page < totalPages) parts.push(`${linkFor(page + 1)}; rel="next"`);
  if (page > 1) parts.push(`${linkFor(page - 1)}; rel="prev"`);
  parts.push(`${linkFor(1)}; rel="first"`);
  parts.push(`${linkFor(totalPages)}; rel="last"`);
  return { pageItems, link: parts.join(', ') };
}

// ---------------------------------------------------------------- contents

/** Walk tree objects to find a path. Returns file/dir info or null. */
function lookupPath(repo: Repo, treeOid: string, path: string): { kind: 'file' | 'dir'; oid: string; mode: string } | null {
  if (path === '') return { kind: 'dir', oid: treeOid, mode: '40000' };
  const parts = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (let index = 0; index < parts.length; index += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((item) => item.name === parts[index]);
    if (entry === undefined) return null;
    if (index === parts.length - 1) {
      return { kind: entry.mode === '40000' ? 'dir' : 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function dirListing(repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    sha: entry.oid,
    size: 0,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${prefix === '' ? entry.name : `${prefix}/${entry.name}`}`,
  }));
}

/** Commit a new flat tree on a branch; returns the new commit oid. */
function commitFlatTree(
  store: Store,
  repo: Repo,
  branch: string,
  message: string,
  flat: ReadonlyMap<string, { mode: string; oid: string }>,
): string {
  const treeOid = store.buildTreeFromMap(repo, flat);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const parents = tip !== undefined ? [tip] : [];
  const timestamp = EPOCH_SEC + store.clock;
  store.clock += 1;
  const data = buildCommit({ tree: treeOid, parents, message, timestamp });
  const commitOid = store.putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

// ---------------------------------------------------------------- routing

type Body = Record<string, unknown>;

function asBody(body: unknown): Body {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Body) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function routeRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  fullUrl: string,
  body: unknown,
): RestResult {
  const b = asBody(body);
  // GET /api/v3/ (root)
  if (segments.length === 0) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_url: '/api/v3/users/{user}',
        emojis_url: '/api/v3/emojis',
        meta_url: '/api/v3/meta',
      },
      headers: { 'X-OAuth-Scopes': 'repo, user' },
    };
  }
  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: true, github_services_sha: '0000000000000000000000000000000000000000' } };
  }
  // /api/v3/user...
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return err(405, 'Method Not Allowed');
      return { status: 200, body: userJson() };
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        const all = [...store.repos.values()];
        const { pageItems, link } = paginate(fullUrl, query, all);
        return { status: 200, body: pageItems.map((repo) => repoJson(store, repo)), headers: link !== null ? { Link: link } : undefined };
      }
      if (method === 'POST') {
        const name = str(b.name);
        if (name === undefined || name === '' || !/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') {
          return err(422, 'Invalid repository name');
        }
        if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
          return err(422, `Repository ${VIEWER_LOGIN}/${name} already exists`);
        }
        const repo = store.createRepo(VIEWER_LOGIN, name, str(b.description) ?? '', b.private === true);
        return { status: 201, body: repoJson(store, repo) };
      }
      return err(405, 'Method Not Allowed');
    }
    return err(404, 'Not Found');
  }
  // /api/v3/repos/{owner}/{repo}/...
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = store.getRepo(owner, name);
    const rest = segments.slice(3);
    if (repo === undefined) return err(404, 'Not Found');
    // Repo itself.
    if (rest.length === 0) {
      if (method === 'GET') return { status: 200, body: repoJson(store, repo) };
      if (method === 'PATCH') {
        if (str(b.description) !== undefined) repo.description = str(b.description) as string;
        if (str(b.default_branch) !== undefined) repo.defaultBranch = str(b.default_branch) as string;
        return { status: 200, body: repoJson(store, repo) };
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(405, 'Method Not Allowed');
    }
    // Branches.
    if (rest[0] === 'branches') {
      if (rest.length === 1) {
        if (method !== 'GET') return err(405, 'Method Not Allowed');
        const list = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => ({
            name: ref.slice('refs/heads/'.length),
            commit: { sha: repo.refs.get(ref) },
            protected: false,
          }));
        return { status: 200, body: list };
      }
      if (rest.length === 2) {
        const branch = rest[1] as string;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return err(404, 'Not Found');
        if (method !== 'GET') return err(405, 'Method Not Allowed');
        return { status: 200, body: { name: branch, commit: { sha: tip }, protected: false } };
      }
      return err(404, 'Not Found');
    }
    // Commits.
    if (rest[0] === 'commits') {
      if (rest.length === 1) {
        if (method !== 'GET') return err(405, 'Method Not Allowed');
        const refParam = query.get('sha');
        const tip = refParam !== null ? store.resolveRef(repo, refParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === null || tip === undefined) return { status: 200, body: [] };
        const seen = new Set<string>();
        const ordered: string[] = [];
        const stack = [tip];
        while (stack.length > 0) {
          const oid = stack.pop() as string;
          if (seen.has(oid)) continue;
          const info = store.commitInfo(repo, oid);
          if (info === null) continue;
          seen.add(oid);
          ordered.push(oid);
          for (const parent of info.parents) stack.push(parent);
        }
        ordered.sort((a, c) => commitTimestamp(repo, c) - commitTimestamp(repo, a));
        const { pageItems } = paginate(fullUrl, query, ordered);
        return { status: 200, body: pageItems.map((oid) => commitJson(store, repo, oid)) };
      }
      if (rest.length === 2) {
        const oid = rest[1] as string;
        if (method !== 'GET') return err(405, 'Method Not Allowed');
        if (store.getObject(repo, oid) === undefined || store.commitInfo(repo, oid) === null) return err(404, 'Not Found');
        return { status: 200, body: commitJson(store, repo, oid) };
      }
      return err(404, 'Not Found');
    }
    // Git refs.
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = str(b.ref);
        const sha = str(b.sha);
        if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) {
          return err(422, 'Invalid ref or SHA');
        }
        if (repo.refs.has(ref)) return err(422, `Reference ${ref} already exists`);
        if (store.commitInfo(repo, sha) === null) return err(422, 'Invalid SHA: object is not a commit');
        repo.refs.set(ref, sha);
        return { status: 201, body: { ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}` } };
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const oid = repo.refs.get(ref);
        if (oid === undefined) return err(404, 'Not Found');
        const obj = store.getObject(repo, oid);
        const type = obj !== undefined ? obj.type : 'commit';
        return { status: 200, body: { ref, object: { sha: oid, type }, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}` } };
      }
      return err(404, 'Not Found');
    }
    // Contents.
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
      if (method === 'GET') {
        const refParam = query.get('ref');
        const tip = refParam !== null ? store.resolveRef(repo, refParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === null || tip === undefined) return err(404, 'Not Found');
        const info = store.commitInfo(repo, tip);
        if (info === null) return err(404, 'Not Found');
        const found = lookupPath(repo, info.tree, path);
        if (found === null) return err(404, 'Not Found');
        if (found.kind === 'dir') {
          return { status: 200, body: dirListing(repo, found.oid, path) };
        }
        const blob = store.getObject(repo, found.oid);
        if (blob === undefined) return err(404, 'Not Found');
        return {
          status: 200,
          body: {
            type: 'file',
            encoding: 'base64',
            size: blob.data.length,
            name: path.split('/').pop() ?? path,
            path,
            content: blob.data.toString('base64'),
            sha: found.oid,
            url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
          },
        };
      }
      if (method === 'PUT') {
        const message = str(b.message);
        const content = str(b.content);
        if (message === undefined || content === undefined) return err(422, 'message and content are required');
        let bytes: Buffer;
        try {
          bytes = Buffer.from(content, 'base64');
        } catch {
          return err(422, 'content is not valid base64');
        }
        const branch = str(b.branch) ?? repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        const baseFlat = new Map<string, { mode: string; oid: string }>();
        if (tip !== undefined) {
          const info = store.commitInfo(repo, tip);
          if (info !== null) {
            for (const [p, entry] of store.treeMap(repo, info.tree)) baseFlat.set(p, entry);
          }
        }
        const existing = baseFlat.get(path);
        const sha = str(b.sha);
        if (existing !== undefined) {
          if (sha === undefined || sha !== existing.oid) return err(409, 'sha does not match the current file');
        }
        const blobOid = store.putObject(repo, 'blob', bytes);
        baseFlat.set(path, { mode: '100644', oid: blobOid });
        const commitOid = commitFlatTree(store, repo, branch, message, baseFlat);
        return {
          status: existing !== undefined ? 200 : 201,
          body: {
            content: {
              name: path.split('/').pop() ?? path,
              path,
              sha: blobOid,
              size: bytes.length,
              type: 'file',
              encoding: 'base64',
              content,
              url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
            },
            commit: { sha: commitOid, message },
          },
        };
      }
      if (method === 'DELETE') {
        const message = str(b.message);
        const sha = str(b.sha);
        if (message === undefined || sha === undefined) return err(422, 'message and sha are required');
        const branch = str(b.branch) ?? repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return err(404, 'Not Found');
        const info = store.commitInfo(repo, tip);
        if (info === null) return err(404, 'Not Found');
        const flat = store.treeMap(repo, info.tree);
        const existing = flat.get(path);
        if (existing === undefined) return err(404, 'Not Found');
        if (existing.oid !== sha) return err(409, 'sha does not match the current file');
        flat.delete(path);
        const commitOid = commitFlatTree(store, repo, branch, message, flat);
        return { status: 200, body: { commit: { sha: commitOid, message } } };
      }
      return err(405, 'Method Not Allowed');
    }
    // Labels.
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        return { status: 200, body: [...repo.labels.values()].map(labelJson) };
      }
      if (method === 'POST' && rest.length === 1) {
        const name = str(b.name);
        if (name === undefined || name === '') return err(422, 'Label name is required');
        const existing = repo.labels.get(name);
        if (existing !== undefined) return { status: 201, body: labelJson(existing) };
        const label = { name, color: str(b.color) ?? '000000', description: str(b.description) ?? '' };
        repo.labels.set(name, label);
        return { status: 201, body: labelJson(label) };
      }
      return err(404, 'Not Found');
    }
    // Issues.
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = repo.issues;
          if (state === 'open') list = list.filter((issue) => issue.state === 'open');
          else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
          const direction = query.get('direction') ?? 'desc';
          const sorted = [...list];
          if (query.get('sort') === 'created' || query.get('sort') === null) {
            sorted.sort((a, c) => (direction === 'asc' ? a.number - c.number : c.number - a.number));
          }
          const { pageItems, link } = paginate(fullUrl, query, sorted);
          return { status: 200, body: pageItems.map((issue) => issueJson(store, repo, issue)), headers: link !== null ? { Link: link } : undefined };
        }
        if (method === 'POST') {
          const title = str(b.title);
          if (title === undefined || title === '') return err(422, 'Title is required');
          const labelNames = Array.isArray(b.labels) ? (b.labels as unknown[]).map((item) => (typeof item === 'string' ? item : (item as Body).name as string)) : [];
          for (const labelName of labelNames) {
            if (!repo.labels.has(labelName)) return err(422, `Label ${labelName} does not exist`);
          }
          const issue: Issue = {
            id: store.nextIssueId,
            number: repo.nextIssueNumber,
            title,
            body: str(b.body) ?? '',
            state: 'open',
            labels: labelNames,
            comments: [],
          };
          store.nextIssueId += 1;
          repo.nextIssueNumber += 1;
          repo.issues.push(issue);
          return { status: 201, body: issueJson(store, repo, issue) };
        }
        return err(405, 'Method Not Allowed');
      }
      const number = parseInt(rest[1] as string, 10);
      const issue = Number.isInteger(number) ? repo.issues.find((item) => item.number === number) : undefined;
      if (issue === undefined) {
        if (rest.length >= 2) return err(404, 'Not Found');
        return err(404, 'Not Found');
      }
      if (rest.length === 2) {
        if (method === 'GET') return { status: 200, body: issueJson(store, repo, issue) };
        if (method === 'PATCH') {
          if (str(b.title) !== undefined) issue.title = str(b.title) as string;
          if (str(b.body) !== undefined) issue.body = str(b.body) as string;
          if (str(b.state) === 'open' || str(b.state) === 'closed') issue.state = str(b.state) as 'open' | 'closed';
          if (Array.isArray(b.labels)) {
            const labelNames = (b.labels as unknown[]).map((item) => (typeof item === 'string' ? item : (item as Body).name as string));
            for (const labelName of labelNames) {
              if (!repo.labels.has(labelName)) return err(422, `Label ${labelName} does not exist`);
            }
            issue.labels = labelNames;
          }
          return { status: 200, body: issueJson(store, repo, issue) };
        }
        return err(405, 'Method Not Allowed');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          const { pageItems } = paginate(fullUrl, query, issue.comments);
          return {
            status: 200,
            body: pageItems.map((comment) => ({
              id: comment.id,
              body: comment.body,
              user: { login: comment.user, id: VIEWER_ID, type: 'User' },
              created_at: iso(),
              updated_at: iso(),
            })),
          };
        }
        if (method === 'POST') {
          const commentBody = str(b.body);
          if (commentBody === undefined || commentBody === '') return err(422, 'Comment body is required');
          const comment = { id: repo.nextCommentId, body: commentBody, user: VIEWER_LOGIN };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          return {
            status: 201,
            body: { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: iso(), updated_at: iso() },
          };
        }
        return err(405, 'Method Not Allowed');
      }
      return err(404, 'Not Found');
    }
    // Pulls.
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = repo.pulls;
          if (state === 'open') list = list.filter((pull) => pull.state === 'open');
          else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
          const { pageItems, link } = paginate(fullUrl, query, [...list].sort((a, c) => a.number - c.number));
          return { status: 200, body: pageItems.map((pull) => pullJson(store, repo, pull)), headers: link !== null ? { Link: link } : undefined };
        }
        if (method === 'POST') {
          const title = str(b.title);
          const head = str(b.head);
          const base = str(b.base);
          if (title === undefined || title === '' || head === undefined || base === undefined) {
            return err(422, 'title, head and base are required');
          }
          const headTip = repo.refs.get(`refs/heads/${head}`);
          const baseTip = repo.refs.get(`refs/heads/${base}`);
          if (headTip === undefined || baseTip === undefined) return err(422, 'head or base branch does not exist');
          const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
          if (duplicate !== undefined) return err(422, 'A pull request already exists for this head branch');
          const pull: Pull = {
            id: store.nextPullId,
            number: repo.nextPullNumber,
            title,
            body: str(b.body) ?? '',
            state: 'open',
            merged: false,
            mergedAt: null,
            mergeSha: null,
            headRef: head,
            baseRef: base,
            headSha: headTip,
            baseSha: baseTip,
          };
          store.nextPullId += 1;
          repo.nextPullNumber += 1;
          repo.pulls.push(pull);
          return { status: 201, body: pullJson(store, repo, pull) };
        }
        return err(405, 'Method Not Allowed');
      }
      const number = parseInt(rest[1] as string, 10);
      const pull = Number.isInteger(number) ? repo.pulls.find((item) => item.number === number) : undefined;
      if (pull === undefined) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method !== 'GET') return err(405, 'Method Not Allowed');
        return { status: 200, body: pullJson(store, repo, pull) };
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') return err(405, 'Method Not Allowed');
        const base = store.mergeBase(repo, pull.headSha, pull.baseSha);
        const headInfo = store.commitInfo(repo, pull.headSha);
        if (base === null || headInfo === null) return { status: 200, body: [] };
        const baseInfo = store.commitInfo(repo, base);
        const baseMap = baseInfo !== null ? store.treeMap(repo, baseInfo.tree) : new Map<string, { mode: string; oid: string }>();
        const headMap = store.treeMap(repo, headInfo.tree);
        const files: Array<Record<string, unknown>> = [];
        const allPaths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
        for (const path of [...allPaths].sort()) {
          const inBase = baseMap.get(path);
          const inHead = headMap.get(path);
          if (inBase !== undefined && inHead !== undefined && inBase.oid === inHead.oid) continue;
          if (inBase === undefined && inHead !== undefined) {
            const blob = store.getObject(repo, inHead.oid);
            const additions = blob !== undefined ? blob.data.toString('utf8').split('\n').filter((line) => line !== '').length || 1 : 1;
            files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
          } else if (inBase !== undefined && inHead === undefined) {
            const blob = store.getObject(repo, inBase.oid);
            const deletions = blob !== undefined ? blob.data.toString('utf8').split('\n').filter((line) => line !== '').length || 1 : 1;
            files.push({ filename: path, status: 'changed', additions: 0, deletions, changes: deletions });
          } else if (inBase !== undefined && inHead !== undefined) {
            const oldBlob = store.getObject(repo, inBase.oid);
            const newBlob = store.getObject(repo, inHead.oid);
            const oldLines = oldBlob !== undefined ? oldBlob.data.toString('utf8').split('\n') : [];
            const newLines = newBlob !== undefined ? newBlob.data.toString('utf8').split('\n') : [];
            const oldCount = new Map<string, number>();
            for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
            let additions = 0;
            for (const line of newLines) {
              const remaining = oldCount.get(line) ?? 0;
              if (remaining > 0) oldCount.set(line, remaining - 1);
              else additions += 1;
            }
            let deletions = 0;
            for (const remaining of oldCount.values()) deletions += remaining;
            if (additions === 0 && deletions === 0) {
              // Same lines, different bytes (e.g. trailing newline): count as one change.
              additions = 1;
              deletions = 1;
            }
            files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
          }
        }
        return { status: 200, body: files };
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') return err(405, 'Method Not Allowed');
        if (pull.merged) return err(405, 'Pull request already merged');
        if (pull.state !== 'open') return err(405, 'Pull request is not open');
        const base = store.mergeBase(repo, pull.headSha, pull.baseSha);
        const headInfo = store.commitInfo(repo, pull.headSha);
        const baseInfo = base !== null ? store.commitInfo(repo, base) : null;
        if (base === null || headInfo === null || baseInfo === null) return err(405, 'Merge conflict');
        const baseMap = store.treeMap(repo, baseInfo.tree);
        const headMap = store.treeMap(repo, headInfo.tree);
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        if (baseTip === undefined) return err(404, 'Not Found');
        const baseTipInfo = store.commitInfo(repo, baseTip);
        if (baseTipInfo === null) return err(405, 'Merge conflict');
        const oursMap = store.treeMap(repo, baseTipInfo.tree);
        const merged = new Map<string, { mode: string; oid: string }>();
        let conflict = false;
        const allPaths = new Set<string>([...baseMap.keys(), ...oursMap.keys(), ...headMap.keys()]);
        for (const path of allPaths) {
          const b = baseMap.get(path);
          const o = oursMap.get(path);
          const t = headMap.get(path);
          const same = (a?: { oid: string }, c?: { oid: string }): boolean =>
            (a === undefined && c === undefined) || (a !== undefined && c !== undefined && a.oid === c.oid);
          if (same(o, b)) {
            if (t !== undefined) merged.set(path, t);
          } else if (same(t, b)) {
            if (o !== undefined) merged.set(path, o);
          } else if (same(o, t)) {
            if (o !== undefined) merged.set(path, o);
          } else {
            conflict = true;
            break;
          }
        }
        if (conflict) return err(405, 'Merge conflict');
        const mergedTree = store.buildTreeFromMap(repo, merged);
        const timestamp = EPOCH_SEC + store.clock;
        store.clock += 1;
        const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`;
        const commitData = buildCommit({ tree: mergedTree, parents: [baseTip], message, timestamp });
        const mergeSha = store.putObject(repo, 'commit', commitData);
        repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = new Date((EPOCH_SEC + store.clock) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        pull.mergeSha = mergeSha;
        return { status: 200, body: { merged: true, sha: mergeSha, message: 'Pull request successfully merged' } };
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}
