import type { Config, Problem, Repo } from "./config.ts";
import { readFiles } from "./files.ts";
import {
  type Action,
  APP_SLUG,
  assigneesOf,
  type LiveRepo,
  mentions,
  NAME,
  ORG,
  OWNERS_TEAM,
  octokit,
  orNull,
  teamSlug,
} from "./github.ts";
import type { Item } from "./response.ts";

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

// Config files of Dependabot and Renovate, which the OpenSSF Scorecard checks for
const DEPENDENCY_CONFIGS = [
  ".github/dependabot.yml",
  ".github/dependabot.yaml",
  "renovate.json",
  "renovate.json5",
  ".github/renovate.json",
  ".github/renovate.json5",
  ".gitlab/renovate.json",
  ".gitlab/renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
  ".renovaterc.json5",
];

// The maintainers know the ecosystems of their repository, so they set up its dependency updates themselves
// A repository without workflows, such as a docs or release repository, usually has no dependencies to update
export async function dependencyProblems(repo: Repo): Promise<Problem[]> {
  const configs = await readFiles(repo.name, "HEAD", DEPENDENCY_CONFIGS);
  if (
    [...configs.values()].some((content) => content != null) ||
    !(await orNull(octokit.rest.repos.getContent({ owner: ORG, repo: repo.name, path: ".github/workflows" })))
  ) {
    return [];
  }
  return [
    {
      title: `${repo.name}: no Dependabot or Renovate config`,
      body: "Add a [Dependabot](https://docs.github.com/code-security/dependabot/working-with-dependabot/dependabot-options-reference) or Renovate config that covers the dependencies of the repository, including its GitHub Actions.",
      maintainers: repo.maintainers,
    },
  ];
}

// Why a repository should be archived, where the reasons of neglect shorten the window of inactivity and are only reported once it has passed
export function archiveReasons(config: Config, now: Date, activity: string, neglect: string[]): string[] {
  const months = neglect.length > 0 ? config.archiveNeglectedMonths : config.archiveInactiveMonths;
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  if (Date.parse(activity) >= cutoff.getTime()) {
    return [];
  }
  return [`no activity for more than ${months} months, the last was on ${activity.slice(0, 10)}`, ...neglect];
}

// Suggests archiving to the maintainers, who decide and archive by hand, or to the owners when a maintainer is gone
// Merged Dependabot and Renovate pull requests count as activity, the commits of the app do not, since it keeps committing to every repository
export async function archiveProblems(
  repo: Repo,
  live: LiveRepo,
  config: Config,
  invalid: Problem[],
  unanswered: Item[],
): Promise<Problem[]> {
  // The maintainers already decided to keep the repository until this date
  const now = new Date();
  if (repo.keepUntil && repo.keepUntil >= now.toISOString().slice(0, 10)) {
    return [];
  }

  // The last activity is the newest commit not made by the app, or the last release for a repository that only publishes releases
  const target = { owner: ORG, repo: repo.name };
  let commit: string | undefined;
  for await (const { data } of octokit.paginate.iterator(octokit.rest.repos.listCommits, {
    ...target,
    per_page: 100,
  })) {
    commit = data.find((candidate) => candidate.author?.login !== `${APP_SLUG}[bot]`)?.commit.committer?.date;
    if (commit) {
      break;
    }
  }
  const release = (await orNull(octokit.rest.repos.getLatestRelease(target)))?.data.published_at;
  const activity = [commit, release, live.created_at]
    .filter((date) => date != null)
    .sort()
    .at(-1)!;

  // A repository nobody can be reached for, or whose requests go unanswered, is neglected
  const neglect: string[] = [];
  if (repo.maintainers.length === 0 || invalid.length === repo.maintainers.length) {
    neglect.push(`no maintainer is a member or team of ${ORG}`);
  }
  const waitingSince = new Date(now.getTime() - config.archiveUnansweredDays * 86_400_000).toISOString().slice(0, 10);
  const waiting = unanswered.filter((item) => item.opened < waitingSince).length;
  if (waiting > 0) {
    neglect.push(
      `external requests waiting more than ${config.archiveUnansweredDays} days for a first response: ${waiting}`,
    );
  }

  // The issue lists the reasons and the context the maintainers need to decide
  const reasons = archiveReasons(config, now, activity, neglect);
  if (reasons.length === 0) {
    return [];
  }
  return [
    {
      title: `${repo.name}: archive candidate`,
      body: [
        `[${ORG}/${repo.name}](https://github.com/${ORG}/${repo.name}) could be archived:`,
        "",
        ...reasons.map((reason) => `- ${reason}`),
        "",
        `It has ${live.stargazers_count} stars and ${live.open_issues_count} open issues and pull requests.`,
        "Archive it on GitHub if it is no longer maintained, the bot then moves its file to `repos/archived/`.",
        `To keep it, resume work on it or set \`keepUntil\` in \`repos/${repo.name}.yaml\` to the date when the question should come back.`,
      ].join("\n"),
      maintainers: invalid.length > 0 ? [OWNERS] : repo.maintainers,
    },
  ];
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

    // The person who made an unlisted repository public knows best whether it should be listed or ignored, and a problem without maintainers goes to the owners
    if (!issue) {
      const publisher = problem.unlisted && (await publisherOf(problem.unlisted));
      const assigned = publisher ? [publisher] : (problem.maintainers ?? [OWNERS]);
      actions.push({
        description: `open issue "${problem.title}" assigned to ${assigned.join(", ")}`,
        run: async () =>
          octokit.rest.issues.create({
            ...target,
            title: problem.title,
            body: problem.body,
            labels: [LABEL],
            assignees: await assigneesOf(assigned),
          }),
      });
      continue;
    }

    // An unlisted repository stays public without a governance decision, so its assignees and the owners are reminded until it is listed
    // Days are counted by calendar date, so a scheduled run that starts a few minutes earlier than the one that opened the issue still counts a full day
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
