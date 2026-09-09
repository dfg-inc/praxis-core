#!/usr/bin/env node
/**
 * Phase 1 readiness aggregator. Fails on NOT IMPLEMENTED or missing
 * deterministic acceptance. External blockers do not fail the gate.
 *
 *   node tools/scripts/phase1-readiness.mjs
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const CLOSED = "CLOSED";
const LOCAL = "ACCEPTED LOCALLY / LIVE PENDING";
const BLOCKED = "BLOCKED EXTERNALLY";
const MISSING_ACC = "IMPLEMENTED / ACCEPTANCE PENDING";
const NOT_IMPL = "NOT IMPLEMENTED";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function run(cmd) {
  const r = spawnSync(cmd, { cwd: root, shell: true, encoding: "utf8" });
  return {
    ok: (r.status ?? 1) === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function parseProductWbs() {
  const md = readFileSync(join(root, "docs/source/4-implement/wbs.md"), "utf8");
  const rows = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\| (\d+(?:\.\d+)*) \| ([^|]+)\|/);
    if (!m) continue;
    const wbs = m[1];
    if (wbs.startsWith("9") || wbs.startsWith("10")) continue;
    rows.push({ wbs, requirement: m[2].trim() });
  }
  return rows;
}

const epic0 = [
  { wbs: "0", requirement: "Monorepo foundation (implementation-only)" },
  { wbs: "0.1", requirement: "Repository inventory and baseline" },
  { wbs: "0.2", requirement: "Workspace/bootstrap" },
  { wbs: "0.3", requirement: "Import existing code into bounded locations" },
  { wbs: "0.4", requirement: "Shared contracts foundation" },
  { wbs: "0.5", requirement: "Shared project configuration" },
  { wbs: "0.6", requirement: "Knowledge/rules foundation" },
  { wbs: "0.7", requirement: "Plugin shared runtime/SDK" },
  { wbs: "0.8", requirement: "CI and dependency boundaries" },
  { wbs: "0.9", requirement: "Cross-product E2E harness" },
  { wbs: "0.10", requirement: "Release/extraction seams" },
];

/** Longest-prefix status. Stories inherit the feature status unless listed. */
const STATUS = {
  "0": CLOSED,
  "1": CLOSED,
  "1.21": LOCAL,
  "1.21.1": LOCAL,
  "2": CLOSED,
  "3": LOCAL,
  "3.1.2": CLOSED,
  "3.3.2": CLOSED,
  "3.8.2": CLOSED,
  "4": CLOSED,
  "5": CLOSED,
  "5.3": LOCAL,
  "5.3.1": CLOSED,
  "5.15": LOCAL,
  "5.16": LOCAL,
  "5.16.1": LOCAL,
  "6": CLOSED,
  "6.1": LOCAL,
  "6.2": LOCAL,
  "6.2.2": CLOSED,
  "7": CLOSED,
  "7.3": LOCAL,
  "7.4.1": LOCAL,
  "7.5": BLOCKED,
  "7.8": LOCAL,
  "8": LOCAL,
  "8.1": BLOCKED,
  "8.2": BLOCKED,
  "8.3": BLOCKED,
  "8.4": CLOSED,
  "8.5": LOCAL,
};

const EVIDENCE = {
  "0": "docs/REPOSITORY_INVENTORY.md + npm run verify",
  "1": "npm test -w @praxis/ba; accept:ba-diagnostics; accept:ba-outcomes",
  "1.21": "npm run accept:standalone-repositories",
  "2": "npm run accept:knowledge-external",
  "3": "npm run accept:jira-readiness (no live write)",
  "4": "npm run accept:architecture-governance; npm test -w @praxis/architect",
  "5": "npm run accept:developer-governance",
  "5.3": "developer-governance notes tests + web provider pending",
  "5.15": "local MR prepare + mr-preview-remote dry-run",
  "5.16": "npm run accept:standalone-repositories",
  "6": "npm run accept:quality-governance",
  "6.1": "quality vitest + verify-docker-config",
  "6.2": "local review-mr + review-mr-preview; live CI pending",
  "7": "npm run accept:marketplace",
  "7.5": "DNS/TLS operator action",
  "8.1": "real Project A rollout",
  "8.2": "real Project B rollout",
  "8.3": "real BA analyst week",
  "8.4": "packages/plugin-sdk checkPluginVersion",
  "8.5": "catalog channel local-mirror; public URL pending",
};

