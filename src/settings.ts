import type { Repo, Ruleset } from "./config.ts";
import { type Action, type LiveRepo, NAME, ORG, octokit, orNull, teamsOf } from "./github.ts";

// Paths that only the open source owners may change, in the pattern syntax of rulesets
const OWNER_FILE_PATTERNS = [".github/CODEOWNERS", "SECURITY.md", "LICENSE"];

// Built-in id of the repository admin role
const ADMIN_ROLE = 5;

// Rules that a signed fast-forward commit of the app always satisfies, every other rule could reject it
const HARMLESS_RULES = new Set([
  "creation",
  "deletion",
  "non_fast_forward",
  "required_linear_history",
  "required_signatures",
]);

function appBypass(appId: number) {
  return { actor_id: appId, actor_type: "Integration", bypass_mode: "always" } as const;
}

export function desiredRuleset(ruleset: Ruleset, ownersTeamId: number, appId: number) {
  return {
    name: NAME,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    bypass_actors: [{ actor_id: ADMIN_ROLE, actor_type: "RepositoryRole", bypass_mode: "always" }, appBypass(appId)],
    rules: [
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: ruleset.requiredApprovals,
          // GitHub recreates the commits of a rebase merge without a signature, so it is only offered when signing is not required
          allowed_merge_methods: ruleset.signedCommits ? ["merge", "squash"] : ["merge", "squash", "rebase"],
          require_code_owner_review: ruleset.codeOwnerReview,
          dismiss_stale_reviews_on_push: false,
          // Without required approvals this would still demand one, so it only applies on top of them
          require_last_push_approval: ruleset.requiredApprovals > 0,
          required_review_thread_resolution: false,
          required_reviewers: [
            {
              file_patterns: OWNER_FILE_PATTERNS,
              minimum_approvals: 1,
              reviewer: { id: ownersTeamId, type: "Team" },
            },
          ],
        },
      },
      { type: "deletion" },
      { type: "non_fast_forward" },
      ...(ruleset.signedCommits ? [{ type: "required_signatures" }] : []),
    ],
  };
}

// True when everything in desired is present in current
// GitHub returns more fields than we set, and lists come back in no guaranteed order
export function matches(current: unknown, desired: unknown): boolean {
  if (Array.isArray(desired)) {
    return (
      Array.isArray(current) &&
      current.length === desired.length &&
      desired.every((item) => current.some((candidate) => matches(candidate, item)))
    );
  }
  if (typeof desired === "object" && desired !== null) {
    return (
      typeof current === "object" &&
      current !== null &&
      Object.entries(desired).every(([key, value]) => matches((current as Record<string, unknown>)[key], value))
    );
  }
  return current === desired;
}

