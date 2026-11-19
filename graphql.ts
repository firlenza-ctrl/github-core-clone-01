// graphql.ts — a small hand-written GraphQL v4 executor.
//
// Supports the suite's surface: queries/mutations, variables, aliases,
// inline fragments, input objects, inline enums and null literals; batched
// operations (a JSON array) answer a JSON array in order. Unknown fields
// answer HTTP 200 with an `errors` array naming the field.

import {
  VIEWER_ID,
  VIEWER_LOGIN,
  buildCommit,
  EPOCH_SEC,
  parseCommit,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { b64encodeId } from './rest.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < src.length) {
    const ch = src[pos] as string;
    if (/\s|,/.test(ch)) {
      pos += 1;
      continue;
    }
    if (ch === '#') {
      while (pos < src.length && src[pos] !== '\n') pos += 1;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      pos += 1;
      continue;
    }
    if (ch === '.' && src.slice(pos, pos + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      pos += 3;
      continue;
    }
    if (ch === '"') {
      let out = '';
      pos += 1;
      while (pos < src.length && src[pos] !== '"') {
        if (src[pos] === '\\' && pos + 1 < src.length) {
          const esc = src[pos + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          pos += 2;
        } else {
          out += src[pos];
          pos += 1;
        }
      }
      pos += 1;
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(pos));
      if (match !== null) {
        const text = match[0];
        tokens.push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value: parseFloat(text) } : { kind: 'int', value: parseInt(text, 10) });
        pos += text.length;
        continue;
      }
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(pos));
      if (match !== null) {
        tokens.push({ kind: 'name', value: match[0] });
        pos += match[0].length;
        continue;
      }
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- AST

export type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

export type SelectionNode =
  | FieldNode
  | { kind: 'fragment'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'spread'; name: string };

export interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Map<string, { defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

export interface Document {
  operations: Operation[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek() !== undefined) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        this.expectName(); // type condition
        fragments.set(name, this.parseSelectionSet());
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token !== undefined && token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = token.value;
      this.next();
      const next = this.peek();
      if (next !== undefined && next.kind === 'name') name = this.expectName();
    }
    const variables = new Map<string, { defaultValue: ValueNode | null }>();
    if (this.matchPunct('(')) {
      while (!this.matchPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.matchPunct('=')) defaultValue = this.parseValue();
        variables.set(varName, { defaultValue });
      }
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseType(): void {
    if (this.matchPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.matchPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.matchPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.matchPunct('...')) {
      const token = this.peek();
      if (token !== undefined && token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (token !== undefined && token.kind === 'name') {
        return { kind: 'spread', name: this.expectName() };
      }
      return { kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.matchPunct('(')) {
      while (!this.matchPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    // Directives: parse and ignore (@name / @name(args)).
    while (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '@') {
      this.next();
      this.expectName();
      if (this.matchPunct('(')) {
        while (!this.matchPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as Token).value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as Token).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ---------------------------------------------------------------- values

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((item) => item.name === name);
  return arg === undefined ? undefined : valueOf(arg.value, variables);
}

// ---------------------------------------------------------------- ids

function repoGlobalId(repo: Repo): string {
  return b64encodeId('Repository', [repo.id]);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64encodeId('Issue', [repo.id, issue.number]);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return b64encodeId('PullRequest', [repo.id, pull.number]);
}

function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return b64encodeId('IssueComment', [repo.id, issue.number, commentId]);
}

interface DecodedId {
  kind: string;
  parts: string[];
}

function decodeGlobalId(id: string): DecodedId | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor === null) return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match !== null ? parseInt(match[1] as string, 10) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- introspection

interface TypeField {
  name: string;
  type: string;
}

const INTROSPECTION: Record<string, { kind: string; fields?: TypeField[]; enumValues?: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'databaseId', type: 'Int' },
      { name: 'number', type: 'Int' },
      { name: 'title', type: 'String' },
      { name: 'body', type: 'String' },
      { name: 'state', type: 'IssueState' },
      { name: 'url', type: 'String' },
      { name: 'createdAt', type: 'String' },
      { name: 'author', type: 'User' },
      { name: 'labels', type: 'LabelConnection' },
      { name: 'comments', type: 'IssueCommentConnection' },
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'databaseId', type: 'Int' },
      { name: 'number', type: 'Int' },
      { name: 'title', type: 'String' },
      { name: 'body', type: 'String' },
      { name: 'state', type: 'PullRequestState' },
      { name: 'merged', type: 'Boolean' },
      { name: 'headRefName', type: 'String' },
      { name: 'baseRefName', type: 'String' },
      { name: 'mergeable', type: 'MergeableState' },
      { name: 'files', type: 'PullRequestChangedFileConnection' },
      { name: 'url', type: 'String' },
      { name: 'createdAt', type: 'String' },
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'databaseId', type: 'Int' },
      { name: 'name', type: 'String' },
      { name: 'nameWithOwner', type: 'String' },
      { name: 'description', type: 'String' },
      { name: 'owner', type: 'User' },
      { name: 'defaultBranchRef', type: 'Ref' },
      { name: 'viewerPermission', type: 'RepositoryPermission' },
      { name: 'hasIssuesEnabled', type: 'Boolean' },
      { name: 'issue', type: 'Issue' },
      { name: 'issues', type: 'IssueConnection' },
      { name: 'pullRequest', type: 'PullRequest' },
      { name: 'pullRequests', type: 'PullRequestConnection' },
      { name: 'url', type: 'String' },
      { name: 'createdAt', type: 'String' },
    ],
  },
  User: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'login', type: 'String' },
      { name: 'name', type: 'String' },
      { name: 'email', type: 'String' },
    ],
  },
  SearchType: {
    kind: 'ENUM',
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'WIKI'],
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
};

