/**
 * INT-02 (#50) — GitHub effects for the CI / PR bot.
 *
 * A small seam over the GitHub REST API: list a PR's changed files, upsert the summary comment
 * (idempotent — one comment per PR, updated on re-runs), and optionally open a follow-up PR carrying
 * the generated tests. The orchestrator ({@link ./run.ts}) depends only on the {@link GitHubClient}
 * interface, so it is unit-tested against a mock with NO network. The default implementation uses the
 * built-in `fetch` (Node 20+) — no Octokit/`@actions` dependency added to the package.
 */
import type { CiContext } from "./inputs.js";

/** A file changed in the PR (subset of the REST "list pull request files" item). */
export interface ChangedFile {
  filename: string;
  status: string;
}

/** A repo-relative file to commit in the follow-up PR (POSIX path). */
export interface CommitFile {
  path: string;
  content: string;
}

export interface FollowupPrParams {
  /** New branch name to push the generated tests onto. */
  branch: string;
  /** Branch the new branch is cut from and the PR targets (the PR's own head branch). */
  baseBranch: string;
  commitMessage: string;
  title: string;
  body: string;
  files: CommitFile[];
}

/** The GitHub effects the CI bot needs — implemented for real by {@link RestGitHubClient}, mocked in tests. */
export interface GitHubClient {
  listChangedFiles(prNumber: number): Promise<ChangedFile[]>;
  upsertComment(prNumber: number, body: string): Promise<{ action: "created" | "updated"; id: number }>;
  openFollowupPr(params: FollowupPrParams): Promise<{ url: string; number: number }>;
}

/** Hidden marker stamped into the bot's comment so a re-run UPDATES it instead of posting a duplicate. */
export const COMMENT_MARKER = "<!-- cairn-ci:summary -->";

/** An existing issue comment (subset) used to find the bot's prior comment. */
export interface ExistingComment {
  id: number;
  body?: string;
}

/**
 * Pure decision for comment idempotency: reuse the first comment carrying {@link COMMENT_MARKER}
 * (update it), otherwise create a new one. Kept side-effect-free so it is unit-testable directly.
 */
export function selectCommentAction(
  existing: ExistingComment[],
  marker: string = COMMENT_MARKER,
): { action: "created" } | { action: "updated"; id: number } {
  const mine = existing.find((c) => c.body?.includes(marker));
  return mine ? { action: "updated", id: mine.id } : { action: "created" };
}

/** Stamp the marker onto a comment body so future runs can find and update it. */
export function withMarker(body: string, marker: string = COMMENT_MARKER): string {
  return `${marker}\n${body}`;
}

/** Default REST-backed client. Constructed only on the live path; tests inject a mock instead. */
export class RestGitHubClient implements GitHubClient {
  constructor(
    private readonly ctx: CiContext,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!ctx.token) throw new Error("A GitHub token is required for REST calls (set the `github-token` input).");
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.ctx.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.ctx.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${res.statusText} ${text}`.trim());
    }
    return (await res.json()) as T;
  }

  private get base(): string {
    return `/repos/${this.ctx.owner}/${this.ctx.repo}`;
  }

  async listChangedFiles(prNumber: number): Promise<ChangedFile[]> {
    const files: ChangedFile[] = [];
    // Paginate (100/page) so large PRs are fully covered — no silent truncation of the surface set.
    for (let page = 1; ; page++) {
      const batch = await this.api<ChangedFile[]>(
        "GET",
        `${this.base}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      );
      files.push(...batch);
      if (batch.length < 100) break;
    }
    return files;
  }

  async upsertComment(prNumber: number, body: string): Promise<{ action: "created" | "updated"; id: number }> {
    const existing = await this.api<ExistingComment[]>(
      "GET",
      `${this.base}/issues/${prNumber}/comments?per_page=100`,
    );
    const decision = selectCommentAction(existing);
    const payload = { body: withMarker(body) };
    if (decision.action === "updated") {
      const r = await this.api<{ id: number }>("PATCH", `${this.base}/issues/comments/${decision.id}`, payload);
      return { action: "updated", id: r.id };
    }
    const r = await this.api<{ id: number }>("POST", `${this.base}/issues/${prNumber}/comments`, payload);
    return { action: "created", id: r.id };
  }

  /**
   * Open a follow-up PR via the Git Data API: blobs → tree (on top of the base branch's tree) →
   * commit → branch ref → pull request. Non-destructive: it only adds a branch and PR.
   */
  async openFollowupPr(p: FollowupPrParams): Promise<{ url: string; number: number }> {
    // 1. Resolve the base branch tip + its tree.
    const ref = await this.api<{ object: { sha: string } }>(
      "GET",
      `${this.base}/git/ref/heads/${encodeURIComponent(p.baseBranch)}`,
    );
    const baseSha = ref.object.sha;
    const baseCommit = await this.api<{ tree: { sha: string } }>("GET", `${this.base}/git/commits/${baseSha}`);

    // 2. Blob per file → a new tree based on the base tree.
    const tree = await Promise.all(
      p.files.map(async (f) => {
        const blob = await this.api<{ sha: string }>("POST", `${this.base}/git/blobs`, {
          content: f.content,
          encoding: "utf-8",
        });
        return { path: f.path, mode: "100644", type: "blob", sha: blob.sha };
      }),
    );
    const newTree = await this.api<{ sha: string }>("POST", `${this.base}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree,
    });

    // 3. Commit → new branch ref → PR.
    const commit = await this.api<{ sha: string }>("POST", `${this.base}/git/commits`, {
      message: p.commitMessage,
      tree: newTree.sha,
      parents: [baseSha],
    });
    await this.api("POST", `${this.base}/git/refs`, { ref: `refs/heads/${p.branch}`, sha: commit.sha });
    const pr = await this.api<{ html_url: string; number: number }>("POST", `${this.base}/pulls`, {
      title: p.title,
      body: p.body,
      head: p.branch,
      base: p.baseBranch,
    });
    return { url: pr.html_url, number: pr.number };
  }
}
