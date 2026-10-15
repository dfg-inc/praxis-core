#!/usr/bin/env node
/**
 * Controlled end-to-end scenario using fixtures + Docker UID isolation for the
 * authorization path. Does not touch production Jira or real Claude config.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const c = require(join(root, "packages/contracts/dist/index.js"));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// 1-9 story / architecture / snapshot path (in-process contracts)
let state = c.openLocalWorkflow({
  projectId: "e2e",
  title: "Milestone 1.3",
  request: "Cross-role acceptance",
});
state = c.applyWorkflowCommand(state, {
  action: "add-requirement",
  id: "REQ-E2E-001",
  statement: "Stories stay unconfirmed until reviewed.",
  acceptanceCriteria: ["Owner sees the story."],
}).state;
for (let i = 1; i <= 4; i += 1) {
  state = c.applyWorkflowCommand(state, {
    action: "add-story",
    id: `US-E2E-00${i}`,
    requirementIds: ["REQ-E2E-001"],
    actor: "owner",
    narrative: "As a owner, I want exact confirmation, so that architecture approval cannot confirm unseen stories.",
    objective: "Keep stories unconfirmed",
    userValue: "Correct handoff",
    happyPath: ["Review", "Confirm"],
    acceptanceCriteria: [{ id: `US-E2E-00${i}-AC-01`, given: "unseen story", when: "architecture approved", then: "story stays unconfirmed" }],
    expectedResults: ["unconfirmed"],
    confirmedBehavior: false,
  }).state;
}
for (let i = 1; i <= 11; i += 1) {
  state = c.applyWorkflowCommand(state, {
    action: "record-decision",
    id: `DEC-${String(i).padStart(3, "0")}`,
    statement: `Decision ${i}`,
    confirmed: true,
    rationale: `rationale-${(i % 5) + 1}`,
    notes: i === 1 ? "notes stay" : undefined,
  }).state;
}
check("architecture_does_not_confirm_stories", state.stories.every((s) => s.confirmedBehavior === false));

state = c.applyWorkflowCommand(state, {
  action: "record-context",
  openQuestions: ["Who owns retries?", "Which tenant?"],
  risks: ["partial export"],
  blockers: ["missing owner"],
  notes: "beta notes stay",
}).state;
const snapshot = c.exportWorkflowSnapshot(state);
const html = c.renderWorkflowSnapshotHtml(state);
check(
  "snapshot_preserves_fields",
  snapshot.openQuestions.length === 2 &&
    snapshot.notes === "beta notes stay" &&
    new Set(snapshot.decisions.map((d) => d.rationale)).size === 5 &&
    html.includes("Who owns retries?") &&
    html.includes("beta notes stay"),
);

// Story confirmation requires signed grant
const keys = c.generateApprovalKeyPair();
const prevPub = process.env.PRAXIS_APPROVAL_PUBLIC_KEY;
const prevPriv = process.env.PRAXIS_APPROVAL_PRIVATE_KEY;
delete process.env.PRAXIS_APPROVAL_PRIVATE_KEY;
process.env.PRAXIS_APPROVAL_PUBLIC_KEY = keys.publicKeyPem;
const story = state.stories[0];
const contentFingerprint = c.storyContentFingerprint(story);
const digest = c.storyConfirmationDigest({
  storyId: story.id,
  revision: story.revision,
  contentFingerprint,
});
const token = c.encodeAuthorization(
  c.signAuthorization(
    {
      contract: "praxis.approval.authorization",
      version: 1,
      planFingerprint: digest,
      provider: "local",
      instanceId: "local",
      operations: ["external_record_update"],
      workItemIds: [story.id],
      repositories: [],
      action: "confirm-story",
      approver: "owner",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumptionId: "e2e-story-1",
    },
    keys.privateKeyPem,
  ),
);
state = c.applyWorkflowCommand(state, {
  action: "confirm-story",
  id: story.id,
  revision: story.revision,
  contentFingerprint,
  authorization: token,
}).state;
check("exact_story_confirmation", state.stories.filter((s) => s.confirmedBehavior).length === 1);
if (prevPub === undefined) delete process.env.PRAXIS_APPROVAL_PUBLIC_KEY;
else process.env.PRAXIS_APPROVAL_PUBLIC_KEY = prevPub;
if (prevPriv === undefined) delete process.env.PRAXIS_APPROVAL_PRIVATE_KEY;
else process.env.PRAXIS_APPROVAL_PRIVATE_KEY = prevPriv;

// Developer plan + broker isolation path
const plan = c.buildActionPlan({
  planId: "e2e-dev-1",
  role: "developer",
  decisionKind: "development_action",
  summary: "Prepare implementation for confirmed story only",
  provider: "local",
  instanceId: "local",
  operations: ["repository_edit"],
  workItemIds: [story.id],
  storyIds: [story.id],
  decisionIds: [],
  repositories: ["/tmp/e2e"],
  actions: [{ action: "praxis_workflow_apply", description: "record implementation unit", targets: [story.id] }],
  risks: ["scope creep"],
  sideEffects: ["workflow state write"],
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
check("developer_plan_exact_scope", plan.storyIds.includes(story.id) && plan.decisionKind === "development_action");
check("architecture_kind_distinct", plan.decisionKind !== "architecture_decision");

const isolation = spawnSync("node", [join(root, "tools/broker/docker/run-isolation-test.mjs")], {
  encoding: "utf8",
  cwd: root,
});
check("isolated_broker_executor", (isolation.status ?? 1) === 0, isolation.stdout.split("\n").filter((l) => l.startsWith("PASS") || l.startsWith("FAIL") || l.includes("ISOLATION")).slice(-3).join("; "));

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? "E2E FAIL" : "E2E PASS");
process.exit(failed.length ? 1 : 0);
