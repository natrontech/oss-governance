import type { Repo } from "./config.ts";
import { type Action, mentions, NAME, ORG, octokit } from "./github.ts";

export const RESPONSE_LABEL = "response-time";

type Status = "due" | "overdue";
type Item = { number: number; title: string; url: string; opened: string; status: Status };
type Tracker = { number: number; title: string; body?: string | null };

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

// Keeps one tracking issue per repository and mentions the maintainers whenever a request changes its status
export async function planResponse(repo: Repo, warningDays: number, trackers: Tracker[]): Promise<Action[]> {
  const target = { owner: ORG, repo: NAME };
  const title = `${repo.name}: external requests awaiting first response`;
  const tracker = trackers.find((issue) => issue.title === title);
  const items = repo.responseDays === null ? [] : await unansweredItems(repo, repo.responseDays, warningDays);

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

  // The last notified status of each request lives in the issue body, so no state is kept outside GitHub
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
  ].join("\n");

  if (!tracker) {
    return [
      {
        description: `open response tracker, requests waiting: ${items.length}`,
        run: () => octokit.rest.issues.create({ ...target, title, body, labels: [RESPONSE_LABEL] }),
      },
    ];
  }
  if (tracker.body === body) {
    return [];
  }

  // Editing an issue body notifies nobody, so requests with a new status get a comment
  const notified: Record<string, Status> = JSON.parse(tracker.body?.match(/<!-- state: (.*) -->/)?.[1] ?? "{}");
  const news = items.filter((item) => notified[item.number] !== item.status);
  return [
    {
      description: `update response tracker #${tracker.number}, requests to notify: ${news.length}`,
      run: async () => {
        await octokit.rest.issues.update({ ...target, issue_number: tracker.number, body });
        if (news.length > 0) {
          await octokit.rest.issues.createComment({
            ...target,
            issue_number: tracker.number,
            body: [
              `${mentions(repo.maintainers)} these requests need a first response:`,
              ...news.map((item) => `- [#${item.number}](${item.url}) is ${item.status}`),
            ].join("\n"),
          });
        }
      },
    },
  ];
}
