// GitHub GraphQL v4 API at POST /api/graphql: a small, purpose-built GraphQL engine for the
// documents gh and github-mcp-server actually send (see spec-graphql-mcp.md). It parses the
// document (operations, variables, aliases, arguments, inline fragments, input objects,
// enums, batching), validates field names against a fixed schema, and executes against the
// shared store. Unknown fields are a GraphQL error (HTTP 200 + errors[]), unknown repos are
// null, missing auth is 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { branchRef, commitTree, diffTrees, mergeBase, refTip, squashMerge } from './git-repo.ts';
import { VIEWER, type ForgeStore, type Issue, type Pull, type Repo } from './store.ts';
import { isAuthenticated, parseJsonBody, sendError, sendJson } from './http-utils.ts';

// ---------------------------------------------------------------- global ids

/** Opaque, stable global ids: base64 of "kind:repoId:number". Never the plain number. */
export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`repo:${repo.id}`).toString('base64');
}
export function issueGlobalId(repo: Repo, issue: Issue): string {
  return Buffer.from(`issue:${repo.id}:${issue.number}`).toString('base64');
}
export function pullGlobalId(repo: Repo, pull: Pull): string {
  return Buffer.from(`pr:${repo.id}:${pull.number}`).toString('base64');
}
function commentGlobalId(commentId: number): string {
  return Buffer.from(`comment:${commentId}`).toString('base64');
}

type DecodedId =
  | { kind: 'repo'; repoId: number }
  | { kind: 'issue'; repoId: number; number: number }
  | { kind: 'pr'; repoId: number; number: number }
  | { kind: 'comment'; id: number }
  | undefined;

function decodeGlobalId(id: string): DecodedId {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts[0] === 'repo' && parts.length === 2) return { kind: 'repo', repoId: Number(parts[1]) };
    if (parts[0] === 'issue' && parts.length === 3) return { kind: 'issue', repoId: Number(parts[1]), number: Number(parts[2]) };
    if (parts[0] === 'pr' && parts.length === 3) return { kind: 'pr', repoId: Number(parts[1]), number: Number(parts[2]) };
    if (parts[0] === 'comment' && parts.length === 2) return { kind: 'comment', id: Number(parts[1]) };
  } catch {
    // Not a global id we issued.
  }
  return undefined;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<[string, ValueNode]> };

interface FieldNode {
  kind: 'field';
  alias: string | undefined;
  name: string;
  args: Array<[string, ValueNode]>;
  selection: SelectionNode[] | undefined;
}
interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | undefined;
  selection: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | undefined;
  selection: SelectionNode[];
}

