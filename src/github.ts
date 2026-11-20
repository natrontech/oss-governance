import { RequestError } from "@octokit/request-error";
import { Octokit } from "@octokit/rest";

export const ORG = "natrontech";
export const OWNERS_TEAM = "open-source-owners";
export const APP_SLUG = "natron-oss-governance";

// Name of this repository and of the ruleset it manages
export const NAME = "oss-governance";

// Octokit logs every failed request, including the expected 404s, while real failures are thrown and reported by the sync
export const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
  log: { debug: () => {}, info: () => {}, warn: console.warn, error: () => {} },
});

export type LiveRepo = Awaited<ReturnType<typeof octokit.rest.repos.listForOrg>>["data"][number];

// A single difference between the config and GitHub, with the call that removes it and optional Markdown shown below it
export type Action = { description: string; details?: string; run: () => Promise<unknown> };

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

// Teams that need write access to a repository
export function teamsOf(maintainers: string[]): string[] {
  return [...new Set([OWNERS_TEAM, ...maintainers.flatMap((maintainer) => teamSlug(maintainer) ?? [])])];
}

// The same teams maintain many repositories, so each team's members are fetched once
const teamMembers = new Map<string, Promise<string[]>>();

// Issues can only be assigned to users, so a team stands for its members, and GitHub accepts at most ten assignees
export async function assigneesOf(maintainers: string[]): Promise<string[]> {
  const logins = await Promise.all(
    maintainers.map((maintainer) => {
      const team_slug = teamSlug(maintainer);
      if (!team_slug) {
        return [maintainer];
      }
      let members = teamMembers.get(team_slug);
      if (!members) {
        members = octokit
          .paginate(octokit.rest.teams.listMembersInOrg, { org: ORG, team_slug })
          .then((users) => users.map((user) => user.login));
        teamMembers.set(team_slug, members);
      }
      return members;
    }),
  );
  return [...new Set(logins.flat())].sort().slice(0, 10);
}

export function mentions(maintainers: string[]): string {
  return maintainers.map((maintainer) => `@${maintainer}`).join(" ");
}