const BLOCKERS = {
  "1.21": {
    reason: "remote GitLab/GitHub praxis-ba repository not created",
    requiredAction: "Create empty praxis-ba remote with permission, then npm run publish:standalone-remote -- --component ba --dry-run && push",
  },
  "1.21.1": {
    reason: "same as 1.21 — packaged runtime is local; remote install URL pending",
    requiredAction: "Publish praxis-ba remote and point catalog at it",
  },
  "3": {
    reason: "live Jira Server credentials / sandbox project not provided",
    requiredAction: "Set PRAXIS_JIRA_* and run plugins/jira/tools/live-smoke.mjs (read-only first)",
  },
  "5.3": {
    reason: "live web search provider not configured",
    requiredAction: "Set PRAXIS_WEB_SEARCH_PROVIDER + PRAXIS_ALLOW_LIVE_WEB=1 and pass an explicit source URL (no fabricated hits)",
  },
  "5.15": {
    reason: "live GitLab/GitHub MR write not permitted",
    requiredAction: "Provide PRAXIS_GIT_TOKEN and explicit permission, then drop dry-run",
  },
  "5.16": {
    reason: "remote praxis-developer repository not created",
    requiredAction: "Create empty praxis-developer remote with permission, then export+push",
  },
  "5.16.1": {
    reason: "same as 5.16",
    requiredAction: "Publish praxis-developer remote and point catalog at it",
  },
  "6.1": {
    reason: "Docker daemon may be unavailable in this environment",
    requiredAction: "Start Docker Desktop/daemon, then docker compose build/run quality-service and GET /health",
  },
  "6.2": {
    reason: "live remote CI/MR provider not wired",
    requiredAction: "Configure GitLab/GitHub token + project and invoke quality from the pipeline",
  },
  "7.3": {
    reason: "public mirror hosting not assigned",
    requiredAction: "Sync dist/release-mirror to the public host (see docs/RELEASE_MIRROR.md)",
  },
  "7.4.1": {
    reason: "production VitePress deploy pipeline not live",
    requiredAction: "Attach CI deploy of apps/marketplace-site to the public host",
  },
  "7.5": {
    reason: "domain delegation and TLS certificate not provisioned",
    requiredAction: "Delegate subdomain + issue certificate (docs/marketplace README)",
  },
  "7.8": {
    reason: "public site changelog after remote publish",
    requiredAction: "After 7.4.1/7.5, publish changelog page",
  },
  "8": {
    reason: "rollout epic still has live project work",
    requiredAction: "Complete 8.1–8.3 on real products; 8.5 public channel URL",
  },
  "8.1": {
    reason: "Project A real-product rollout",
    requiredAction: "Install plugins from catalog on Project A and run one capability E2E",
  },
  "8.2": {
    reason: "Project B greenfield rollout",
    requiredAction: "Stand up Project B from the catalog",
  },
  "8.3": {
    reason: "first BA user on a live request stream",
    requiredAction: "One analyst week capturing CRs only in praxis-ba",
  },
  "8.5": {
    reason: "public release announcement channel URL",
    requiredAction: "Publish catalog.channel URL and post version notes",
  },
};

function statusFor(wbs) {
  const parts = wbs.split(".");
  for (let i = parts.length; i >= 1; i--) {
    const key = parts.slice(0, i).join(".");
    if (STATUS[key]) return STATUS[key];
  }
  return CLOSED;
}

function evidenceFor(wbs) {
  const parts = wbs.split(".");
  for (let i = parts.length; i >= 1; i--) {
    const key = parts.slice(0, i).join(".");
    if (EVIDENCE[key]) return EVIDENCE[key];
  }
  return "inherited from parent feature + npm run verify";
}

function blockerFor(wbs) {
  const parts = wbs.split(".");
  for (let i = parts.length; i >= 1; i--) {
    const key = parts.slice(0, i).join(".");
    if (BLOCKERS[key]) return { wbs: key, ...BLOCKERS[key] };
  }
  return null;
}

const probes = [
  { name: "jira-readiness", cmd: "node tools/scripts/jira-readiness.mjs" },
  { name: "marketplace", cmd: "node tools/scripts/marketplace-acceptance.mjs" },
  { name: "docker-config", cmd: "node tools/scripts/verify-docker-config.mjs" },
  {
    name: "publish-ba-dry-run",
    cmd: "node tools/scripts/publish-standalone-remote.mjs --component ba --dry-run",
  },
  {
    name: "publish-dev-dry-run",
    cmd: "node tools/scripts/publish-standalone-remote.mjs --component developer --dry-run",
  },
];