export async function planSettings(
  repo: Repo,
  live: LiveRepo,
  ownersTeamId: number,
  appId: number,
): Promise<{ actions: Action[]; notes: string[] }> {
  const actions: Action[] = [];
  const notes: string[] = [];
  const target = { owner: ORG, repo: repo.name };

  // A team in CODEOWNERS needs explicit write access, access through its members is not enough
  for (const team_slug of teamsOf(repo.maintainers)) {
    const access = await orNull(
      octokit.request("GET /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}", {
        org: ORG,
        team_slug,
        ...target,
        headers: { accept: "application/vnd.github.v3.repository+json" },
      }),
    );
    const permissions = (access?.data as { permissions?: { push: boolean } } | undefined)?.permissions;
    if (!permissions?.push) {
      actions.push({
        description: `grant team ${team_slug} write access`,
        run: () =>
          octokit.rest.teams.addOrUpdateRepoPermissionsInOrg({ org: ORG, team_slug, ...target, permission: "push" }),
      });
    }
  }

  // Only the ruleset carrying our name is managed, a repository may add its own rulesets on top
  const desired = desiredRuleset(repo.ruleset, ownersTeamId, appId);
  const rulesets = await octokit.paginate(octokit.rest.repos.getRepoRulesets, { ...target, includes_parents: false });
  const existing = rulesets.find((ruleset) => ruleset.name === NAME);
  if (!existing) {
    actions.push({
      description: "create ruleset",
      run: () => octokit.request("POST /repos/{owner}/{repo}/rulesets", { ...target, ...desired } as never),
    });
  } else {
    const { data: current } = await octokit.rest.repos.getRepoRuleset({ ...target, ruleset_id: existing.id });
    // GitHub hides the bypass actors from the read-only token of the pull request plan, so that plan compares the rest only
    const comparable = current.bypass_actors ? desired : { ...desired, bypass_actors: undefined };
    if (!matches(current, comparable)) {
      actions.push({
        description: "update ruleset",
        run: () =>
          octokit.request("PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
            ...target,
            ruleset_id: existing.id,
            ...desired,
          } as never),
      });
    }
  }

  // A ruleset the repository adds itself would reject the commits of the app unless the app may bypass it
  // Rulesets whose rules such a commit always satisfies are left untouched
  const branchRules = await octokit.paginate(octokit.rest.repos.getBranchRules, {
    ...target,
    branch: live.default_branch!,
  });
  const blocking = new Set(
    branchRules
      .filter((rule) => rule.ruleset_id !== existing?.id && !HARMLESS_RULES.has(rule.type))
      .map((rule) => rule.ruleset_id!),
  );
  for (const ruleset_id of blocking) {
    const { data: ruleset } = await octokit.rest.repos.getRepoRuleset({ ...target, ruleset_id });
    // Without the hidden bypass actors it is unknown whether the app may already bypass, and replacing them would drop the others
    const bypassActors = ruleset.bypass_actors;
    if (bypassActors && !bypassActors.some((actor) => actor.actor_type === "Integration" && actor.actor_id === appId)) {
      actions.push({
        description: `let the app bypass ruleset ${ruleset.name}`,
        run: () =>
          octokit.request("PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
            ...target,
            ruleset_id,
            bypass_actors: [...bypassActors, appBypass(appId)],
          } as never),
      });
    }
  }

  // Classic branch protection still applies next to the ruleset, but it is the legacy mechanism and better moved into a ruleset
  if (await orNull(octokit.rest.repos.getBranchProtection({ ...target, branch: live.default_branch! }))) {
    notes.push(`classic branch protection on ${live.default_branch}`);
  }

  // The security policy points reporters to private vulnerability reporting
  const { data: reporting } = await octokit.rest.repos.checkPrivateVulnerabilityReporting(target);
  if (!reporting.enabled) {
    actions.push({
      description: "enable private vulnerability reporting",
      run: () => octokit.rest.repos.enablePrivateVulnerabilityReporting(target),
    });
  }

  // Push protection only works with secret scanning, so both are set together
  const { data: details } = await octokit.rest.repos.get(target);
  const security = details.security_and_analysis;
  if (
    security?.secret_scanning?.status !== "enabled" ||
    security.secret_scanning_push_protection?.status !== "enabled"
  ) {
    actions.push({
      description: "enable secret scanning and push protection",
      run: () =>
        octokit.rest.repos.update({
          ...target,
          security_and_analysis: {
            secret_scanning: { status: "enabled" },
            secret_scanning_push_protection: { status: "enabled" },
          },
        }),
    });
  }

  // CodeQL default setup scans every pull request, which also counts as SAST for the OpenSSF Scorecard
  // It would reject the results of a CodeQL workflow, so a repository with its own keeps that, and one without supported languages has nothing to scan
  const { data: codeScanning } = await octokit.rest.codeScanning.getDefaultSetup(target);
  if (codeScanning.state !== "configured" && codeScanning.languages?.length) {
    const { repository } = await octokit.graphql<{
      repository: { object: { entries: { object: { text?: string } | null }[] } | null };
    }>(
      `query ($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { object(expression: "HEAD:.github/workflows") { ... on Tree { entries { object { ... on Blob { text } } } } } } }`,
      target,
    );
    const workflows = repository.object?.entries ?? [];
    if (!workflows.some((workflow) => workflow.object?.text?.includes("github/codeql-action/analyze"))) {
      actions.push({
        description: "enable CodeQL default setup",
        run: () => octokit.rest.codeScanning.updateDefaultSetup({ ...target, state: "configured" }),
      });
    }
  }

  // GitHub's own verdict on the CODEOWNERS file currently on the default branch
  const codeowners = await orNull(octokit.rest.repos.codeownersErrors(target));
  if (codeowners?.data.errors.length) {
    const errors = codeowners.data.errors.map((error) => `${error.kind} on line ${error.line}`);
    notes.push(`CODEOWNERS is invalid: ${errors.join(", ")}`);
  }

  return { actions, notes };
}
