// Runs AS THE AGENT USER inside the acceptance container: one IPC call, prints the reply as JSON.
import { assessApprovalService, callApprovalService } from "/core/packages/contracts/dist/index.js";
const [endpoint, mode, payload] = process.argv.slice(2);
try {
  if (mode === "assess") console.log(JSON.stringify(await assessApprovalService({ endpoint, timeoutMs: 3000 })));
  else console.log(JSON.stringify(await callApprovalService(JSON.parse(payload), { endpoint, timeoutMs: 60000 })));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code ?? "ERROR", message: error.message }));
}
