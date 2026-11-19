// mcp.ts — the MCP endpoint (JSON-RPC 2.0 Streamable HTTP, modern era
// 2026-07-28): server/discover, initialize, tools/list and tools/call.
// No sessions, no SSE: plain JSON answers. Auth is enforced by app.ts.

import { EPOCH_SEC, VIEWER_LOGIN, buildCommit, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export interface McpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the viewer.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Pull request state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
];

type Args = Record<string, unknown>;

function strArg(args: Args, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function intArg(args: Args, name: string): number | undefined {
  const value = args[name];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function toolOk(obj: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function getRepoOrError(store: Store, args: Args): { repo: Repo } | { error: string } {
  const owner = strArg(args, 'owner');
  const repoName = strArg(args, 'repo');
  if (owner === undefined || repoName === undefined) return { error: 'owner and repo are required' };
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return { error: `Repository ${owner}/${repoName} not found` };
  return { repo };
}

function callTool(store: Store, name: string, args: Args): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = strArg(args, 'name');
      if (repoName === undefined || repoName === '') return toolError('Missing required argument: name');
      if (!/^[A-Za-z0-9_.-]+$/.test(repoName)) return toolError('Invalid repository name');
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) return toolError(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
      const repo = store.createRepo(VIEWER_LOGIN, repoName, strArg(args, 'description') ?? '', args.private === true);
      return toolOk(repoJson(store, repo));
    }
    case 'get_repo': {
      const found = getRepoOrError(store, args);
      if ('error' in found) return toolError(found.error);
      return toolOk(repoJson(store, found.repo));
    }
    case 'create_issue': {
      const found = getRepoOrError(store, args);
      if ('error' in found) return toolError(found.error);
      const title = strArg(args, 'title');
      if (title === undefined || title === '') return toolError('Missing required argument: title');
      const repo = found.repo;
      const issue: Issue = {
        id: store.nextIssueId,
        number: repo.nextIssueNumber,
        title,
        body: strArg(args, 'body') ?? '',
        state: 'open',
        labels: [],
        comments: [],
      };
      store.nextIssueId += 1;
      repo.nextIssueNumber += 1;
      repo.issues.push(issue);
      return toolOk(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const found = getRepoOrError(store, args);
      if ('error' in found) return toolError(found.error);
      const state = strArg(args, 'state') ?? 'open';
      let list = found.repo.issues;
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      const obj = { issues: list.map((issue) => issueJson(store, found.repo, issue)), total_count: list.length };
      return toolOk(obj);
    }
    case 'create_pull_request': {
      const found = getRepoOrError(store, args);
      if ('error' in found) return toolError(found.error);
      const title = strArg(args, 'title');
      const head = strArg(args, 'head');
      const base = strArg(args, 'base');
      if (title === undefined || title === '' || head === undefined || base === undefined) {
        return toolError('Missing required argument: title, head or base');
      }
      const repo = found.repo;
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (headTip === undefined || baseTip === undefined) return toolError('head or base branch does not exist');
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate !== undefined) return toolError('A pull request already exists for this head branch');
      const pull: Pull = {
        id: store.nextPullId,
        number: repo.nextPullNumber,
        title,
        body: strArg(args, 'body') ?? '',
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
      return toolOk(pullJson(store, repo, pull));
    }
    case 'merge_pull_request': {
      const found = getRepoOrError(store, args);
      if ('error' in found) return toolError(found.error);
      const number = intArg(args, 'pull_number');
      if (number === undefined) return toolError('Missing required argument: pull_number');
      const repo = found.repo;
      const pull = repo.pulls.find((item) => item.number === number);
      if (pull === undefined) return toolError(`Pull request #${number} not found`);
      if (pull.state !== 'open') return toolError('Pull request is not open');
      // Merge via the same three-way rule as REST: reuse the REST merge by
      // calling into a shared helper is not possible here, so duplicate the
      // small conflict check and squash commit inline.
      const base = store.mergeBase(repo, pull.headSha, pull.baseSha);
      const headInfo = store.commitInfo(repo, pull.headSha);
      const baseInfo = base !== null ? store.commitInfo(repo, base) : null;
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      const baseTipInfo = baseTip !== undefined ? store.commitInfo(repo, baseTip) : null;
      if (base === null || headInfo === null || baseInfo === null || baseTip === undefined || baseTipInfo === null) {
        return toolError('Merge conflict');
      }
      const baseMap = store.treeMap(repo, baseInfo.tree);
      const headMap = store.treeMap(repo, headInfo.tree);
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
      if (conflict) return toolError('Merge conflict');
      const mergedTree = store.buildTreeFromMap(repo, merged);
      const timestamp = EPOCH_SEC + store.clock;
      store.clock += 1;
      const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`;
      const mergeSha = store.putObject(repo, 'commit', buildCommit({ tree: mergedTree, parents: [baseTip], message, timestamp }));
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = new Date((EPOCH_SEC + store.clock) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      pull.mergeSha = mergeSha;
      return toolOk({ merged: true, number: pull.number, state: 'closed', sha: mergeSha });
    }
    case 'list_repos': {
      const repos = [...store.repos.values()].map((repo) => repoJson(store, repo));
      return toolOk({ repositories: repos, total_count: repos.length });
    }
    case 'get_issue': {
      const found = getRepoOrError(store, args);
      if ('error' in found) return toolError(found.error);
      const number = intArg(args, 'issue_number');
      if (number === undefined) return toolError('Missing required argument: issue_number');
      const issue = found.repo.issues.find((item) => item.number === number);
      if (issue === undefined) return toolError(`Issue #${number} not found`);
      return toolOk(issueJson(store, found.repo, issue));
    }
    case 'list_pull_requests': {
      const found = getRepoOrError(store, args);
      if ('error' in found) return toolError(found.error);
      const state = strArg(args, 'state') ?? 'open';
      let list = found.repo.pulls;
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      return toolOk({ pull_requests: list.map((pull) => pullJson(store, found.repo, pull)), total_count: list.length });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function handleOne(store: Store, request: unknown): { status: number; body: unknown } | null {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const record = request as Record<string, unknown>;
  const id = 'id' in record ? record.id : undefined;
  const isNotification = id === undefined;
  const method = record.method;
  if (typeof method !== 'string') {
    if (isNotification) return null;
    return { status: 200, body: rpcError(id, -32600, 'Invalid Request') };
  }
  if (method.startsWith('notifications/')) return null; // 202, no body
  if (isNotification) return null; // any other notification: 202, no body
  const params = (record.params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: ['2026-07-28', '2025-11-25'],
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        }),
      };
    case 'initialize':
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: '2026-07-28',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      };
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Args;
      const tool = TOOLS.find((item) => item.name === toolName);
      if (tool === undefined) {
        return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${toolName}`) };
      }
      for (const required of tool.inputSchema.required) {
        if (args[required] === undefined) {
          return { status: 200, body: rpcResult(id, toolError(`Missing required argument: ${required}`)) };
        }
      }
      return { status: 200, body: rpcResult(id, callTool(store, toolName, args)) };
    }
    default:
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

export function handleMcp(store: Store, bodyText: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const results: unknown[] = [];
    for (const request of parsed) {
      const outcome = handleOne(store, request);
      if (outcome !== null) results.push(outcome.body);
    }
    return { status: 200, body: results };
  }
  const outcome = handleOne(store, parsed);
  if (outcome === null) return { status: 202, body: null };
  return outcome;
}
