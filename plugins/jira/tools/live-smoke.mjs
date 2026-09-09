#!/usr/bin/env node
/**
 * Safe Jira live smoke (WBS 3.x readiness).
 *
 * Default mode is READ+PREVIEW only — never mutates.
 * Mutation path requires BOTH:
 *   --allow-mutate
 *   --confirm-mutate YES
 * and creates a disposable smoke issue, reads it back, then does NOT delete
 * (deletion may lack permission); prints key for operator cleanup.
 *
 * Env (see docs/JIRA_LIVE.md):
 *   PRAXIS_JIRA_BASE_URL
 *   PRAXIS_JIRA_TOKEN
 *   PRAXIS_JIRA_PROJECT_KEY
 *   PRAXIS_JIRA_ARCHITECT_ESTIMATE_FIELD (optional)
 *   PRAXIS_JIRA_SMOKE_FEATURE_KEY (optional — existing feature for read-back)
 *
 * Usage:
 *   node plugins/jira/tools/live-smoke.mjs
 *   node plugins/jira/tools/live-smoke.mjs --allow-mutate --confirm-mutate YES
 */
import { JiraClient } from "../dist/index.js";

const args = process.argv.slice(2);
function has(name) {
  return args.includes(name);
}
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const allowMutate = has("--allow-mutate");
const confirmMutate = flag("--confirm-mutate");

async function main() {
  const client = new JiraClient();
  const steps = [];

  // 1) connect
  const me = await client.verifyConnection();
  steps.push({
    step: "connect",
    ok: me.ok !== false,
    displayName: me.displayName,
    version: me.version,
    patSupported: me.patSupported,
    guidance: me.guidance,
  });
  if (me.ok === false) {
    console.log(JSON.stringify({ ok: false, mode: "unsupported-pat", steps }, null, 2));
    process.exit(1);
  }

  // 2) read (optional existing feature, or search project via myself only)
  const featureKey =
    flag("--feature") ?? process.env.PRAXIS_JIRA_SMOKE_FEATURE_KEY;
  if (featureKey) {
    const statuses = await client.readFeatureStatuses(featureKey);
    steps.push({ step: "read", ok: true, statuses });
  } else {
    steps.push({
      step: "read",
      ok: true,
      detail: "skipped (set PRAXIS_JIRA_SMOKE_FEATURE_KEY or --feature)",
    });
  }

  // 3) preview (no write)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const preview = client.createStoryPreview({
    summary: `[praxis-smoke] disposable ${stamp}`,
    acceptanceCriteria:
      "Given smoke ran\nWhen issue exists\nThen summary contains praxis-smoke",
  });
  steps.push({ step: "preview", ok: true, preview });

  // 4–6) confirmation + mutation + read-back — gated
  if (!allowMutate) {
    steps.push({
      step: "mutation",
      ok: true,
      executed: false,
      detail: "dry-run only; pass --allow-mutate --confirm-mutate YES to write",
    });
    console.log(JSON.stringify({ ok: true, mode: "dry-run", steps }, null, 2));
    return;
  }
  if (confirmMutate !== "YES") {
    console.error(
      "Refusing mutate: require --confirm-mutate YES (exact) together with --allow-mutate",
    );
    process.exit(2);
  }

  const result = await client.createStory(
    {
      summary: `[praxis-smoke] disposable ${stamp}`,
      acceptanceCriteria:
        "Given smoke ran\nWhen issue exists\nThen summary contains praxis-smoke",
    },
    async (p) => {
      console.error("CONFIRMING mutation preview:", p.summary);
      return true;
    },
  );
  if (!result.executed) {
    steps.push({ step: "mutation", ok: false, executed: false });
    console.log(JSON.stringify({ ok: false, mode: "mutate", steps }, null, 2));
    process.exit(1);
  }
  const key = result.result.key;
  steps.push({ step: "mutation", ok: true, executed: true, key });

  const readBack = await client.getIssue(key);
  steps.push({
    step: "read-back",
    ok: true,
    key: readBack.key,
    summary: readBack.fields?.summary,
    status: readBack.fields?.status?.name,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "mutate",
        cleanupHint: `Manually close/delete ${key} in Jira if desired`,
        steps,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
