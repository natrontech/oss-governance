import { expect, test } from "vitest";
import { responseStatus } from "./response.ts";

// Opened on Monday 2026-11-02 with 5 working days to respond and a warning 2 days before
const status = (now: string) => responseStatus(new Date("2026-11-02T15:00:00Z"), new Date(now), 5, 2);

test("a fresh request needs no attention", () => {
  expect(status("2026-11-04T03:00:00Z")).toBeUndefined();
});

test("a request is due once the warning window is reached", () => {
  expect(status("2026-11-05T03:00:00Z")).toBe("due");
});

test("the weekend does not count", () => {
  expect(status("2026-11-08T03:00:00Z")).toBe("due");
  expect(status("2026-11-09T03:00:00Z")).toBe("due");
});

test("a request is overdue after the last working day", () => {
  expect(status("2026-11-10T03:00:00Z")).toBe("overdue");
});
