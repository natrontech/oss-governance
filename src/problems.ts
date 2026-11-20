import type { Config, Problem, Repo } from "./config.ts";
import {
  type Action,
  APP_SLUG,
  assigneesOf,
  mentions,
  NAME,
  ORG,
  OWNERS_TEAM,
  octokit,
  orNull,
  teamSlug,
} from "./github.ts";

const LABEL = "governance";
const OWNERS = `${ORG}/${OWNERS_TEAM}`;

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

// Whoever created the repository as public or made it public, as far as its event feed of the last 30 days goes back
async function publisherOf(repo: string): Promise<string | undefined> {
  const events = await octokit.paginate(octokit.rest.activity.listRepoEvents, { owner: ORG, repo, per_page: 100 });
  const published = events.find(
    (event) =>
      event.type === "PublicEvent" ||
      (event.type === "CreateEvent" && (event.payload as { ref_type?: string }).ref_type === "repository"),
  );
  return published?.actor.login;
}

// Number of reminders an issue opened the given number of days ago should have received by now
export function remindersDue(days: number, first: number, every: number): number {
  return days < first ? 0 : 1 + Math.floor((days - first) / every);
}

// Keeps one open issue per problem, identified by its title, and closes issues whose problem is gone
export async function planProblems(problems: Problem[], config: Config): Promise<Action[]> {
  const target = { owner: ORG, repo: NAME };
  const open = await octokit.paginate(octokit.rest.issues.listForRepo, { ...target, labels: LABEL, state: "open" });
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  const actions: Action[] = [];
  for (const problem of problems) {
    const issue = open.find((candidate) => candidate.title === problem.title);

    // The person who made an unlisted repository public knows best whether it should be listed or ignored, every other problem goes to the owners
    if (!issue) {
      const publisher = problem.unlisted && (await publisherOf(problem.unlisted));
      actions.push({
        description: `open issue "${problem.title}" assigned to ${publisher || OWNERS}`,
        run: async () =>
          octokit.rest.issues.create({
            ...target,
            title: problem.title,
            body: problem.body,
            labels: [LABEL],
            assignees: publisher ? [publisher] : await assigneesOf([OWNERS]),
          }),
      });
      continue;
    }

    // An unlisted repository stays public without a governance decision, so its assignees and the owners are reminded until it is listed
    // Days are counted by calendar date, so a nightly run that starts a few minutes earlier than the one that opened the issue still counts a full day
    if (!problem.unlisted) {
      continue;
    }
    const days = (today - Date.parse(issue.created_at.slice(0, 10))) / 86_400_000;
    const due = remindersDue(days, config.unlistedFirstReminderDays, config.unlistedReminderDays);
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      ...target,
      issue_number: issue.number,
    });
    if (comments.filter((comment) => comment.user?.login === `${APP_SLUG}[bot]`).length >= due) {
      continue;
    }
    const audience = mentions([OWNERS, ...(issue.assignees ?? []).map((assignee) => assignee.login)]);
    actions.push({
      description: `remind ${audience} of issue #${issue.number}, open for ${days} days`,
      run: () =>
        octokit.rest.issues.createComment({
          ...target,
          issue_number: issue.number,
          body: `${audience} \`${problem.unlisted}\` is still public without a governance decision. ${problem.body}`,
        }),
    });
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
