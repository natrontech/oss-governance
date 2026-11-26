import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const rulesetSchema = z.strictObject({
  requiredApprovals: z.number().int().min(0).max(10).describe("Approvals a pull request needs before it can be merged"),
  signedCommits: z.boolean().describe("Require verified signatures on every commit of the default branch"),
  codeOwnerReview: z.boolean().describe("Require an approval from a code owner of the changed files"),
});

const licenseSchema = z.string().describe("SPDX identifier of the license, such as Apache-2.0");

const responseDaysSchema = z
  .number()
  .int()
  .positive()
  .nullable()
  .describe("Working days until a qualified first response to external issues and pull requests, null for best effort");

export const configSchema = z.strictObject({
  ruleset: rulesetSchema,
  overdueReminderDays: z
    .number()
    .int()
    .positive()
    .describe("Days between reminders to the maintainers while requests stay past their response deadline"),
  unlistedFirstReminderDays: z
    .number()
    .int()
    .positive()
    .describe("Days after which the issue of an unlisted public repository gets its first reminder"),
  unlistedReminderDays: z
    .number()
    .int()
    .positive()
    .describe("Days between further reminders while a public repository stays unlisted"),
  responseWarningDays: z
    .number()
    .int()
    .min(0)
    .describe("Working days before the response deadline at which maintainers are notified"),
  archiveInactiveMonths: z
    .number()
    .int()
    .positive()
    .describe("Months without activity after which a repository is suggested for archiving"),
  archiveNeglectedMonths: z
    .number()
    .int()
    .positive()
    .describe(
      "Months without activity after which a repository without a reachable maintainer or with long unanswered requests is suggested for archiving",
    ),
  archiveUnansweredDays: z
    .number()
    .int()
    .positive()
    .describe("Days an external request waits for a first response before its repository counts as neglected"),
  tiers: z.record(z.string(), z.strictObject({ license: licenseSchema, responseDays: responseDaysSchema })),
});

export const repoSchema = z.strictObject({
  tier: z.string(),
  maintainers: z
    .array(z.string())
    .describe("GitHub users who are members of natrontech, or teams written as natrontech/<slug>"),
  license: licenseSchema.optional(),
  responseDays: responseDaysSchema.optional(),
  ruleset: rulesetSchema.partial().optional().describe("Overrides of the org-wide ruleset in config.yaml"),
  syncSecurityPolicy: z
    .boolean()
    .optional()
    .describe("Set to false to keep the repository's own SECURITY.md instead of the one from templates/SECURITY.md"),
  keepUntil: z.iso
    .date()
    .optional()
    .describe(
      "Date until which the repository is not suggested for archiving, such as for a finished tool that is still in use",
    ),
});

export const ignoredSchema = z.record(z.string(), z.string().min(1).describe("Why the repository is not managed"));

export type Config = z.infer<typeof configSchema>;
export type Ruleset = z.infer<typeof rulesetSchema>;

export type Repo = {
  name: string;
  archived: boolean;
  tier: string;
  maintainers: string[];
  license: string;
  responseDays: number | null;
  ruleset: Ruleset;
  syncSecurityPolicy: boolean;
  keepUntil?: string;
};

// Applies the tier and the org-wide ruleset below the values a repository sets itself
export function resolveRepo(config: Config, name: string, archived: boolean, raw: z.infer<typeof repoSchema>): Repo {
  const tier = config.tiers[raw.tier];
  if (!tier) {
    throw new Error(`${repoFile(name, archived)}: unknown tier ${raw.tier}`);
  }
  return {
    name,
    archived,
    tier: raw.tier,
    maintainers: raw.maintainers,
    license: raw.license ?? tier.license,
    responseDays: raw.responseDays === undefined ? tier.responseDays : raw.responseDays,
    ruleset: { ...config.ruleset, ...raw.ruleset },
    syncSecurityPolicy: raw.syncSecurityPolicy ?? true,
    keepUntil: raw.keepUntil,
  };
}

function readYaml<T>(schema: z.ZodType<T>, path: string): T {
  // A syntax error names a line but not the file, so the path is added here
  let content: unknown;
  try {
    content = parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : error}`);
  }
  const result = schema.safeParse(content);
  if (!result.success) {
    throw new Error(`${path}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function repoFile(name: string, archived: boolean): string {
  return join("repos", archived ? "archived" : "", `${name}.yaml`);
}

export function loadConfig(): { config: Config; repos: Repo[]; ignored: Record<string, string> } {
  const config = readYaml(configSchema, "config.yaml");
  const ignored = readYaml(ignoredSchema, "ignored.yaml");

  // Read the active and the archived folder with the same schema
  const repos: Repo[] = [];
  for (const archived of [false, true]) {
    const dir = join("repos", archived ? "archived" : "");
    if (!existsSync(dir)) {
      continue;
    }
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".yaml")) {
        continue;
      }
      const name = file.slice(0, -".yaml".length);
      repos.push(resolveRepo(config, name, archived, readYaml(repoSchema, join(dir, file))));
    }
  }

  // A repository listed twice would be synced with whichever entry happens to be read last
  const names = [...repos.map((repo) => repo.name), ...Object.keys(ignored)];
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) {
    throw new Error(`${duplicate} is listed more than once`);
  }

  return { config, repos, ignored };
}

// unlisted names the public repository of a problem about a repository without a file or an ignore entry
// maintainers are assigned to a problem they fix in their repository, which unlike a problem of the config here does not fail a plan
export type Problem = { title: string; body: string; unlisted?: string; maintainers?: string[] };

type LiveRepo = { name: string; archived?: boolean };

// Compares the listed repositories with the public repositories that exist on GitHub
export function reconcile(
  repos: Repo[],
  ignored: string[],
  live: LiveRepo[],
): { problems: Problem[]; moves: { repo: Repo; archived: boolean }[] } {
  const problems: Problem[] = [];
  const moves: { repo: Repo; archived: boolean }[] = [];
  const liveByName = new Map(live.map((repo) => [repo.name, repo]));
  const listed = new Set([...repos.map((repo) => repo.name), ...ignored]);

  // Nothing may be public without a governance decision
  for (const repo of live) {
    if (!listed.has(repo.name)) {
      problems.push({
        title: `${repo.name}: public repository is not listed`,
        body: `Add \`${repoFile(repo.name, repo.archived === true)}\` or an entry with a reason in \`ignored.yaml\`.`,
        unlisted: repo.name,
      });
    }
  }

  // An entry without a public repository is a typo, a deleted repository or one that went private
  for (const name of listed) {
    if (!liveByName.has(name)) {
      problems.push({
        title: `${name}: listed repository does not exist or is not public`,
        body: "Remove the entry, fix its name or make the repository public.",
      });
    }
  }

  // Archiving happens by hand on GitHub and the file follows
  for (const repo of repos) {
    const liveRepo = liveByName.get(repo.name);
    if (liveRepo && (liveRepo.archived === true) !== repo.archived) {
      moves.push({ repo, archived: !repo.archived });
    }
  }

  return { problems, moves };
}
