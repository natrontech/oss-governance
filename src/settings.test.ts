import { expect, test } from "vitest";
import { desiredRuleset, matches } from "./settings.ts";

const desired = desiredRuleset({ requiredApprovals: 1, signedCommits: true, codeOwnerReview: false }, 7, 9);

// The shape GitHub answers with: extra fields and another order of rules and bypass actors
const current = {
  id: 1,
  ...desired,
  bypass_actors: desired.bypass_actors.toReversed(),
  rules: desired.rules.toReversed().map((rule) => ({ ...rule, ruleset_id: 1 })),
};

test("a ruleset with extra fields and another order is unchanged", () => {
  expect(matches(current, desired)).toBe(true);
});

test("a changed value is drift", () => {
  const relaxed = desiredRuleset({ requiredApprovals: 0, signedCommits: true, codeOwnerReview: false }, 7, 9);
  expect(matches({ ...current, rules: relaxed.rules }, desired)).toBe(false);
});

test("a rule added by hand is drift", () => {
  expect(matches({ ...current, rules: [...current.rules, { type: "required_linear_history" }] }, desired)).toBe(false);
});

test("signed commits can be switched off", () => {
  const unsigned = desiredRuleset({ requiredApprovals: 1, signedCommits: false, codeOwnerReview: false }, 7, 9);
  expect(unsigned.rules.map((rule) => rule.type)).toEqual(["pull_request", "deletion", "non_fast_forward"]);
});
