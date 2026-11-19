import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig, reconcile, repoFile } from "./config.ts";
import { planFiles } from "./files.ts";
import { type Action, APP_SLUG, type Change, createCommit, NAME, ORG, OWNERS_TEAM, octokit } from "./github.ts";
import { renderInventory } from "./inventory.ts";
import { maintainerProblems, planProblems } from "./problems.ts";
import { planResponse, RESPONSE_LABEL } from "./response.ts";
import { renderSchemas } from "./schema.ts";
import { planSettings } from "./settings.ts";

const mode = process.argv[2];
if (mode !== "plan" && mode !== "apply" && mode !== "generate") {
  console.error("usage: node src/cli.ts plan|apply|generate");
  process.exit(2);
}
const apply = mode === "apply";

// An invalid config is a mistake in a file, so it is reported without a stack trace
let loaded: ReturnType<typeof loadConfig>;
try {
  loaded = loadConfig();
} catch (error) {
  console.error(`Invalid config: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
const { config, repos, ignored } = loaded;

// The inventory and the editor schemas only depend on the config files, so they are generated without asking GitHub
if (mode === "generate") {
  writeFileSync("INVENTORY.md", renderInventory(repos, ignored));
  mkdirSync("schemas", { recursive: true });
  for (const [path, content] of renderSchemas(config)) {
    writeFileSync(path, content);
  }
  process.exit(0);
}

// Prints one section of the report and, when applying, carries out its actions in order
async function section(title: string, plan: () => Promise<{ actions: Action[]; notes?: string[] }>): Promise<void> {
  const lines: string[] = [];
  try {
    const { actions, notes = [] } = await plan();
    for (const action of actions) {
      if (apply) {
        await action.run();
      }
      lines.push(`- ${action.description}`);
    }
    lines.push(...notes.map((note) => `- note: ${note}`));
  } finally {
    // Actions that ran before a failure still belong in the report
    if (lines.length > 0) {
      console.log(`\n### ${title}\n\n${lines.join("\n")}`);
    }
  }
}

console.log(`## Governance ${apply ? "sync" : "plan"}`);

// Compare the listed repositories with the public repositories of the organization
const live = await octokit.paginate(octokit.rest.repos.listForOrg, { org: ORG, type: "public" });
const { problems, moves } = reconcile(repos, Object.keys(ignored), live);

// Follow manual archiving on GitHub by moving the repository's file in one commit together with the inventory
await section("Archive", async () => {
  if (moves.length === 0) {
    return { actions: [] };
  }
  const paths = moves.map(({ repo, archived }) => [repoFile(repo.name, repo.archived), repoFile(repo.name, archived)]);
  return {
    actions: [
      {
        description: `commit to main: ${paths.map(([from, to]) => `move ${from} to ${to}`).join(", ")}`,
        run: async () => {
          // A moved file keeps its content, so its blob is placed at the new path
          const changes: Change[] = [];
          for (const [from, to] of paths) {
            const { data } = await octokit.rest.repos.getContent({ owner: ORG, repo: NAME, path: from, ref: "main" });
            changes.push({ path: to, sha: (data as { sha: string }).sha }, { path: from, sha: null });
          }
          for (const { repo, archived } of moves) {
            repo.archived = archived;
          }
          changes.push({ path: "INVENTORY.md", content: renderInventory(repos, ignored) });

          // Without force the update fails if main moved meanwhile, and the next run tries again
          const sha = await createCommit(NAME, "main", changes, "chore: move archived repository files");
          await octokit.rest.git.updateRef({ owner: ORG, repo: NAME, ref: "heads/main", sha });
        },
      },
    ],
  };
});

// Ids the ruleset refers to and the tracking issues the response check updates
const { data: owners } = await octokit.rest.teams.getByName({ org: ORG, team_slug: OWNERS_TEAM });
const { data: app } = await octokit.rest.apps.getBySlug({ app_slug: APP_SLUG });
const trackers = await octokit.paginate(octokit.rest.issues.listForRepo, {
  owner: ORG,
  repo: NAME,
  labels: RESPONSE_LABEL,
  state: "open",
});

// Sync every active repository on its own
for (const repo of repos) {
  const liveRepo = live.find((candidate) => candidate.name === repo.name);
  if (!liveRepo || liveRepo.archived) {
    continue;
  }
  try {
    await section(repo.name, async () => {
      // A repository without valid maintainers cannot get a valid CODEOWNERS file, so it waits for its issue to be solved
      const invalid = await maintainerProblems(repo);
      if (invalid.length > 0) {
        problems.push(...invalid);
        return { actions: [], notes: ["skipped until its maintainers are fixed"] };
      }
      const settings = await planSettings(repo, liveRepo, owners.id, app!.id);
      return {
        actions: [
          ...settings.actions,
          ...(await planFiles(repo, liveRepo, config.syncPrReminderDays)),
          ...(await planResponse(repo, config.responseWarningDays, trackers)),
        ],
        notes: settings.notes,
      };
    });
  } catch (error) {
    // One broken repository must not keep the others from being synced, so it becomes a problem of its own
    const message = error instanceof Error ? error.message : String(error);
    problems.push({ title: `${repo.name}: sync failed`, body: message });
    console.log(`\n### ${repo.name} failed\n\n${message}`);
  }
}

// Problems fail a plan so they are fixed before merging, a sync turns them into issues
if (problems.length > 0) {
  console.log(`\n### Problems\n\n${problems.map((problem) => `- ${problem.title}`).join("\n")}`);
}
if (apply) {
  await section("Issues", async () => ({ actions: await planProblems(problems) }));
} else if (problems.length > 0) {
  process.exit(1);
}