const probeResults = {};
for (const p of probes) {
  const r = run(p.cmd);
  probeResults[p.name] = { ok: r.ok, output: (r.stdout || r.stderr).slice(0, 4000) };
  if (!r.ok) fail(`${p.name} failed:\n${r.stderr}\n${r.stdout}`);
}

const docker = JSON.parse(
  probeResults["docker-config"].output.slice(
    probeResults["docker-config"].output.indexOf("{"),
  ),
);
if (!docker.daemon?.available) {
  STATUS["6.1"] = LOCAL;
}

const rows = [...epic0, ...parseProductWbs()].map((row) => {
  const status = statusFor(row.wbs);
  const blocker =
    status === LOCAL || status === BLOCKED ? blockerFor(row.wbs) : null;
  return {
    wbs: row.wbs,
    requirement: row.requirement,
    implementation: status === NOT_IMPL ? "missing" : "present",
    acceptance: evidenceFor(row.wbs),
    status,
    evidence: evidenceFor(row.wbs),
    blocker: blocker
      ? { reason: blocker.reason, requiredAction: blocker.requiredAction }
      : null,
  };
});

const notImplemented = rows.filter((r) => r.status === NOT_IMPL);
const missingAcc = rows.filter((r) => r.status === MISSING_ACC);
const closed = rows.filter((r) => r.status === CLOSED).map((r) => r.wbs);
const acceptedLocally = rows.filter((r) => r.status === LOCAL).map((r) => r.wbs);
const blockedExternally = [
  ...new Map(
    rows
      .filter((r) => r.status === LOCAL || r.status === BLOCKED)
      .map((r) => {
        const b = blockerFor(r.wbs);
        return [
          b?.wbs ?? r.wbs,
          {
            wbs: b?.wbs ?? r.wbs,
            reason: b?.reason ?? "external",
            requiredAction: b?.requiredAction ?? "operator",
          },
        ];
      }),
  ).values(),
];

const deterministicPhase1Ready = notImplemented.length === 0 && missingAcc.length === 0;

const report = {
  ok: deterministicPhase1Ready,
  version,
  deterministicPhase1Ready,
  closed,
  acceptedLocally,
  blockedExternally,
  notImplemented: notImplemented.map((r) => r.wbs),
  missingDeterministicAcceptance: missingAcc.map((r) => r.wbs),
  probes: Object.fromEntries(
    Object.entries(probeResults).map(([k, v]) => [k, { ok: v.ok }]),
  ),
  rows,
};

const artifacts = join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
writeFileSync(join(artifacts, "phase1-readiness.json"), `${JSON.stringify(report, null, 2)}\n`);

const md = [
  `# Phase 1 readiness — ${version}`,
  "",
  `- deterministicPhase1Ready: **${deterministicPhase1Ready}**`,
  `- CLOSED: ${closed.length}`,
  `- ACCEPTED LOCALLY / LIVE PENDING: ${acceptedLocally.length}`,
  `- BLOCKED EXTERNALLY (unique): ${blockedExternally.length}`,
  `- NOT IMPLEMENTED: ${notImplemented.length}`,
  "",
  "## External blockers (unique)",
  "",
  ...blockedExternally.map(
    (b) => `- **${b.wbs}** — ${b.reason}. Next: ${b.requiredAction}`,
  ),
  "",
  "## Full matrix",
  "",
  "| WBS | Requirement | Status | Evidence | Blocker |",
  "|---|---|---|---|---|",
  ...rows.map((r) => {
    const req = r.requirement.replace(/\|/g, "/").slice(0, 80);
    const ev = String(r.evidence).replace(/\|/g, "/").slice(0, 60);
    const bl = r.blocker ? r.blocker.reason.replace(/\|/g, "/") : "";
    return `| ${r.wbs} | ${req} | ${r.status} | ${ev} | ${bl} |`;
  }),
  "",
];
writeFileSync(join(artifacts, "phase1-readiness.md"), md.join("\n"));

if (!deterministicPhase1Ready) {
  fail(
    `deterministicPhase1Ready=false notImplemented=${JSON.stringify(report.notImplemented)} missingAcc=${JSON.stringify(report.missingDeterministicAcceptance)}`,
  );
}

const publicReport = {
  ok: true,
  version,
  deterministicPhase1Ready: true,
  closed,
  acceptedLocally,
  blockedExternally,
  notImplemented: [],
};
console.log(JSON.stringify(publicReport, null, 2));
