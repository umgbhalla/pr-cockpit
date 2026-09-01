import { expect, test } from "bun:test";
import { availableRepositories, filterByRepository } from "./repoFilter.js";

test("repository choices include configured and cached repositories", () => {
  const prs = [{ repo: "zonko-ai/harp" }, { repo: "umgbhalla/pr-cockpit" }];
  expect(availableRepositories(["empty/repo", "zonko-ai/harp"], prs)).toEqual([
    "empty/repo",
    "umgbhalla/pr-cockpit",
    "zonko-ai/harp",
  ]);
  expect(filterByRepository(prs, "umgbhalla/pr-cockpit")).toEqual([{ repo: "umgbhalla/pr-cockpit" }]);
  expect(filterByRepository(prs, "")).toBe(prs);
});