function typeRef(typeName: string): Record<string, unknown> {
  return { name: typeName, kind: 'SCALAR', ofType: null };
}

function introspectionObject(name: string): Record<string, unknown> | null {
  const entry = INTROSPECTION[name];
  if (entry === undefined) return null;
  const fields = (entry.fields ?? []).map((field) => ({
    name: field.name,
    description: null,
    type: typeRef(field.type),
    args: [],
    isDeprecated: false,
    deprecationReason: null,
  }));
  const enumValues = (entry.enumValues ?? []).map((value) => ({ name: value, description: null, isDeprecated: false, deprecationReason: null }));
  return {
    name,
    kind: entry.kind,
    description: null,
    fields: entry.kind === 'OBJECT' ? fields : null,
    enumValues: entry.kind === 'ENUM' ? enumValues : null,
    interfaces: [],
    possibleTypes: null,
  };
}

// ---------------------------------------------------------------- executor

type AnyRecord = Record<string, unknown>;

interface Executor {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, SelectionNode[]>;
}

function unknownField(exec: Executor, typeName: string, fieldName: string): null {
  exec.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

/** Resolve a selection set against a value and its GraphQL type name. */
function resolveSelections(
  exec: Executor,
  parent: unknown,
  typeName: string,
  selections: readonly SelectionNode[],
): AnyRecord {
  const out: AnyRecord = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      const nested = resolveSelections(exec, parent, typeName, selection.selections);
      Object.assign(out, nested);
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = exec.fragments.get(selection.name);
      if (fragment !== undefined) {
        const nested = resolveSelections(exec, parent, typeName, fragment);
        Object.assign(out, nested);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(exec, parent, typeName, selection);
  }
  return out;
}

function findRepoById(exec: Executor, id: number): Repo | undefined {
  for (const repo of exec.store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function computeMergeable(exec: Executor, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const base = exec.store.mergeBase(repo, pull.headSha, pull.baseSha);
  const headInfo = exec.store.commitInfo(repo, pull.headSha);
  const baseInfo = base !== null ? exec.store.commitInfo(repo, base) : null;
  if (base === null || headInfo === null || baseInfo === null) return 'CONFLICTING';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return 'CONFLICTING';
  const baseTipInfo = exec.store.commitInfo(repo, baseTip);
  if (baseTipInfo === null) return 'CONFLICTING';
  const baseMap = exec.store.treeMap(repo, baseInfo.tree);
  const headMap = exec.store.treeMap(repo, headInfo.tree);
  const oursMap = exec.store.treeMap(repo, baseTipInfo.tree);
  const allPaths = new Set<string>([...baseMap.keys(), ...oursMap.keys(), ...headMap.keys()]);
  for (const path of allPaths) {
    const b = baseMap.get(path);
    const o = oursMap.get(path);
    const t = headMap.get(path);
    const same = (a?: { oid: string }, c?: { oid: string }): boolean =>
      (a === undefined && c === undefined) || (a !== undefined && c !== undefined && a.oid === c.oid);
    if (same(o, b) || same(t, b) || same(o, t)) continue;
    return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function resolveIssueConnection(
  exec: Executor,
  repo: Repo,
  field: FieldNode,
): AnyRecord {
  const first = argValue(field, 'first', exec.variables);
  const states = argValue(field, 'states', exec.variables);
  const orderBy = argValue(field, 'orderBy', exec.variables) as AnyRecord | undefined;
  const after = argValue(field, 'after', exec.variables) as string | undefined;
  let list = [...repo.issues];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((item) => String(item)));
    list = list.filter((issue) => wanted.has(issueState(issue)));
  }
  const direction = orderBy !== undefined && typeof orderBy === 'object' && orderBy !== null && (orderBy as AnyRecord).direction === 'DESC' ? 'DESC' : 'ASC';
  list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const afterNumber = numberFromCursor(after);
  if (afterNumber !== null) {
    list = list.filter((issue) => (direction === 'DESC' ? issue.number < afterNumber : issue.number > afterNumber));
  }
  const limit = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.trunc(first)) : list.length;
  const page = list.slice(0, limit);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as Issue).number) : null;
  const subSelections = field.selections ?? [];
  const nodes = page.map((issue) => resolveSelections(exec, { __type: 'Issue', repo, issue }, 'Issue', subSelectionsFor(subSelections, 'nodes')));
  const pageInfo = resolveSelections(exec, { __type: 'PageInfo', hasNextPage, endCursor }, 'PageInfo', subSelectionsFor(subSelections, 'pageInfo'));
  return { nodes, pageInfo, totalCount: repo.issues.length };
}

