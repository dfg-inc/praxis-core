// Agent-side helper for the macOS acceptance. Runs as the ordinary (agent) user: it can only do what the IPC allows.
//   node client.mjs health | assess | submit-commit <repo> <message> <path>... | submit-push <repo> <branch> | status <requestId> | execute <requestId>
//   Env: PRAXIS_APPROVAL_SERVICE_ENDPOINT (default: the platform endpoint), PRAXIS_CORE (path of the praxis-core checkout), EXECUTION_ID
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const core = process.env.PRAXIS_CORE ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const { assessApprovalService, callApprovalService, serviceEndpoint } = await import(pathToFileURL(join(core, "packages/contracts/dist/index.js")).href);
const [cmd, ...rest] = process.argv.slice(2);
const endpoint = serviceEndpoint();
const out = (value) => console.log(JSON.stringify(value, null, 2));
const ex = process.env.EXECUTION_ID ? { executionId: process.env.EXECUTION_ID } : {};
try {
  if (cmd === "health") out(await callApprovalService({ op: "health" }, { endpoint, timeoutMs: 5000 }));
  else if (cmd === "assess") out(await assessApprovalService({ endpoint, timeoutMs: 5000 }));
  else if (cmd === "submit-commit") {
    const [repo, message, ...paths] = rest;
    out(await callApprovalService({ op: "submit", operation: "git_commit", repository: repo, workItemId: "WI-ACCEPTANCE", params: { message, branch: process.env.BRANCH ?? "acceptance/touch-id", paths }, ...ex }, { endpoint }));
  } else if (cmd === "submit-push") {
    out(await callApprovalService({ op: "submit", operation: "git_push", repository: rest[0], workItemId: "WI-ACCEPTANCE", params: { remote: "origin", branch: rest[1] }, ...ex }, { endpoint }));
  } else if (cmd === "status") out(await callApprovalService(rest[0].startsWith("ex-") ? { op: "status", executionId: rest[0] } : { op: "status", requestId: rest[0] }, { endpoint }));
  else if (cmd === "execute") out(await callApprovalService({ op: "execute", requestId: rest[0] }, { endpoint }));
  else if (cmd === "raw") out(await callApprovalService(JSON.parse(rest[0]), { endpoint }));
  else {
    console.error("usage: client.mjs health|assess|submit-commit|submit-push|status|execute|raw");
    process.exit(2);
  }
} catch (error) {
  out({ ok: false, code: error.code ?? "ERROR", message: error.message });
  process.exit(1);
}
