import { expect, test } from "vitest";
import type { Config } from "./config.ts";
import { archiveReasons, remindersDue } from "./problems.ts";

test("the first reminder comes after the first interval and the next ones after every further interval", () => {
  expect([0, 1, 2, 3, 4, 7].map((days) => remindersDue(days, 1, 3))).toEqual([0, 1, 1, 1, 2, 3]);
});

const config = { archiveInactiveMonths: 12, archiveNeglectedMonths: 6 } as Config;
const now = new Date("2026-11-26T07:00:00Z");

test("an inactive repository is suggested after the inactivity window", () => {
  expect(archiveReasons(config, now, "2025-12-01T00:00:00Z", [])).toEqual([]);
  expect(archiveReasons(config, now, "2025-11-01T00:00:00Z", [])).toHaveLength(1);
});

test("a neglected repository is suggested after the shorter window, together with the reasons of neglect", () => {
  expect(archiveReasons(config, now, "2026-06-01T00:00:00Z", ["no maintainer"])).toEqual([]);
  expect(archiveReasons(config, now, "2026-05-01T00:00:00Z", ["no maintainer"])).toEqual([
    "no activity for more than 6 months, the last was on 2026-05-01",
    "no maintainer",
  ]);
});
