#!/usr/bin/env node
/**
 * LINUX-CONTAINER acceptance of the Linux package, run from the build host (needs Docker and the image named below).
 * What it proves: the installer, upgrade, rollback, uninstall and the user/permission boundary on a REAL LINUX KERNEL
 * with separate uids (root, praxis-approval, agent), the service in production mode with verified isolation, and the
 * full approve/reject/replay flow. What it does NOT prove: systemd behaviour (unit sandboxing, socket directory
 * creation, restart policy), a real Touch ID/security key (a software authenticator signs), or anything about macOS
 * or Windows. A container shares the host kernel's namespaces differently from a VM or bare metal; label it so.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const core = resolve(here, "../../..");
const image = process.env.PRAXIS_LINUX_IMAGE ?? "node:22-bookworm";
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();

try {
  sh("docker", ["image", "inspect", image]);
} catch {
  console.log(`BLOCKED linux-container: Docker image ${image} is not available locally (no image is pulled by this script)`);
  process.exit(2);
}
const arch = { aarch64: "arm64", x86_64: "x64" }[sh("docker", ["run", "--rm", image, "uname", "-m"])];
const nodeVersion = sh("docker", ["run", "--rm", image, "node", "--version"]);
const work = mkdtempSync(join(tmpdir(), "praxis-lx-"));
const nodeBin = join(work, "node");
const cid = sh("docker", ["create", image]);
try {
  sh("docker", ["cp", `${cid}:/usr/local/bin/node`, nodeBin]);
} finally {
  sh("docker", ["rm", cid]);
}
const build = (env) =>
  JSON.parse(
    // built into a scratch directory: this must never replace the release package under dist/approval-service/production
    execFileSync(process.execPath, [join(core, "tools/approval-service/packaging/build.mjs"), "--variant", "production", "--linux-tar", "--linux-node", nodeBin, "--linux-arch", arch, "--linux-node-version", nodeVersion], { encoding: "utf8", env: { ...process.env, PRAXIS_BUILD_OUT: mkdtempSync(join(work, "out-")), ...env } }),
  );
const v1 = build({});
const v2 = build({ PRAXIS_BUILD_VERSION_OVERRIDE: "99.0.0-acceptance" });
const extract = (tar) => {
  const dir = mkdtempSync(join(work, "x-"));
  execFileSync("tar", ["-xzf", tar, "-C", dir]);
  return dir;
};
const d1 = extract(v1.linuxTar);
const d2 = extract(v2.linuxTar);
console.log(`built ${readdirSync(d1)[0]} and ${readdirSync(d2)[0]} (${arch}, Node ${nodeVersion} from ${image})`);
const run = spawnSync("docker", ["run", "--rm", "-v", `${d1}:/pkg:ro`, "-v", `${d2}:/pkg2:ro`, "-v", `${core}:/core:ro`, image, "bash", "/core/tools/approval-service/acceptance/linux-container.sh"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
rmSync(work, { recursive: true, force: true });
process.exit(run.status ?? 1);
