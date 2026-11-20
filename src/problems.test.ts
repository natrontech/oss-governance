import { expect, test } from "vitest";
import { remindersDue } from "./problems.ts";

test("the first reminder comes after the first interval and the next ones after every further interval", () => {
  expect([0, 1, 2, 3, 4, 7].map((days) => remindersDue(days, 1, 3))).toEqual([0, 1, 1, 1, 2, 3]);
});
