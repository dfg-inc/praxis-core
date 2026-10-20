import { describe, expect, it } from "vitest";
import { resolveCanonicalQualityState } from "../src/quality-lifecycle-status.js";

describe("canonical qualityState", () => {
  it("does not treat ready-for-qa as pending when praxis.state is approved", () => {
    const snap = resolveCanonicalQualityState({
      workPackageId: "WP-20260914-002",
      jiraWorkPackageKey: "PRX-4",
      jiraStatus: "Готово",
      jiraStatusCategory: "done",
      praxisState: {
        lifecycle: "qa-passed",
        implementationState: "complete",
        readyForQuality: true,
        qualityState: "approved",
        reviewId: 1,
      },
      localManifest: {
        status: "ready-for-qa",
        implementationState: "complete",
        readyForQuality: true,
        qualityState: "approved",
      },
      workPackageManifest: { status: "ready-for-qa", claim: { state: "active" } },
      claim: { state: "active" },
      applyResult: {
        ok: true,
        partial: false,
        completed: ["a"],
        pending: [],
        bugsCreated: [],
        previewFingerprint: "sha256:x",
        jiraWorkPackageKey: "PRX-4",
        reviewId: 1,
        appliedReviewId: 1,
        jiraTransitioned: true,
        localStateReconciled: true,
        qualityStoreReconciled: true,
        lifecycle: "committed",
        warnings: [],
        errors: [],
      },
      evidence: { reviewId: 1, verdict: "PASSED", approvalApplied: true },
      inspection: {
        localStatus: "ready-for-qa",
        implementationState: "complete",
        readyForQuality: true,
        hasEvidence: true,
        hasHandoff: true,
        evidencePath: "x",
        qualityHandoffPath: "y",
        localClaim: null,
      },
    });
    expect(snap.qualityState).toBe("approved");
    expect(snap.appliedReviewId).toBe(1);
    expect(snap.claimState).toBe("active");
    expect(snap.consistency.some((c) => c.source === "praxis.workPackageManifest" && c.consistency === "ignored")).toBe(
      true,
    );
  });

  it("returns pending after Developer complete before Apply", () => {
    const snap = resolveCanonicalQualityState({
      workPackageId: "WP-20260914-002",
      praxisState: { qualityState: "pending", readyForQuality: true, implementationState: "complete" },
      localManifest: { status: "ready-for-qa", qualityState: "pending", readyForQuality: true },
      inspection: {
        localStatus: "ready-for-qa",
        implementationState: "complete",
        readyForQuality: true,
        hasEvidence: true,
        hasHandoff: true,
        evidencePath: "x",
        qualityHandoffPath: "y",
        localClaim: null,
      },
    });
    expect(snap.qualityState).toBe("pending");
    expect(snap.appliedReviewId).toBeNull();
  });

  it("does not infer pending from a historical manifest missing qualityState", () => {
    const snap = resolveCanonicalQualityState({
      workPackageId: "WP-20260914-002",
      praxisState: { qualityState: "approved", reviewId: 1, implementationState: "complete" },
      localManifest: { status: "ready-for-qa" },
      workPackageManifest: { status: "ready-for-qa" },
      inspection: {
        localStatus: "ready-for-qa",
        implementationState: "complete",
        readyForQuality: true,
        hasEvidence: true,
        hasHandoff: true,
        evidencePath: "x",
        qualityHandoffPath: "y",
        localClaim: null,
      },
    });
    expect(snap.qualityState).toBe("approved");
  });

  it("marks partial Apply as not full success", () => {
    const snap = resolveCanonicalQualityState({
      workPackageId: "WP-1",
      praxisState: { qualityState: "pending" },
      applyResult: {
        ok: false,
        partial: true,
        completed: ["p"],
        pending: ["t"],
        bugsCreated: [],
        previewFingerprint: "sha256:x",
        jiraWorkPackageKey: "PRX-4",
        reviewId: 1,
        jiraTransitioned: false,
        localStateReconciled: false,
        qualityStoreReconciled: false,
        lifecycle: "partial",
        warnings: [],
        errors: ["x"],
      },
      inspection: {
        localStatus: "ready-for-qa",
        implementationState: "complete",
        readyForQuality: true,
        hasEvidence: true,
        hasHandoff: true,
        evidencePath: "x",
        qualityHandoffPath: "y",
        localClaim: null,
      },
    });
    expect(snap.overallConsistency).toBe("partial");
    expect(snap.applyPartial).toBe(true);
  });
});

describe("stale work package manifest diagnostic", () => {
  it("is not reported when there is no manifest to ignore", () => {
    const snapshot = resolveCanonicalQualityState({ workPackageId: "WP-20260914-002" });
    expect(snapshot.consistency.map((item) => item.diagnosticCode)).not.toContain("STALE_WORK_PACKAGE_MANIFEST_NOT_CANONICAL");
    expect(snapshot.consistency.some((item) => item.source === "praxis.workPackageManifest")).toBe(false);
  });

  it("is still reported, as ignored, when a stale manifest carries a quality state", () => {
    const snapshot = resolveCanonicalQualityState({
      workPackageId: "WP-20260914-002",
      workPackageManifest: { qualityState: "pending" },
    });
    const stale = snapshot.consistency.find((item) => item.source === "praxis.workPackageManifest");
    expect(stale).toMatchObject({ consistency: "ignored", diagnosticCode: "STALE_WORK_PACKAGE_MANIFEST_NOT_CANONICAL", actualValue: "pending" });
  });
});
