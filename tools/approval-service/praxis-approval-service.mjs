#!/usr/bin/env node
/**
 * Praxis Approval Service.
 *
 *   run --config <file>            serve (as the service principal; production fails closed without verified isolation)
 *   health [--endpoint <path>]     ask a running service for its health (what the Runtime's doctor reports)
 *   verify-isolation --config <f>  run the platform isolation probe as the current identity and print every check
 *   enroll-code --config <file>    open a 15 minute window to enroll Touch ID / Windows Hello / a security key
 *   audit-verify --config <file>   verify the hash chain of the audit log
 *   install-plan | uninstall-plan [--platform darwin|linux|win32] [--json]   the exact steps, as data; never executed here
 *   render-unit [--platform ...]   the launchd plist / systemd unit / Windows registration script
 *   allow-repo <path> [--platform ...]   what the owner must do to let the service write to one repository
 *
 * No command here approves, signs or executes a privileged installation.
 */
import { createHash } from "node:crypto";
import { platform as osPlatform } from "node:os";
import { callApprovalService, defaultServiceEndpoint } from "../../packages/contracts/dist/index.js";
import { adapterFor } from "./platform/index.mjs";
import { loadConfig } from "./lib/config.mjs";
import { createService } from "./lib/service.mjs";
import { openEnrollmentWindow } from "./lib/enroll.mjs";
import { SERVICE_VERSION } from "./lib/version.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const os = flag("--platform") ?? osPlatform();
const print = (value) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

async function main() {
  if (cmd === "run") {
    const file = flag("--config");
    if (!file) throw new Error("--config is required");
    const { adapter, paths, config } = loadConfig(file, os);
    const service = await createService({ paths, config, mode: config.mode, version: SERVICE_VERSION, platformId: adapter.defaults().id, probe: (ctx) => adapter.probe(ctx) });
    await service.listen();
    console.log(JSON.stringify({ ok: true, listening: paths.endpoint, operator: service.web ? `http://127.0.0.1:${service.operatorPort()}` : undefined, mode: config.mode, version: SERVICE_VERSION }));
    const stop = () => service.close().finally(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    return;
  }
  if (cmd === "health") {
    const reply = await callApprovalService({ op: "health" }, { endpoint: flag("--endpoint") ?? defaultServiceEndpoint(os), timeoutMs: 5000 });
    print(reply);
    process.exit(reply.ok ? 0 : 1);
  }
  if (cmd === "verify-isolation") {
    const { adapter, paths, config } = loadConfig(flag("--config"), os);
    const checks = adapter.probe({ paths, config });
    print({ platform: adapter.defaults().id, principal: config.principal, verified: checks.every((c) => c.ok), checks });
    process.exit(checks.every((c) => c.ok) ? 0 : 1);
  }
  if (cmd === "enroll-code") {
    const { paths, config } = loadConfig(flag("--config"), os);
    const origin = config.operator?.origin ?? `http://localhost:${config.operator?.port ?? 8780}`;
    const { code, minutes } = openEnrollmentWindow(paths.stateDir, origin);
    print(`Enrollment code (valid ${minutes} minutes, one authenticator): ${code}\nOpen ${origin}/enroll on the machine whose authenticator you will enroll, and type the code there.`);
    return process.exit(0);
  }
  if (cmd === "audit-verify" || cmd === "audit-witness") {
    const { paths, config } = loadConfig(flag("--config"), os);
    const { createAudit } = await import("./lib/audit.mjs");
    const { createAnchors, verifyWitness } = await import("./lib/anchor.mjs");
    const { readFileSync } = await import("node:fs");
    const audit = createAudit(`${paths.stateDir}/audit/chain.jsonl`);
    const anchors = createAnchors({ sinks: [`${paths.stateDir}/anchors`, ...(config.auditAnchorDirs ?? [])], privateKeyPem: readFileSync(`${paths.stateDir}/trusted/private.pem`, "utf8"), publicKeyPem: readFileSync(`${paths.stateDir}/trusted/public.pem`, "utf8"), audit, ledgerDir: `${paths.stateDir}/ledger` });
    if (cmd === "audit-witness") {
      // A signed statement of the current head. Store it OFF this machine (or where the service identity cannot write): it is the pin an attacker holding the whole state directory cannot rewrite.
      print(anchors.exportWitness());
      return;
    }
    const result = anchors.check();
    const witnessFile = flag("--witness");
    if (witnessFile) {
      const witness = verifyWitness(JSON.parse(readFileSync(witnessFile, "utf8")), audit.entries());
      if (!witness.ok) result.problems.push(...witness.problems.map((p) => `witness: ${p}`));
      result.ok = result.ok && witness.ok;
    }
    print({ ...result, entries: audit.entries().length });
    process.exit(result.ok ? 0 : 1);
  }
  if (cmd === "install-plan" || cmd === "uninstall-plan") {
    const adapter = adapterFor(os);
    const steps = cmd === "install-plan" ? adapter.installPlan() : adapter.uninstallPlan();
    if (args.includes("--json")) return print({ platform: adapter.defaults().id, status: adapter.status, steps });
    print(`${adapter.status.os}: ${adapter.status.artifact}\nStatus: ${adapter.status.tested}\n`);
    for (const [i, step] of steps.entries()) print(`${i + 1}. [${step.privileged ? "ADMIN" : "user"}] ${step.description}\n     ${step.command}`);
    return;
  }
  if (cmd === "render-unit") return print(adapterFor(os).renderUnit());
  if (cmd === "allow-repo") {
    const repo = args[1];
    if (!repo) throw new Error("allow-repo <path> is required");
    const adapter = adapterFor(os);
    const principal = adapter.defaults().principal;
    const id = createHash("sha256").update(repo).digest("hex").slice(0, 8);
    print(`To let the approval service operate on ${repo} (an administrator runs these; Praxis never does):\n` +
      `1. Add to the "repositories" array in ${adapter.defaults().configFile}:\n   { "path": ${JSON.stringify(repo)}, "remotes": { "origin": "<exact remote URL>" }, "branches": ["feature/*"], "provider": { "kind": "github", "instanceId": "<host/owner/repo>" } }\n` +
      (os === "darwin" ? `2. chmod -R +a "${principal} allow list,add_file,search,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,file_inherit,directory_inherit" "${repo}/.git"\n` : os === "linux" ? `2. setfacl -R -m u:${principal}:rwX -d -m u:${principal}:rwX "${repo}/.git"\n` : `2. icacls "${repo}\\.git" /grant "${principal}:(OI)(CI)M"\n`) +
      `   (ref ${id}) This grants write access to .git only; the service also refuses repositories whose Git configuration can run code.`);
    return;
  }
  console.error("usage: praxis-approval-service.mjs run|health|verify-isolation|enroll-code|audit-verify|audit-witness|install-plan|uninstall-plan|render-unit|allow-repo");
  process.exit(2);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, code: error.code ?? "ERROR", error: error.message }));
  process.exit(1);
});