type Token =
  | { type: 'name'; value: string }
  | { type: 'string'; value: string }
  | { type: 'int'; value: string }
  | { type: 'float'; value: string }
  | { type: 'punct'; value: string }
  | { type: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  const isDigit = (c: string): boolean => /[0-9]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ type: 'spread' });
      i += 3;
      continue;
    }
    if ('{}():$![]=|&@'.includes(c)) {
      tokens.push({ type: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      // Block strings (""") are not used by the suite; support plain strings with escapes.
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ type: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length) {
        const ch = source[j] as string;
        if (ch === '"') break;
        if (ch === '\\') {
          const esc = source[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          j += 2;
          continue;
        }
        value += ch;
        j += 1;
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ type: 'string', value });
      i = j + 1;
      continue;
    }
    if (c === '-' || isDigit(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && isDigit(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && isDigit(source[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < source.length && isDigit(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && isDigit(source[j] as string)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { type: 'float', value: text } : { type: 'int', value: text });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ type: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  return tokens;
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
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }
  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.type === 'punct' && token.value === value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('empty document');
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const first = this.peek();
    if (first !== undefined && first.type === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = first.value;
      this.next();
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName.type === 'name') {
        name = maybeName.value;
        this.next();
      }
      // Variable definitions: ($var: Type!, ...) — parse and discard (values come from the request).
      if (this.atPunct('(')) {
        this.skipParens();
      }
      // Directives (@...) are not used by the suite; skip any.
      this.skipDirectives();
    }
    const selection = this.parseSelectionSet();
    return { kind, name, selection };
  }

  /** Skip a balanced (...) group, including nested parens/brackets. */
  private skipParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.type === 'punct' && token.value === '(') depth += 1;
      else if (token.type === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.next(); // directive name
      if (this.atPunct('(')) this.skipParens();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const nodes: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      nodes.push(this.parseSelection());
    }
    this.expectPunct('}');
    return nodes;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token !== undefined && token.type === 'spread') {
      this.next();
      let typeCondition: string | undefined;
      const on = this.peek();
      if (on !== undefined && on.type === 'name' && on.value === 'on') {
        this.next();
        const typeToken = this.next();
        if (typeToken.type !== 'name') throw new Error('expected a type name after "on"');
        typeCondition = typeToken.value;
      }
      this.skipDirectives();
      return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
    }
    // Field: [alias ':'] name [(args)] [selection]
    const first = this.next();
    if (first.type !== 'name') throw new Error('expected a field name');
    let alias: string | undefined;
    let name = first.value;
    if (this.atPunct(':')) {
      this.next();
      const real = this.next();
      if (real.type !== 'name') throw new Error('expected a field name after ":"');
      alias = name;
      name = real.value;
    }
    const args: Array<[string, ValueNode]> = [];
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.next();
        if (argName.type !== 'name') throw new Error('expected an argument name');
        this.expectPunct(':');
        args.push([argName.value, this.parseValue()]);
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selection = this.atPunct('{') ? this.parseSelectionSet() : undefined;
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.type === 'punct' && token.value === '$') {
      const name = this.next();
      if (name.type !== 'name') throw new Error('expected a variable name after "$"');
      return { kind: 'variable', name: name.value };
    }
    if (token.type === 'string') return { kind: 'string', value: token.value };
    if (token.type === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.type === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.type === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.type === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.type === 'punct' && token.value === '{') {
      const fields: Array<[string, ValueNode]> = [];
      while (!this.atPunct('}')) {
        const fieldName = this.next();
        if (fieldName.type !== 'name') throw new Error('expected an object field name');
        this.expectPunct(':');
        fields.push([fieldName.value, this.parseValue()]);
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('expected a value');
  }
}

/** Resolve a value node against the request variables into a plain JS value. */
function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [name, value] of node.fields) out[name] = resolveValue(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema

/** Fields each object type exposes, for validation (unknown field -> GraphQL error). */
const SCHEMA_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
  ],
  Ref: ['name', 'id'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

/** The type a field returns (for descending validation); undefined = scalar/unknown. */
const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User',
    defaultBranchRef: 'Ref',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
  IssueEdge: { node: 'Issue' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequest: { files: 'PullRequestChangedFileConnection' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
};

/** Introspection field lists (must include every field the checks require). */
const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged',
    'files', 'author', 'createdAt', 'updatedAt',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt',
  ],
  User: ['id', 'login', 'name', 'email'],
  Node: ['id'],
};
const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

/** Validate an operation's selections against the schema; returns error messages (empty = valid). */
function validateOperation(op: Operation): string[] {
  const errors: string[] = [];
  const walk = (typeName: string, selection: SelectionNode[]): void => {
    for (const node of selection) {
      if (node.kind === 'fragment') {
        // An inline fragment on a type: validate its selections against that type when the
        // condition names a concrete type; for the Node interface, Repository is the only
        // runtime type we return, so validate against the condition directly.
        walk(node.typeCondition ?? typeName, node.selection);
        continue;
      }
      const allowed = SCHEMA_FIELDS[typeName] ?? SCHEMA_FIELDS.Node ?? [];
      // The Node interface exposes only `id`; inline fragments carry the rest.
      const known = typeName === 'Node' ? node.name === 'id' : allowed.includes(node.name);
      if (!known) {
        errors.push(`Cannot query field "${node.name}" on type "${typeName}".`);
        continue;
      }
      if (node.selection !== undefined) {
        const childType = FIELD_TYPES[typeName]?.[node.name];
        if (childType !== undefined) walk(childType, node.selection);
      }
    }
  };
  walk(op.kind === 'mutation' ? 'Mutation' : 'Query', op.selection);
  return errors;
}

