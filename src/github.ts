import { RequestError } from "@octokit/request-error";
import { Octokit } from "@octokit/rest";

export const ORG = "natrontech";
export const OWNERS_TEAM = "open-source-owners";
export const APP_SLUG = "natron-oss-governance";

// Name of this repository, of the ruleset it manages and prefix of the sync branch
export const NAME = "oss-governance";

export const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

export type LiveRepo = Awaited<ReturnType<typeof octokit.rest.repos.listForOrg>>["data"][number];

// A single difference between the config and GitHub, with the call that removes it
export type Action = { description: string; run: () => Promise<unknown> };

// GitHub answers 404 for many lookups where absence is an expected state
export async function orNull<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

// A file to write, or an existing blob to place at a path, where a null sha deletes the path
export type Change = { path: string; content: string } | { path: string; sha: string | null };

// Creates a commit on top of a branch through the API, which makes GitHub sign it and attribute it to the app
// The branch itself is not moved, so callers decide how its ref is updated
export async function createCommit(repo: string, branch: string, changes: Change[], message: string): Promise<string> {
  const target = { owner: ORG, repo };
  const { data: head } = await octokit.rest.repos.getBranch({ ...target, branch });
  const { data: tree } = await octokit.rest.git.createTree({
    ...target,
    base_tree: head.commit.commit.tree.sha,
    tree: changes.map((change) => ({ mode: "100644" as const, type: "blob" as const, ...change })),
  });
  const { data: commit } = await octokit.rest.git.createCommit({
    ...target,
    message,
    tree: tree.sha,
    parents: [head.commit.sha],
  });
  return commit.sha;
}

// Maintainers are user logins or teams written as org/slug
export function teamSlug(maintainer: string): string | undefined {
  return maintainer.split("/")[1];
}

// Teams that need write access to a repository and a review request on its sync pull requests
export function teamsOf(maintainers: string[]): string[] {
  return [...new Set([OWNERS_TEAM, ...maintainers.flatMap((maintainer) => teamSlug(maintainer) ?? [])])];
}

export function mentions(maintainers: string[]): string {
  return maintainers.map((maintainer) => `@${maintainer}`).join(" ");
}