function subSelectionsFor(selections: readonly SelectionNode[], fieldName: string): SelectionNode[] {
  for (const selection of selections) {
    if (selection.kind === 'field' && selection.name === fieldName) return selection.selections ?? [];
  }
  return [];
}

function resolveField(exec: Executor, parent: unknown, typeName: string, field: FieldNode): unknown {
  const p = parent as AnyRecord;
  switch (typeName) {
    case 'Query':
      return resolveQueryField(exec, field);
    case 'Mutation':
      return resolveMutationField(exec, field);
    case 'User': {
      if (field.name === 'login') return p.login ?? VIEWER_LOGIN;
      if (field.name === 'id') return b64encodeId('User', [VIEWER_ID]);
      if (field.name === 'name') return VIEWER_NAME;
      if (field.name === 'email') return VIEWER_EMAIL;
      return unknownField(exec, typeName, field.name);
    }
    case 'Repository': {
      const repo = p.repo as Repo;
      switch (field.name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'description': return repo.description;
        case 'owner': return resolveSelections(exec, { __type: 'User', login: repo.owner }, 'User', field.selections ?? []);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (tip === undefined) return null;
          return resolveSelections(exec, { __type: 'Ref', name: repo.defaultBranch }, 'Ref', field.selections ?? []);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'url': return `https://example.invalid/${repo.owner}/${repo.name}`;
        case 'createdAt': return new Date(EPOCH_SEC * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        case 'issue': {
          const number = argValue(field, 'number', exec.variables);
          const issue = typeof number === 'number' ? repo.issues.find((item) => item.number === number) : undefined;
          if (issue === undefined) return null;
          return resolveSelections(exec, { __type: 'Issue', repo, issue }, 'Issue', field.selections ?? []);
        }
        case 'issues': return resolveIssueConnection(exec, repo, field);
        case 'pullRequest': {
          const number = argValue(field, 'number', exec.variables);
          const pull = typeof number === 'number' ? repo.pulls.find((item) => item.number === number) : undefined;
          if (pull === undefined) return null;
          return resolveSelections(exec, { __type: 'PullRequest', repo, pull }, 'PullRequest', field.selections ?? []);
        }
        case 'pullRequests': {
          const first = argValue(field, 'first', exec.variables);
          const list = [...repo.pulls].sort((a, b) => a.number - b.number);
          const limit = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.trunc(first)) : list.length;
          const page = list.slice(0, limit);
          const sub = field.selections ?? [];
          return {
            nodes: page.map((pull) => resolveSelections(exec, { __type: 'PullRequest', repo, pull }, 'PullRequest', subSelectionsFor(sub, 'nodes'))),
            pageInfo: resolveSelections(exec, { __type: 'PageInfo', hasNextPage: list.length > page.length, endCursor: page.length > 0 ? cursorFor((page[page.length - 1] as Pull).number) : null }, 'PageInfo', subSelectionsFor(sub, 'pageInfo')),
            totalCount: repo.pulls.length,
          };
        }
        default:
          return unknownField(exec, typeName, field.name);
      }
    }
    case 'Issue': {
      const issue = p.issue as Issue;
      const repo = p.repo as Repo;
      switch (field.name) {
        case 'id': return issueGlobalId(repo, issue);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issueState(issue);
        case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'createdAt': return new Date(EPOCH_SEC * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        case 'author': return resolveSelections(exec, { __type: 'User', login: VIEWER_LOGIN }, 'User', field.selections ?? []);
        default:
          return unknownField(exec, typeName, field.name);
      }
    }
    case 'PullRequest': {
      const pull = p.pull as Pull;
      const repo = p.repo as Repo;
      switch (field.name) {
        case 'id': return pullGlobalId(repo, pull);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullState(pull);
        case 'merged': return pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': return computeMergeable(exec, repo, pull);
        case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'createdAt': return new Date(EPOCH_SEC * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        case 'files': {
          const first = argValue(field, 'first', exec.variables);
          const base = exec.store.mergeBase(repo, pull.headSha, pull.baseSha);
          const headInfo = exec.store.commitInfo(repo, pull.headSha);
          const paths: string[] = [];
          if (base !== null && headInfo !== null) {
            const baseInfo = exec.store.commitInfo(repo, base);
            const baseMap = baseInfo !== null ? exec.store.treeMap(repo, baseInfo.tree) : new Map<string, { mode: string; oid: string }>();
            const headMap = exec.store.treeMap(repo, headInfo.tree);
            const allPaths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
            for (const path of [...allPaths].sort()) {
              const inBase = baseMap.get(path);
              const inHead = headMap.get(path);
              if (inBase !== undefined && inHead !== undefined && inBase.oid === inHead.oid) continue;
              paths.push(path);
            }
          }
          const limit = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.trunc(first)) : paths.length;
          const page = paths.slice(0, limit);
          const sub = field.selections ?? [];
          return {
            nodes: page.map((path) => resolveSelections(exec, { __type: 'PullRequestChangedFile', path }, 'PullRequestChangedFile', subSelectionsFor(sub, 'nodes'))),
            pageInfo: resolveSelections(exec, { __type: 'PageInfo', hasNextPage: paths.length > page.length, endCursor: null }, 'PageInfo', subSelectionsFor(sub, 'pageInfo')),
            totalCount: paths.length,
          };
        }
        default:
          return unknownField(exec, typeName, field.name);
      }
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return p.path;
      return unknownField(exec, typeName, field.name);
    }
    case 'Ref': {
      if (field.name === 'name') return p.name;
      return unknownField(exec, typeName, field.name);
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return p.hasNextPage ?? false;
      if (field.name === 'endCursor') return p.endCursor ?? null;
      return unknownField(exec, typeName, field.name);
    }
    case 'IssueComment': {
      const comment = p.comment as { id: number; body: string };
      if (field.name === 'id') return p.globalId ?? String(comment.id);
      if (field.name === 'body') return comment.body;
      return unknownField(exec, typeName, field.name);
    }
    default:
      return unknownField(exec, typeName, field.name);
  }
}

function resolveQueryField(exec: Executor, field: FieldNode): unknown {
  switch (field.name) {
    case 'viewer':
      return resolveSelections(exec, { __type: 'User', login: VIEWER_LOGIN }, 'User', field.selections ?? []);
    case 'repository': {
      const owner = argValue(field, 'owner', exec.variables);
      const name = argValue(field, 'name', exec.variables);
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = exec.store.getRepo(owner, name);
      if (repo === undefined) return null;
      return resolveSelections(exec, { __type: 'Repository', repo }, 'Repository', field.selections ?? []);
    }
    case 'node': {
      const id = argValue(field, 'id', exec.variables);
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepoById(exec, parseInt(decoded.parts[0] as string, 10));
        if (repo === undefined) return null;
        return resolveSelections(exec, { __type: 'Repository', repo }, 'Repository', field.selections ?? []);
      }
      return null;
    }
    case '__type': {
      const name = argValue(field, 'name', exec.variables);
      if (typeof name !== 'string') return null;
      return introspectionObject(name);
    }
    case '__schema':
      return {
        queryType: { name: 'Query' },
        mutationType: { name: 'Mutation' },
        types: Object.keys(INTROSPECTION).map((name) => introspectionObject(name)),
      };
    default:
      return unknownField(exec, 'Query', field.name);
  }
}

