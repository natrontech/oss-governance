import { Octokit, RequestError } from "octokit";

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