// ---------------------------------------------------------------- execution

interface Ctx {
  store: ForgeStore;
  variables: Record<string, unknown>;
}

/** A resolved object value: its GraphQL type plus the underlying store entity (or data). */
type Obj =
  | { __typename: 'User' }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __typename: 'PullRequestChangedFileConnection'; files: Array<{ path: string }> }
  | { __typename: 'PullRequestChangedFile'; path: string }
  | { __typename: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'AddCommentPayload'; comment: { id: number; body: string } }
  | { __typename: 'IssueCommentEdge'; comment: { id: number; body: string } }
  | { __typename: 'IssueComment'; comment: { id: number; body: string } }
  | { __typename: '__Type'; typeName: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string };

function argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of field.args) out[name] = resolveValue(value, ctx.variables);
  return out;
}

function findRepoById(store: ForgeStore, repoId: number): Repo | undefined {
  return store.listRepos().find((repo) => repo.id === repoId);
}

/** Cursor for issue pagination: base64 of "issue-cursor:<number>". */
function issueCursor(number: number): string {
  return Buffer.from(`issue-cursor:${number}`).toString('base64');
}
function decodeIssueCursor(cursor: string): number | undefined {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('issue-cursor:')) return undefined;
    const n = Number(text.slice('issue-cursor:'.length));
    return Number.isInteger(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

function executeSelection(parent: Obj | null, parentType: string, selection: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'fragment') {
      // Apply the fragment when its type condition matches (or is absent).
      if (node.typeCondition === undefined || node.typeCondition === parentType) {
        Object.assign(out, executeSelection(parent, parentType, node.selection, ctx));
      }
      continue;
    }
    const key = node.alias ?? node.name;
    out[key] = resolveField(parent, parentType, node, ctx);
  }
  return out;
}