function resolveMutationField(exec: Executor, field: FieldNode): unknown {
  const input = (argValue(field, 'input', exec.variables) ?? {}) as AnyRecord;
  const selections = field.selections ?? [];
  const pick = (name: string): SelectionNode[] => subSelectionsFor(selections, name);
  switch (field.name) {
    case 'createIssue': {
      const repoId = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = repoId !== null && repoId.kind === 'Repository' ? findRepoById(exec, parseInt(repoId.parts[0] as string, 10)) : undefined;
      if (repo === undefined) {
        exec.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        return null;
      }
      const title = String(input.title ?? '');
      const issue: Issue = {
        id: exec.store.nextIssueId,
        number: repo.nextIssueNumber,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
      };
      exec.store.nextIssueId += 1;
      repo.nextIssueNumber += 1;
      repo.issues.push(issue);
      const out: AnyRecord = {};
      if (pick('issue').length > 0) out.issue = resolveSelections(exec, { __type: 'Issue', repo, issue }, 'Issue', pick('issue'));
      if (input.clientMutationId !== undefined) out.clientMutationId = input.clientMutationId;
      return out;
    }
    case 'closeIssue': {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      let target: { repo: Repo; issue: Issue } | null = null;
      if (decoded !== null && decoded.kind === 'Issue') {
        const repo = findRepoById(exec, parseInt(decoded.parts[0] as string, 10));
        const number = parseInt(decoded.parts[1] as string, 10);
        const issue = repo?.issues.find((item) => item.number === number);
        if (repo !== undefined && issue !== undefined) target = { repo, issue };
      }
      if (target === null) {
        exec.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        return null;
      }
      target.issue.state = 'closed';
      const out: AnyRecord = {};
      if (pick('issue').length > 0) out.issue = resolveSelections(exec, { __type: 'Issue', repo: target.repo, issue: target.issue }, 'Issue', pick('issue'));
      if (input.clientMutationId !== undefined) out.clientMutationId = input.clientMutationId;
      return out;
    }
    case 'createPullRequest': {
      const repoId = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = repoId !== null && repoId.kind === 'Repository' ? findRepoById(exec, parseInt(repoId.parts[0] as string, 10)) : undefined;
      if (repo === undefined) {
        exec.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        return null;
      }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headTip = repo.refs.get(`refs/heads/${headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
      if (headTip === undefined || baseTip === undefined) {
        exec.errors.push({ message: 'Head or base branch does not exist.' });
        return null;
      }
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
      if (duplicate !== undefined) {
        exec.errors.push({ message: 'A pull request already exists for this head branch.' });
        return null;
      }
      const pull: Pull = {
        id: exec.store.nextPullId,
        number: repo.nextPullNumber,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeSha: null,
        headRef,
        baseRef,
        headSha: headTip,
        baseSha: baseTip,
      };
      exec.store.nextPullId += 1;
      repo.nextPullNumber += 1;
      repo.pulls.push(pull);
      const out: AnyRecord = {};
      if (pick('pullRequest').length > 0) out.pullRequest = resolveSelections(exec, { __type: 'PullRequest', repo, pull }, 'PullRequest', pick('pullRequest'));
      if (input.clientMutationId !== undefined) out.clientMutationId = input.clientMutationId;
      return out;
    }
    case 'mergePullRequest': {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      let target: { repo: Repo; pull: Pull } | null = null;
      if (decoded !== null && decoded.kind === 'PullRequest') {
        const repo = findRepoById(exec, parseInt(decoded.parts[0] as string, 10));
        const number = parseInt(decoded.parts[1] as string, 10);
        const pull = repo?.pulls.find((item) => item.number === number);
        if (repo !== undefined && pull !== undefined) target = { repo, pull };
      }
      if (target === null) {
        exec.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
        return null;
      }
      const { repo, pull } = target;
      if (pull.state !== 'open') {
        exec.errors.push({ message: 'Pull request is not open.' });
        return null;
      }
      if (computeMergeable(exec, repo, pull) === 'CONFLICTING') {
        exec.errors.push({ message: 'Merge conflict.' });
        return null;
      }
      const base = exec.store.mergeBase(repo, pull.headSha, pull.baseSha);
      const headInfo = exec.store.commitInfo(repo, pull.headSha);
      const baseInfo = base !== null ? exec.store.commitInfo(repo, base) : null;
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      const baseTipInfo = baseTip !== undefined ? exec.store.commitInfo(repo, baseTip) : null;
      if (base === null || headInfo === null || baseInfo === null || baseTip === undefined || baseTipInfo === null) {
        exec.errors.push({ message: 'Merge conflict.' });
        return null;
      }
      const baseMap = exec.store.treeMap(repo, baseInfo.tree);
      const headMap = exec.store.treeMap(repo, headInfo.tree);
      const oursMap = exec.store.treeMap(repo, baseTipInfo.tree);
      const merged = new Map<string, { mode: string; oid: string }>();
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
        }
      }
      const mergedTree = exec.store.buildTreeFromMap(repo, merged);
      const timestamp = EPOCH_SEC + exec.store.clock;
      exec.store.clock += 1;
      const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`;
      const mergeSha = exec.store.putObject(repo, 'commit', buildCommit({ tree: mergedTree, parents: [baseTip], message, timestamp }));
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = new Date((EPOCH_SEC + exec.store.clock) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      pull.mergeSha = mergeSha;
      const out: AnyRecord = {};
      if (pick('pullRequest').length > 0) out.pullRequest = resolveSelections(exec, { __type: 'PullRequest', repo, pull }, 'PullRequest', pick('pullRequest'));
      if (input.clientMutationId !== undefined) out.clientMutationId = input.clientMutationId;
      return out;
    }
    case 'addComment': {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      let target: { repo: Repo; issue: Issue } | null = null;
      if (decoded !== null && decoded.kind === 'Issue') {
        const repo = findRepoById(exec, parseInt(decoded.parts[0] as string, 10));
        const number = parseInt(decoded.parts[1] as string, 10);
        const issue = repo?.issues.find((item) => item.number === number);
        if (repo !== undefined && issue !== undefined) target = { repo, issue };
      }
      if (target === null) {
        exec.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        return null;
      }
      const comment = { id: target.repo.nextCommentId, body: String(input.body ?? ''), user: VIEWER_LOGIN };
      target.repo.nextCommentId += 1;
      target.issue.comments.push(comment);
      const globalId = commentGlobalId(target.repo, target.issue, comment.id);
      const nodeSelections = pick('commentEdge').length > 0 ? subSelectionsFor(pick('commentEdge'), 'node') : [];
      const out: AnyRecord = {};
      if (pick('commentEdge').length > 0) {
        out.commentEdge = {
          node: resolveSelections(exec, { __type: 'IssueComment', comment, globalId }, 'IssueComment', nodeSelections),
        };
      }
      if (input.clientMutationId !== undefined) out.clientMutationId = input.clientMutationId;
      return out;
    }
    default:
      return unknownField(exec, 'Mutation', field.name);
  }
}

// ---------------------------------------------------------------- entry point

export interface GraphqlResult {
  status: number;
  body: unknown;
}

function executeOperation(store: Store, doc: Document, operation: Operation, variables: Record<string, unknown>): AnyRecord {
  const exec: Executor = { store, variables, errors: [], fragments: doc.fragments };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveSelections(exec, { __type: rootType }, rootType, operation.selections);
  const result: AnyRecord = {};
  if (exec.errors.length > 0) result.errors = exec.errors;
  result.data = exec.errors.length > 0 && Object.keys(data).length === 0 ? null : data;
  return result;
}

export function handleGraphql(store: Store, body: unknown): GraphqlResult {
  const runOne = (payload: unknown): AnyRecord => {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return { errors: [{ message: 'GraphQL request body must be an object with a query string.' }] };
    }
    const record = payload as AnyRecord;
    const query = record.query;
    if (typeof query !== 'string' || query === '') {
      return { errors: [{ message: 'GraphQL request must include a query string.' }] };
    }
    let doc: Document;
    try {
      doc = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL document parse error' }] };
    }
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    let operation: Operation | undefined;
    if (operationName !== null) {
      operation = doc.operations.find((item) => item.name === operationName);
      if (operation === undefined) return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
    } else if (doc.operations.length === 1) {
      operation = doc.operations[0];
    } else if (doc.operations.length === 0) {
      return { errors: [{ message: 'GraphQL document contains no operations.' }] };
    } else {
      return { errors: [{ message: 'GraphQL document has multiple operations; operationName is required.' }] };
    }
    return executeOperation(store, doc, operation as Operation, variables);
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map(runOne) };
  }
  return { status: 200, body: runOne(body) };
}
