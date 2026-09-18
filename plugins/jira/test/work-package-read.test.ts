import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyWpLifecycle,
  isInvalidWpTitle,
  resolveWorkPackageTitle,
  selectArchitectWorkPackages,
  WorkPackageScopeError,
} from "../src/work-package-read.js";

function seedWp(
  repo: string,
  id: string,
  opts: {
    manifestTitle?: string;
    designTitle?: string;
    heading?: string;
    status?: string;
    phasesComplete?: boolean;
    jiraIssueKey?: string;
  } = {},
) {
  const design = join(repo, "design", id);
  mkdirSync(design, { recursive: true });
  const wpDir = join(repo, "wp", id);
  mkdirSync(wpDir, { recursive: true });
  const fm = [
    "---",
    `id: ${id}`,
    "type: wp",
    "role: developer",
    `status: ${opts.status ?? "ready"}`,
  ];
  if (opts.manifestTitle !== undefined) fm.push(`title: ${opts.manifestTitle}`);
  if (opts.phasesComplete) fm.push("phasesComplete: true");
  fm.push("---", "");
  writeFileSync(join(wpDir, "index.md"), `${fm.join("\n")}\n`);
  writeFileSync(
    join(design, "index.md"),
    opts.heading ? `# ${opts.heading}\n\nbody\n` : "body only\n",
  );
  const spec: Record<string, unknown> = { id };
  if (opts.designTitle) spec.design = { title: opts.designTitle };
  writeFileSync(join(design, "change-spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
  const manifestDir = join(repo, "work-packages", id);
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(
    join(manifestDir, "manifest.json"),
    `${JSON.stringify(
      { id, status: opts.status ?? "ready", jiraIssueKey: opts.jiraIssueKey ?? "PLANNED" },
      null,
      2,
    )}\n`,
  );
}

describe("work package title resolution", () => {
  it("rejects --- / empty / Work Package", () => {
    expect(isInvalidWpTitle("---")).toBe(true);
    expect(isInvalidWpTitle("")).toBe(true);
    expect(isInvalidWpTitle("   ")).toBe(true);
    expect(isInvalidWpTitle("Work Package")).toBe(true);
    expect(isInvalidWpTitle("Add reset() to the counter library")).toBe(false);
  });

  it("uses manifest then change-spec then heading then story", () => {
    expect(
      resolveWorkPackageTitle({
        manifestTitle: "From manifest",
        changeSpecTitle: "From design",
        designHeading: "From heading",
        storySummary: "From story",
      }),
    ).toEqual({ title: "From manifest", titleSource: "manifest" });
    expect(
      resolveWorkPackageTitle({
        changeSpecTitle: "Add reset() to the counter library",
        designHeading: "Counter Reset",
      }),
    ).toEqual({
      title: "Add reset() to the counter library",
      titleSource: "design.change-spec",
    });
    expect(resolveWorkPackageTitle({ designHeading: "Counter Reset" })).toEqual({
      title: "Counter Reset",
      titleSource: "design.index",
    });
    expect(resolveWorkPackageTitle({ storySummary: "Story title" })).toEqual({
      title: "Story title",
      titleSource: "derived.story",
    });
    expect(resolveWorkPackageTitle({ manifestTitle: "---" })).toEqual({
      title: "",
      titleSource: "invalid",
    });
  });
});

describe("work package lifecycle", () => {
  it("classifies phasesComplete + ready/PLANNED as historical", () => {
    expect(
      classifyWpLifecycle({
        status: "ready",
        phasesComplete: true,
        jiraIssueKey: "PLANNED",
      }),
    ).toBe("historical");
  });

  it("keeps ready/PLANNED without completion evidence as ready", () => {
    expect(
      classifyWpLifecycle({
        status: "ready",
        phasesComplete: false,
        jiraIssueKey: "PLANNED",
      }),
    ).toBe("ready");
  });
});

describe("architect WP scope", () => {
  it("hard-scopes explicit workPackageId even when sibling is ready/PLANNED", () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-wp-scope-"));
    seedWp(repo, "WP-20260914-002", {
      designTitle: "Add reset() to the counter library",
    });
    seedWp(repo, "WP-20260901-001", {
      designTitle: "Add decrement(value) to the counter library",
      jiraIssueKey: "PLANNED",
    });
    const { selected, inspected } = selectArchitectWorkPackages({
      repo,
      epicKey: "PRX-1",
      workPackageId: "WP-20260914-002",
    });
    expect(inspected.map((w) => w.id).sort()).toEqual([
      "WP-20260901-001",
      "WP-20260914-002",
    ]);
    expect(selected.map((w) => w.id)).toEqual(["WP-20260914-002"]);
    expect(selected[0]?.title).toBe("Add reset() to the counter library");
    expect(selected[0]?.titleSource).toBe("design.change-spec");
  });

  it("returns WORK_PACKAGE_SCOPE_AMBIGUOUS when omitted with two ready WPs", () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-wp-ambig-"));
    seedWp(repo, "WP-20260914-002", { designTitle: "Current" });
    seedWp(repo, "WP-20260901-001", { designTitle: "Sibling" });
    expect(() =>
      selectArchitectWorkPackages({ repo, epicKey: "PRX-1" }),
    ).toThrow(WorkPackageScopeError);
    try {
      selectArchitectWorkPackages({ repo, epicKey: "PRX-1" });
    } catch (e) {
      expect(e).toBeInstanceOf(WorkPackageScopeError);
      expect((e as WorkPackageScopeError).code).toBe("WORK_PACKAGE_SCOPE_AMBIGUOUS");
    }
  });

  it("rejects explicit historical WP", () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-wp-hist-"));
    seedWp(repo, "WP-20260901-001", {
      designTitle: "Old",
      phasesComplete: true,
    });
    expect(() =>
      selectArchitectWorkPackages({
        repo,
        epicKey: "PRX-1",
        workPackageId: "WP-20260901-001",
      }),
    ).toThrow(/WORK_PACKAGE_INVALID_STATE/);
  });

  it("rejects invalid resolved titles including ---", () => {
    const repo = mkdtempSync(join(tmpdir(), "praxis-wp-title-"));
    seedWp(repo, "WP-20260914-002", { manifestTitle: "---" });
    expect(() =>
      selectArchitectWorkPackages({
        repo,
        epicKey: "PRX-1",
        workPackageId: "WP-20260914-002",
      }),
    ).toThrow(/WORK_PACKAGE_TITLE_INVALID/);
  });
});
