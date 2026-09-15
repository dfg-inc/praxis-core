import { describe, expect, it } from "vitest";
import { buildIssueTypeMapping, resolveSemanticType } from "../src/issue-types.js";
import type { JiraConfig } from "../src/config.js";

const cfg = {
  mode: "cloud",
  baseUrl: "https://x.atlassian.net",
  token: "t",
  projectKey: "PRX",
  email: "a@b.c",
  authMode: "cloud-basic",
  epicType: "Epic",
  storyType: "Story",
  taskType: "Task",
  bugType: "Bug",
  workPackageType: "",
  transitions: {},
  workPackageMaxHours: 16,
} as JiraConfig;

describe("issue type resolution", () => {
  it("maps localized Task/Bug/Epic by alias and hierarchy", () => {
    const mapping = buildIssueTypeMapping(
      [
        { id: "1", name: "Эпик", hierarchyLevel: 1 },
        { id: "2", name: "Задача", hierarchyLevel: 0 },
        { id: "3", name: "Ошибка", hierarchyLevel: 0 },
      ],
      cfg,
    );
    expect(mapping.epicTypeId).toBe("1");
    expect(mapping.taskTypeId).toBe("2");
    expect(mapping.bugTypeId).toBe("3");
    expect(resolveSemanticType({ name: "Задача", id: "2" }, mapping, cfg)).toBe("task");
    expect(resolveSemanticType({ name: "Ошибка", id: "3" }, mapping, cfg)).toBe("bug");
  });
});
