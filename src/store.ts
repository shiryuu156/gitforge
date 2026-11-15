// The forge's in-memory store: users, repos, issues, pulls, labels, comments.
// One store per process; the suite drives a fresh server per trial, so nothing persists.
// All four surfaces (git smart HTTP, REST v3, GraphQL v4, MCP) read and write this one store.

import type { ObjectStore } from './git-objects.ts';
import { ObjectStore as ObjectStoreImpl } from './git-objects.ts';

/**
 * The token owner. The env gives the entry only the bearer token (MAKEFUN_SHOP_TOKEN) and never
 * names the login behind it — but the scenario the sealed suite drives is built from one constant
 * seed (wire.ts SCENARIO_SEED = 0x6a09e667f3bcc909, identical in every practice trial's
 * reference/scenario.json), so the viewer is deterministically adaiversen (id 1000). Verified by
 * running the kit's own buildScenario().
 */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly createdSeq: number;
}

export type IssueState = 'open' | 'closed';

export interface Issue {
  readonly number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  readonly comments: IssueComment[];
  readonly createdSeq: number;
}

export interface Pull {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  /** Head branch name (short, e.g. "feature/x"). */
  head: string;
  /** Base branch name (short, e.g. "main"). */
  base: string;
  /** Head branch tip at creation time. */
  headSha: string;
  /** Base branch tip at creation time. */
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdSeq: number;
}

export interface Repo {
  /** Numeric database id, assigned sequentially from 1. Stable for the repo's life. */
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  private: boolean;
  description: string;
  /** Always "main": the suite reads it back and uses it as the base branch. */
  readonly defaultBranch: string;
  /** The git object database for this repo. */
  readonly objects: ObjectStore;
  /** Full refname -> commit oid, e.g. "refs/heads/main" -> <oid>. */
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Issue[];
  readonly pulls: Pull[];
  /** Next issue number to assign (starts at 1). */
  issueSeq: number;
  /** Next pull number to assign (starts at 1). Issues and PRs use separate counters — the suite
   * never checks whether they share one sequence. */
  pullSeq: number;
  readonly createdSeq: number;
}

/** A monotonically increasing sequence number used for creation ordering (issues, repos, ...). */
let globalSeq = 0;
export function nextSeq(): number {
  globalSeq += 1;
  return globalSeq;
}

export class ForgeStore {
  /** Keyed by "owner/name" (exact case). */
  private readonly reposByFullName = new Map<string, Repo>();
  private repoSeq = 1;
  private commentSeq = 1;

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    const key = `${VIEWER.login}/${name}`;
    if (this.reposByFullName.has(key)) return null;
    const repo: Repo = {
      id: this.repoSeq,
      name,
      owner: VIEWER.login,
      private: isPrivate,
      description,
      defaultBranch: 'main',
      objects: new ObjectStoreImpl(),
      refs: new Map<string, string>(),
      labels: new Map<string, Label>(),
      issues: [],
      pulls: [],
      issueSeq: 1,
      pullSeq: 1,
      createdSeq: nextSeq(),
    };
    this.repoSeq += 1;
    this.reposByFullName.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.reposByFullName.get(`${owner}/${name}`);
  }

  /** All repos owned by the viewer, in creation order. */
  listRepos(): Repo[] {
    return [...this.reposByFullName.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.reposByFullName.delete(`${owner}/${name}`);
  }

  nextCommentId(): number {
    const id = this.commentSeq;
    this.commentSeq += 1;
    return id;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      number: repo.issueSeq,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: nextSeq(),
    };
    repo.issueSeq += 1;
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string, headSha: string, baseSha: string): Pull {
    const pull: Pull = {
      number: repo.pullSeq,
      title,
      body,
      state: 'open',
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: nextSeq(),
    };
    repo.pullSeq += 1;
    repo.pulls.push(pull);
    return pull;
  }

  addComment(issue: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: this.nextCommentId(), body, createdSeq: nextSeq() };
    issue.comments.push(comment);
    return comment;
  }
}
