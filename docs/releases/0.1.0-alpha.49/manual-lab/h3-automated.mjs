#!/usr/bin/env node
/**
 * Scenario H3, automated negative control, on an isolated COPY of the Work Item (never the lab's own).
 *
 *   node h3-automated.mjs [copy-dir]        (default ~/praxis-alpha49-h3-auto, made by make-approval-copy.sh)
 *
 * Starts the Praxis Runtime exactly as Claude Code does (the Marketplace plugin's server over stdio, official MCP SDK
 * client) with a client that DECLARES the elicitation capability and answers the Runtime's approval dialog by script:
 * decline, cancel, and the form's own "reject" choice. It also runs a client with NO dialog (the agent alone).
 * It never answers "approve": no approval is created and no `independent-human` record can come out of this script.
 *
 * What this is NOT: a person pressing Reject in Claude Code. The real client dialog stays NOT VERIFIED.
 * Never prints environment variables.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const split = resolve(process.env.PRAXIS_SPLIT_ROOT ?? join(here, "../../.."));
const runtimeRoot = join(split, "praxis-runtime");
const server = process.env.PRAXIS_H3_SERVER ?? join(split, "praxis-marketplace/plugins/praxis-runtime/server/praxis-mcp.cjs");
const copy = resolve(process.argv[2] ?? join(homedir(), "praxis-alpha49-h3-auto"));
const lab = resolve(process.env.PRAXIS_LAB ?? join(homedir(), "praxis-alpha49-lab"), "projects/orders-app");
const STORY = "US-ORD-004";

const { connectOfficialMcp, hostedCleanEnv, parseDoctorEnvelope, versionNegotiationLegacy } = await import(pathToFileURL(join(runtimeRoot, "tools/scripts/official-mcp-client.mjs")).href);

const results = [];
const fail = (m) => { console.error(`FAIL h3-automated: ${m}`); process.exit(1); };
const ok = (m) => { results.push(m); console.log(`  ok ${results.length}. ${m}`); };
const expect = (c, m) => { if (!c) fail(m); };

if (!existsSync(join(copy, ".praxis/workflow/items"))) fail(`no Work Item copy at ${copy} (run make-approval-copy.sh)`);
if (resolve(copy).startsWith(resolve(lab)) || resolve(copy) === resolve(lab)) fail("refusing to run on the lab itself");
const itemsDir = join(copy, ".praxis/workflow/items");
const itemFile = join(itemsDir, readdirSync(itemsDir).find((n) => n.endsWith(".json")));
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const item = () => JSON.parse(readFileSync(itemFile, "utf8"));
const storyOf = (d) => (d.stories ?? []).find((s) => s.id === STORY);
const labSha = () => (existsSync(join(lab, ".praxis/workflow/items")) ? readdirSync(join(lab, ".praxis/workflow/items")).filter((n) => n.endsWith(".json")).sort().map((n) => `${n}:${sha(join(lab, ".praxis/workflow/items", n))}`).join("|") : "n/a");
const labBefore = labSha();

const home = mkdtempSync(join(tmpdir(), "praxis-h3-home-")); // the decision journal goes here, not into the real home
const open = (elicit) =>
  connectOfficialMcp({
    command: process.execPath,
    args: [server, "--role", "runtime"],
    cwd: copy,
    env: { ...hostedCleanEnv(home), PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`, PRAXIS_SKIP_DOTENV: "1" },
    versionNegotiation: versionNegotiationLegacy(),
    elicit,
    timeoutMs: 20_000,
    clientName: "praxis-h3-automated",
  });
const call = async (session, name, args) => parseDoctorEnvelope(await session.client.callTool({ name, arguments: args }));
const workflow = async (session, command) => {
  const preview = await call(session, "praxis_workflow_preview", { repo: copy, command: JSON.stringify(command) });
  expect(preview.ok, `preview ${command.action}: ${JSON.stringify(preview).slice(0, 400)}`);
  return call(session, "praxis_workflow_apply", { repo: copy, command: JSON.stringify(command), confirmation: "YES", previewFingerprint: preview.data.fingerprint });
};
const stories = async (session) => (await call(session, "praxis_workflow_inspect", { repo: copy, view: "stories" })).data;

let answer = async () => ({ action: "decline" });
const dialogSession = await open((params) => answer(params));
const noDialogSession = await open(undefined);
try {
  const doc = await call(dialogSession, "praxis_doctor", { repo: copy });
  expect(doc.data.approval?.client?.elicitation?.form === true, `the Runtime does not see a dialog-capable client: ${JSON.stringify(doc.data.approval)}`);
  ok(`Runtime ${doc.data.build?.version ?? "?"} started from the Marketplace plugin; it sees a client that can show a dialog`);
  const nd = await call(noDialogSession, "praxis_doctor", { repo: copy });
  expect(nd.data.approval?.mode === "no-dialog", `second client is not a no-dialog client: ${JSON.stringify(nd.data.approval)}`);
  ok("a second client without any dialog capability is reported as no-dialog");

  // setup: an agent-authored edit puts the Story back to `proposed` (no dialog expected, no approval record)
  const before0 = storyOf(item());
  expect(before0 && before0.status === "confirmed", `${STORY} is not confirmed in the copy: ${before0?.status}`);
  const asked0 = dialogSession.elicited.length;
  const edit = await workflow(dialogSession, { action: "update-story", id: STORY, patch: { objective: `${before0.objective ?? "Story"} (H3 retest)` }, reason: "H3 automated negative control: put the Story back to proposed" });
  expect(edit.ok, `update-story: ${JSON.stringify(edit).slice(0, 500)}`);
  expect(dialogSession.elicited.length === asked0, "an agent-authored edit opened a dialog");
  const base = item();
  const story0 = storyOf(base);
  expect(story0.status === "proposed" && story0.revision === before0.revision + 1, `after update-story: ${story0.status} r${story0.revision}`);
  expect((base.approvals ?? []).length === 0, "approvals[] is not empty after the agent edit");
  const hBase = sha(itemFile);
  ok(`agent edit: ${STORY} is proposed r${story0.revision}; no dialog, approvals[] empty (baseline sha256 ${hBase.slice(0, 12)})`);

  const listed = (await stories(dialogSession)).stories ?? [];
  const entry = listed.find((s) => s.id === STORY);
  expect(entry?.contentFingerprint, "inspect does not give the Story's contentFingerprint");
  const confirm = { action: "confirm-story", id: STORY, revision: entry.revision, contentFingerprint: entry.contentFingerprint };

  const unchanged = (label) => {
    const d = item(); const s = storyOf(d);
    expect(sha(itemFile) === hBase, `${label}: the Work Item file changed (sha256 ${sha(itemFile).slice(0, 12)} vs ${hBase.slice(0, 12)})`);
    expect(s.status === "proposed" && s.revision === story0.revision && (d.approvals ?? []).length === 0, `${label}: ${s.status} r${s.revision}, approvals ${(d.approvals ?? []).length}`);
  };

  const rejectCases = [
    ["dialog answered: decline", () => ({ action: "decline" })],
    ["dialog answered: cancel", () => ({ action: "cancel" })],
    ["dialog form answered: decision=reject", () => ({ action: "accept", content: { decision: "reject" } })],
  ];
  for (const [label, make] of rejectCases) {
    answer = async () => make();
    const asked = dialogSession.elicited.length;
    const r = await workflow(dialogSession, confirm);
    expect(r.ok === false && r.data?.executed !== true, `${label}: the Runtime did not refuse: ${JSON.stringify(r).slice(0, 400)}`);
    expect(dialogSession.elicited.length === asked + 1, `${label}: the Runtime did not show exactly one dialog (${dialogSession.elicited.length - asked})`);
    const shown = dialogSession.elicited.at(-1);
    expect(String(shown.message).includes(STORY) && /approve/.test(JSON.stringify(shown.requestedSchema ?? {})), `${label}: the dialog does not show the Story and an approve/reject choice`);
    unchanged(label);
    ok(`${label}: refused with ${r.code}; the dialog showed ${STORY}; Story still proposed r${story0.revision}; approvals[] empty; file byte-identical`);
  }

  // an agent alone (no dialog) cannot substitute for the user
  const noUi = await workflow(noDialogSession, confirm);
  expect(noUi.ok === false && noUi.code === "APPROVAL_CLIENT_UI_REQUIRED" && noUi.data?.executed === false, `no-dialog client: ${JSON.stringify(noUi).slice(0, 400)}`);
  expect(noDialogSession.elicited.length === 0, "the no-dialog client was shown a dialog");
  unchanged("no-dialog client");
  ok(`agent alone, confirmation=YES, no dialog: refused with ${noUi.code}, nothing executed`);

  const no = await call(dialogSession, "praxis_workflow_apply", { repo: copy, command: JSON.stringify(confirm), confirmation: "NO", previewFingerprint: "x" });
  expect(no.ok === false, `confirmation=NO: ${JSON.stringify(no).slice(0, 300)}`);
  unchanged("confirmation=NO");
  ok(`confirmation=NO: refused with ${no.code}; nothing changed`);

  const final = item();
  expect((final.approvals ?? []).length === 0 && !JSON.stringify(final).includes("independent-human"), "an approval or an independent-human mark exists");
  ok("final: approvals[] empty, no independent-human mark anywhere in the Work Item");
  expect(labSha() === labBefore, "the lab's own Work Item changed");
  ok("the lab's Work Item (source) is unchanged");
} finally {
  await dialogSession.close().catch(() => {});
  await noDialogSession.close().catch(() => {});
  rmSync(home, { recursive: true, force: true });
}
console.log(`PASS h3-automated (${results.length} checks)`);
console.log("NOT VERIFIED: a person pressing Reject in the Claude Code dialog. The answers above were scripted; this is an automated negative control, not a human refusal.");