function resolveField(parent: Obj | null, parentType: string, field: FieldNode, ctx: Ctx): unknown {
  const args = argsOf(field, ctx);
  const select = (obj: Obj | null, type: string): unknown => {
    if (field.selection === undefined) return obj;
    if (obj === null) return null;
    return executeSelection(obj, type, field.selection, ctx);
  };

  // ---- Query root --------------------------------------------------------
  if (parent === null && parentType === 'Query') {
    if (field.name === 'viewer') {
      return select({ __typename: 'User' }, 'User');
    }
    if (field.name === 'repository') {
      const owner = args.owner as string;
      const name = args.name as string;
      if (owner !== VIEWER.login) return null;
      const repo = ctx.store.getRepo(owner, name);
      if (repo === undefined) return null;
      return select({ __typename: 'Repository', repo }, 'Repository');
    }
    if (field.name === 'node') {
      const decoded = decodeGlobalId(args.id as string);
      if (decoded?.kind === 'repo') {
        const repo = findRepoById(ctx.store, decoded.repoId);
        if (repo === undefined) return null;
        return select({ __typename: 'Repository', repo }, 'Repository');
      }
      return null;
    }
    if (field.name === '__type') {
      const typeName = args.name as string;
      if (INTROSPECTION_FIELDS[typeName] === undefined && INTROSPECTION_ENUMS[typeName] === undefined) return null;
      return select({ __typename: '__Type', typeName }, '__Type');
    }
  }

  // ---- Mutation root -----------------------------------------------------
  if (parent === null && parentType === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(input.repositoryId as string);
      const repo = decoded?.kind === 'repo' ? findRepoById(ctx.store, decoded.repoId) : undefined;
      if (repo === undefined) return null;
      const issue = ctx.store.createIssue(repo, (input.title as string) ?? '', (input.body as string) ?? '', []);
      return select({ __typename: 'CreateIssuePayload', repo, issue }, 'CreateIssuePayload');
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(input.issueId as string);
      if (decoded?.kind !== 'issue') return null;
      const repo = findRepoById(ctx.store, decoded.repoId);
      const issue = repo?.issues.find((i) => i.number === decoded.number);
      if (repo === undefined || issue === undefined) return null;
      issue.state = 'closed';
      return select({ __typename: 'CloseIssuePayload', repo, issue }, 'CloseIssuePayload');
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(input.repositoryId as string);
      const repo = decoded?.kind === 'repo' ? findRepoById(ctx.store, decoded.repoId) : undefined;
      if (repo === undefined) return null;
      const head = input.headRefName as string;
      const base = input.baseRefName as string;
      const headSha = refTip(repo, branchRef(head));
      const baseSha = refTip(repo, branchRef(base));
      if (headSha === undefined || baseSha === undefined) return null;
      const pull = ctx.store.createPull(repo, (input.title as string) ?? '', '', head, base, headSha, baseSha);
      return select({ __typename: 'CreatePullRequestPayload', repo, pull }, 'CreatePullRequestPayload');
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(input.pullRequestId as string);
      if (decoded?.kind !== 'pr') return null;
      const repo = findRepoById(ctx.store, decoded.repoId);
      const pull = repo?.pulls.find((p) => p.number === decoded.number);
      if (repo === undefined || pull === undefined) return null;
      if (pull.state === 'open') {
        const result = squashMerge(repo, pull.head, pull.base, pull.number);
        if (result.ok) {
          pull.state = 'closed';
          pull.merged = true;
          pull.mergedAt = new Date().toISOString();
          pull.mergeCommitSha = result.commitSha;
        }
      }
      return select({ __typename: 'MergePullRequestPayload', repo, pull }, 'MergePullRequestPayload');
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(input.subjectId as string);
      if (decoded?.kind !== 'issue') return null;
      const repo = findRepoById(ctx.store, decoded.repoId);
      const issue = repo?.issues.find((i) => i.number === decoded.number);
      if (repo === undefined || issue === undefined) return null;
      const comment = ctx.store.addComment(issue, (input.body as string) ?? '');
      return select({ __typename: 'AddCommentPayload', comment }, 'AddCommentPayload');
    }
  }

  if (parent === null) return null;

  // ---- object fields -----------------------------------------------------
  switch (parent.__typename) {
    case 'User': {
      if (field.name === 'login') return VIEWER.login;
      if (field.name === 'id') return Buffer.from(`user:${VIEWER.id}`).toString('base64');
      if (field.name === 'name') return VIEWER.name;
      if (field.name === 'email') return VIEWER.email;
      return null;
    }
    case 'Repository': {
      const { repo } = parent;
      switch (field.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return select({ __typename: 'User' }, 'User');
        case 'defaultBranchRef':
          return select({ __typename: 'Ref', name: repo.defaultBranch }, 'Ref');
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.private;
        case 'issue': {
          const issue = repo.issues.find((i) => i.number === (args.number as number));
          if (issue === undefined) return null;
          return select({ __typename: 'Issue', repo, issue }, 'Issue');
        }
        case 'issues': {
          let issues = [...repo.issues];
          const states = args.states as string[] | undefined;
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((s) => s.toLowerCase()));
            issues = issues.filter((i) => wanted.has(i.state));
          }
          const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
          if (orderBy?.field === 'CREATED_AT' && orderBy.direction === 'DESC') {
            issues.sort((a, b) => b.createdSeq - a.createdSeq);
          } else if (orderBy?.field === 'CREATED_AT' && orderBy.direction === 'ASC') {
            issues.sort((a, b) => a.createdSeq - b.createdSeq);
          } else {
            issues.sort((a, b) => a.createdSeq - b.createdSeq);
          }
          // Cursor pagination (after: null means "from the start").
          const after = args.after as string | null | undefined;
          if (typeof after === 'string') {
            const afterNumber = decodeIssueCursor(after);
            if (afterNumber !== undefined) {
              const idx = issues.findIndex((i) => i.number === afterNumber);
              if (idx !== -1) issues = issues.slice(idx + 1);
            }
          }
          const first = typeof args.first === 'number' ? args.first : issues.length;
          const page = issues.slice(0, first);
          const hasNextPage = issues.length > page.length;
          const endCursor = page.length > 0 ? issueCursor((page[page.length - 1] as Issue).number) : null;
          return select(
            { __typename: 'IssueConnection', repo, issues: page, pageInfo: { hasNextPage, endCursor } },
            'IssueConnection',
          );
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
          const pulls = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq).slice(0, first);
          return select({ __typename: 'PullRequestConnection', repo, pulls }, 'PullRequestConnection');
        }
        case 'pullRequest': {
          const pull = repo.pulls.find((p) => p.number === (args.number as number));
          if (pull === undefined) return null;
          return select({ __typename: 'PullRequest', repo, pull }, 'PullRequest');
        }
        default:
          return null;
      }
    }
    case 'Ref':
      return field.name === 'name' ? parent.name : null;
    case 'Issue': {
      const { repo, issue } = parent;
      switch (field.name) {
        case 'id':
          return issueGlobalId(repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return issue.body;
        default:
          return null;
      }
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') {
        return parent.issues.map((issue) =>
          field.selection === undefined
            ? null
            : executeSelection({ __typename: 'Issue', repo: parent.repo, issue }, 'Issue', field.selection, ctx),
        );
      }
      if (field.name === 'pageInfo') {
        return select({ __typename: 'PageInfo', ...parent.pageInfo }, 'PageInfo');
      }
      if (field.name === 'totalCount') return parent.issues.length;
      return null;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return parent.hasNextPage;
      if (field.name === 'endCursor') return parent.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      return null;
    }
    case 'PullRequest': {
      const { repo, pull } = parent;
      switch (field.name) {
        case 'id':
          return pullGlobalId(repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.head;
        case 'baseRefName':
          return pull.base;
        case 'mergeable':
          return pull.state === 'open' ? 'MERGEABLE' : 'UNKNOWN';
        case 'files': {
          const headTip = refTip(repo, branchRef(pull.head)) ?? pull.headSha;
          const baseTip = refTip(repo, branchRef(pull.base)) ?? pull.baseSha;
          const base = mergeBase(repo.objects, headTip, baseTip);
          const baseTree = base === undefined ? undefined : commitTree(repo.objects, base);
          const headTree = commitTree(repo.objects, headTip);
          const changes = headTree === undefined ? [] : diffTrees(repo.objects, baseTree, headTree);
          const first = typeof args.first === 'number' ? args.first : changes.length;
          const files = changes.slice(0, first).map((c) => ({ path: c.path }));
          return select({ __typename: 'PullRequestChangedFileConnection', files }, 'PullRequestChangedFileConnection');
        }
        default:
          return null;
      }
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') {
        return parent.pulls.map((pull) =>
          field.selection === undefined
            ? null
            : executeSelection({ __typename: 'PullRequest', repo: parent.repo, pull }, 'PullRequest', field.selection, ctx),
        );
      }
      if (field.name === 'pageInfo') {
        return select({ __typename: 'PageInfo', hasNextPage: false, endCursor: null }, 'PageInfo');
      }
      if (field.name === 'totalCount') return parent.pulls.length;
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') {
        return parent.files.map((file) =>
          field.selection === undefined
            ? null
            : executeSelection({ __typename: 'PullRequestChangedFile', path: file.path }, 'PullRequestChangedFile', field.selection, ctx),
        );
      }
      if (field.name === 'pageInfo') {
        return select({ __typename: 'PageInfo', hasNextPage: false, endCursor: null }, 'PageInfo');
      }
      return null;
    }
    case 'PullRequestChangedFile':
      return field.name === 'path' ? parent.path : null;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') {
        return select({ __typename: 'Issue', repo: parent.repo, issue: parent.issue }, 'Issue');
      }
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') {
        return select({ __typename: 'PullRequest', repo: parent.repo, pull: parent.pull }, 'PullRequest');
      }
      return null;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') {
        return select({ __typename: 'IssueCommentEdge', comment: parent.comment }, 'IssueCommentEdge');
      }
      return null;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') {
        return select({ __typename: 'IssueComment', comment: parent.comment }, 'IssueComment');
      }
      return null;
    }
    case 'IssueComment': {
      if (field.name === 'id') return commentGlobalId(parent.comment.id);
      if (field.name === 'body') return parent.comment.body;
      return null;
    }
    case '__Type': {
      if (field.name === 'name') return parent.typeName;
      if (field.name === 'kind') {
        return INTROSPECTION_ENUMS[parent.typeName] !== undefined ? 'ENUM' : 'OBJECT';
      }
      if (field.name === 'fields') {
        const fields = INTROSPECTION_FIELDS[parent.typeName];
        if (fields === undefined) return null;
        return fields.map((name) =>
          field.selection === undefined
            ? null
            : executeSelection({ __typename: '__Field', name }, '__Field', field.selection, ctx),
        );
      }
      if (field.name === 'enumValues') {
        const values = INTROSPECTION_ENUMS[parent.typeName];
        if (values === undefined) return null;
        return values.map((name) =>
          field.selection === undefined
            ? null
            : executeSelection({ __typename: '__EnumValue', name }, '__EnumValue', field.selection, ctx),
        );
      }
      return null;
    }
    case '__Field':
      return field.name === 'name' ? parent.name : null;
    case '__EnumValue':
      return field.name === 'name' ? parent.name : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- handler

