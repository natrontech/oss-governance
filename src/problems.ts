import type { Problem, Repo } from "./config.ts";
import { type Action, assigneesOf, NAME, ORG, OWNERS_TEAM, octokit, orNull, teamSlug } from "./github.ts";

const LABEL = "governance";

// The same people maintain many repositories, so each one is looked up once
const lookups = new Map<string, Promise<boolean>>();

function exists(maintainer: string): Promise<boolean> {
  let lookup = lookups.get(maintainer);
  if (!lookup) {
    const team_slug = teamSlug(maintainer);
    const request: Promise<unknown> = team_slug
      ? octokit.rest.teams.getByName({ org: ORG, team_slug })
      : octokit.rest.orgs.checkMembershipForUser({ org: ORG, username: maintainer });
    lookup = orNull(request).then((response) => response !== null);
    lookups.set(maintainer, lookup);
  }
  return lookup;
}

// A repository without a reachable maintainer is the first sunset criterion of the concept
export async function maintainerProblems(repo: Repo): Promise<Problem[]> {
  if (repo.maintainers.length === 0) {
    return [
      { title: `${repo.name}: no maintainer`, body: `Name at least one maintainer in \`repos/${repo.name}.yaml\`.` },
    ];
  }
  const problems: Problem[] = [];
  for (const maintainer of repo.maintainers) {
    const foreignTeam = maintainer.includes("/") && !maintainer.startsWith(`${ORG}/`);
    if (foreignTeam || !(await exists(maintainer))) {
      problems.push({
        title: `${repo.name}: maintainer ${maintainer} is not a member or team of ${ORG}`,
        body: `Replace or remove the maintainer in \`repos/${repo.name}.yaml\`.`,
      });
    }
  }
  return problems;
}

// Keeps one open issue per problem, identified by its title, and closes issues whose problem is gone
export async function planProblems(problems: Problem[]): Promise<Action[]> {
  const target = { owner: ORG, repo: NAME };
  const open = await octokit.paginate(octokit.rest.issues.listForRepo, { ...target, labels: LABEL, state: "open" });
  const actions: Action[] = [];
  for (const problem of problems) {
    if (!open.some((issue) => issue.title === problem.title)) {
      actions.push({
        description: `open issue "${problem.title}"`,
        run: async () =>
          octokit.rest.issues.create({
            ...target,
            title: problem.title,
            body: `${problem.body}\n\n@${ORG}/${OWNERS_TEAM}`,
            labels: [LABEL],
            assignees: await assigneesOf([`${ORG}/${OWNERS_TEAM}`]),
          }),
      });
    }
  }
  for (const issue of open) {
    if (!problems.some((problem) => problem.title === issue.title)) {
      actions.push({
        description: `close resolved issue #${issue.number} "${issue.title}"`,
        run: () => octokit.rest.issues.update({ ...target, issue_number: issue.number, state: "closed" }),
      });
    }
  }
  return actions;
}
