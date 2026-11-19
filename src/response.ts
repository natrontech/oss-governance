import type { Config, Repo } from "./config.ts";
import { type Action, assigneesOf, mentions, NAME, ORG, octokit } from "./github.ts";

export const RESPONSE_LABEL = "response-time";

type Status = "due" | "overdue";
type Item = { number: number; title: string; url: string; opened: string; status: Status };
type Tracker = {
  number: number;
  title: string;
  created_at: string;
  body?: string | null;
  assignees?: { login: string }[] | null;
};

// Associations GitHub assigns to people who answer on behalf of the organization
const INTERNAL = new Set<string | undefined>(["OWNER", "MEMBER", "COLLABORATOR"]);

// Whether a request opened at the given time needs attention, counting Monday to Friday without public holidays
export function responseStatus(opened: Date, now: Date, responseDays: number, warningDays: number): Status | undefined {
  let elapsed = 0;
  const day = new Date(Date.UTC(opened.getUTCFullYear(), opened.getUTCMonth(), opened.getUTCDate() + 1));
  for (; day <= now; day.setUTCDate(day.getUTCDate() + 1)) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
      elapsed++;
    }
  }
  const remaining = responseDays - elapsed;
  if (remaining < 0) {
    return "overdue";
  }
  return remaining <= warningDays ? "due" : undefined;
}

// External requests that are close to or past the deadline and have no reply from a member yet
async function unansweredItems(repo: Repo, responseDays: number, warningDays: number): Promise<Item[]> {
  const target = { owner: ORG, repo: repo.name };
  const items: Item[] = [];
  const now = new Date();
  const open = await octokit.paginate(octokit.rest.issues.listForRepo, { ...target, state: "open" });
  for (const request of open) {
    // Only requests from people outside the organization count, bots are not people
    if (INTERNAL.has(request.author_association) || request.user?.type === "Bot") {
      continue;
    }
    const status = responseStatus(new Date(request.created_at), now, responseDays, warningDays);
    if (!status) {
      continue;
    }

    // A comment or a review by a member counts as the first response, a bot reply does not
    const replies = [
      ...(request.comments > 0
        ? await octokit.paginate(octokit.rest.issues.listComments, { ...target, issue_number: request.number })
        : []),
      ...(request.pull_request
        ? await octokit.paginate(octokit.rest.pulls.listReviews, { ...target, pull_number: request.number })
        : []),
    ];
    if (replies.some((reply) => INTERNAL.has(reply.author_association) && reply.user?.type !== "Bot")) {
      continue;
    }
    items.push({
      number: request.number,
      title: request.title,
      url: request.html_url,
      opened: request.created_at.slice(0, 10),
      status,
    });
  }
  return items;
}

// Whether overdue requests need another reminder, counted in calendar days since the last one
export function reminderDue(lastReminder: string, today: string, reminderDays: number): boolean {
  return (Date.parse(today) - Date.parse(lastReminder)) / 86_400_000 >= reminderDays;
}

// Keeps one tracking issue per repository and mentions the maintainers when a request changes its status, and again while requests stay overdue
export async function planResponse(repo: Repo, config: Config, trackers: Tracker[]): Promise<Action[]> {
  const target = { owner: ORG, repo: NAME };
  const title = `${repo.name}: external requests awaiting first response`;
  const tracker = trackers.find((issue) => issue.title === title);
  const items =
    repo.responseDays === null ? [] : await unansweredItems(repo, repo.responseDays, config.responseWarningDays);

  if (items.length === 0) {
    if (!tracker) {
      return [];
    }
    return [
      {
        description: `close response tracker #${tracker.number}`,
        run: () => octokit.rest.issues.update({ ...target, issue_number: tracker.number, state: "closed" }),
      },
    ];
  }

  // The last notified status of each request and the date of the last reminder live in the issue body, so no state is kept outside GitHub
  // A tracker without a reminder date counts its opening as the last reminder
  const notified: Record<string, Status> = JSON.parse(tracker?.body?.match(/<!-- state: (.*) -->/)?.[1] ?? "{}");
  const today = new Date().toISOString().slice(0, 10);
  const lastReminder =
    tracker?.body?.match(/<!-- reminded: (\S+) -->/)?.[1] ?? tracker?.created_at.slice(0, 10) ?? today;

  // Requests with a new status are notified at once, and all overdue requests again once the reminder interval has passed
  const news = tracker ? items.filter((item) => notified[item.number] !== item.status) : [];
  const overdue = items.filter((item) => item.status === "overdue");
  const remind = overdue.length > 0 && reminderDue(lastReminder, today, config.overdueReminderDays);
  const notify = remind ? [...new Set([...news, ...overdue])] : news;

  const state = Object.fromEntries(items.map((item) => [item.number, item.status]));
  const body = [
    `External issues and pull requests in [${ORG}/${repo.name}](https://github.com/${ORG}/${repo.name}) without a first response from a member.`,
    `The repository is ${repo.tier} and aims for a first response within ${repo.responseDays} working days.`,
    "",
    `Maintainers: ${mentions(repo.maintainers)}`,
    "",
    "| Request | Opened | Status |",
    "| --- | --- | --- |",
    ...items.map(
      (item) =>
        `| [#${item.number} ${item.title.replaceAll("|", "\\|")}](${item.url}) | ${item.opened} | ${item.status} |`,
    ),
    "",
    `<!-- state: ${JSON.stringify(state)} -->`,
    `<!-- reminded: ${!tracker || notify.length > 0 ? today : lastReminder} -->`,
  ].join("\n");

  // The maintainers are assigned, and following them keeps the assignees current when the maintainers change
  const assignees = await assigneesOf(repo.maintainers);
  if (!tracker) {
    return [
      {
        description: `open response tracker, requests waiting: ${items.length}`,
        run: () => octokit.rest.issues.create({ ...target, title, body, labels: [RESPONSE_LABEL], assignees }),
      },
    ];
  }
  const assigned = (tracker.assignees ?? []).map((assignee) => assignee.login).sort();
  if (tracker.body === body && assigned.join() === assignees.join()) {
    return [];
  }

  // Editing an issue body notifies nobody, so the requests to notify get a comment
  return [
    {
      description: `update response tracker #${tracker.number}, requests to notify: ${notify.length}`,
      run: async () => {
        await octokit.rest.issues.update({ ...target, issue_number: tracker.number, body, assignees });
        if (notify.length > 0) {
          await octokit.rest.issues.createComment({
            ...target,
            issue_number: tracker.number,
            body: [
              `${mentions(repo.maintainers)} these requests need a first response:`,
              ...notify.map((item) => `- [#${item.number}](${item.url}) is ${item.status}`),
            ].join("\n"),
          });
        }
      },
    },
  ];
}
