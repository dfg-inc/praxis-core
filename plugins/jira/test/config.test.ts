import { describe, expect, it } from "vitest";
import { loadJiraConfig, patSupportedForVersion } from "../src/config.js";

describe("loadJiraConfig", () => {
  it("fails closed when token is missing", () => {
    expect(() =>
      loadJiraConfig({
        PRAXIS_JIRA_BASE_URL: "https://jira.example.com",
        PRAXIS_JIRA_PROJECT_KEY: "PRAX",
      }),
    ).toThrow(/PRAXIS_JIRA_TOKEN/);
  });

  it("rejects malformed URLs", () => {
    expect(() =>
      loadJiraConfig({
        PRAXIS_JIRA_BASE_URL: "not-a-url",
        PRAXIS_JIRA_TOKEN: "tok",
        PRAXIS_JIRA_PROJECT_KEY: "PRAX",
      }),
    ).toThrow(/malformed/);
  });

  it("loads a valid config", () => {
    const cfg = loadJiraConfig({
      PRAXIS_JIRA_BASE_URL: "https://jira.example.com/",
      PRAXIS_JIRA_TOKEN: "tok",
      PRAXIS_JIRA_PROJECT_KEY: "PRAX",
    });
    expect(cfg.baseUrl).toBe("https://jira.example.com");
  });
});

describe("patSupportedForVersion", () => {
  it("accepts 8.14+", () => {
    expect(patSupportedForVersion("8.14.0").supported).toBe(true);
    expect(patSupportedForVersion("9.0.0").supported).toBe(true);
  });

  it("rejects pre-PAT Server versions", () => {
    const r = patSupportedForVersion("8.13.9");
    expect(r.supported).toBe(false);
    expect(r.guidance).toMatch(/OAuth/i);
  });
});