interface GraphQLOperationRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeOne(request: GraphQLOperationRequest, store: ForgeStore): Record<string, unknown> {
  const query = request.query;
  if (typeof query !== 'string') {
    return { errors: [{ message: 'Request must include a query string.' }] };
  }
  const variables =
    request.variables !== null && typeof request.variables === 'object' && !Array.isArray(request.variables)
      ? (request.variables as Record<string, unknown>)
      : {};
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Syntax error in GraphQL document.' }] };
  }
  // Pick the named operation when operationName is given, else the first.
  let op = operations[0] as Operation;
  if (typeof request.operationName === 'string') {
    op = operations.find((o) => o.name === request.operationName) ?? op;
  }
  const validationErrors = validateOperation(op);
  if (validationErrors.length > 0) {
    return { errors: validationErrors.map((message) => ({ message })), data: null };
  }
  const ctx: Ctx = { store, variables };
  const data = executeSelection(null, op.kind === 'mutation' ? 'Mutation' : 'Query', op.selection, ctx);
  return { data };
}

/**
 * Handle POST /api/graphql. Returns true when the path matched (handled); false otherwise.
 * Batching: a JSON array body is answered with a JSON array of per-operation results, in order.
 */
export function handleGraphQL(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: Buffer,
  store: ForgeStore,
): boolean {
  if (req.url === undefined) return false;
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://entry').pathname;
  } catch {
    pathname = '/';
  }
  if (pathname !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendError(res, 404, 'Not Found');
    return true;
  }
  if (!isAuthenticated(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  const parsed = parseJsonBody(rawBody);
  if (!parsed.ok) {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  const value = parsed.value;
  if (Array.isArray(value)) {
    const results = value.map((entry) =>
      entry !== null && typeof entry === 'object' ? executeOne(entry as GraphQLOperationRequest, store) : { errors: [{ message: 'Invalid operation.' }] },
    );
    sendJson(res, 200, results);
    return true;
  }
  if (value !== null && typeof value === 'object') {
    sendJson(res, 200, executeOne(value as GraphQLOperationRequest, store));
    return true;
  }
  sendJson(res, 400, { errors: [{ message: 'Request body must be a JSON object or array.' }] });
  return true;
}
