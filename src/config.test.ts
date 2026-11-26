import { expect, test } from "vitest";
import { type Config, reconcile, resolveRepo } from "./config.ts";

const config: Config = {
  ruleset: { requiredApprovals: 1, signedCommits: true, codeOwnerReview: false },
  responseWarningDays: 2,
  overdueReminderDays: 7,
  unlistedFirstReminderDays: 1,
  unlistedReminderDays: 3,
  archiveInactiveMonths: 12,
  archiveNeglectedMonths: 6,
  archiveUnansweredDays: 90,
  tiers: {
    "tier-1": { license: "Apache-2.0", responseDays: 5 },
    "tier-3": { license: "CC-BY-SA-4.0", responseDays: null },
  },
};

test("a repository inherits from its tier and the org ruleset", () => {
  expect(resolveRepo(config, "a", false, { tier: "tier-1", maintainers: ["x"] })).toMatchObject({
    license: "Apache-2.0",
    responseDays: 5,
    ruleset: config.ruleset,
  });
});

test("a repository overrides single values", () => {
  const repo = resolveRepo(config, "a", false, {
    tier: "tier-1",
    maintainers: ["x"],
    license: "GPL-3.0",
    licenseReason: "external contributions",
    responseDays: null,
    ruleset: { requiredApprovals: 0 },
  });
  expect(repo).toMatchObject({
    license: "GPL-3.0",
    responseDays: null,
    ruleset: { requiredApprovals: 0, signedCommits: true, codeOwnerReview: false },
  });
});

test("another license than the tier's needs a reason, and only then", () => {
  const repo = (license: string, licenseReason?: string) =>
    resolveRepo(config, "a", false, { tier: "tier-1", maintainers: [], license, licenseReason });
  expect(() => repo("GPL-3.0")).toThrow("licenseReason");
  expect(() => repo("Apache-2.0", "stale")).toThrow("licenseReason");
});

test("an unknown tier is rejected", () => {
  expect(() => resolveRepo(config, "a", false, { tier: "tier-9", maintainers: [] })).toThrow("unknown tier");
});

test("reconcile reports unlisted and missing repositories and follows archiving", () => {
  const repo = (name: string, archived: boolean) =>
    resolveRepo(config, name, archived, { tier: "tier-1", maintainers: [] });
  const { problems, moves } = reconcile(
    [repo("active", false), repo("now-archived", false), repo("revived", true), repo("gone", false)],
    ["fork"],
    [
      { name: "active", archived: false },
      { name: "now-archived", archived: true },
      { name: "revived", archived: false },
      { name: "fork", archived: false },
      { name: "new", archived: false },
    ],
  );
  expect(problems.map((problem) => problem.title)).toEqual([
    "new: public repository is not listed",
    "gone: listed repository does not exist or is not public",
  ]);
  expect(moves.map((move) => [move.repo.name, move.archived])).toEqual([
    ["now-archived", true],
    ["revived", false],
  ]);
});
