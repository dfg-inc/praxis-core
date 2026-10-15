#!/usr/bin/env node
/**
 * Protected operator console. Connects to the broker operator Unix socket inside
 * the trusted directory. The agent UID cannot open that socket.
 *
 * TTY alone is not authentication — possession of a reachable broker operator
 * socket under the broker identity is the boundary.
 */
import { createConnection } from "node:net";
import { accessSync, constants, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";

function mustEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function request(socketPath, message) {
  return new Promise((resolvePromise, reject) => {
    const client = createConnection(socketPath);
    let buf = "";
    client.on("connect", () => {
      client.write(`${JSON.stringify(message)}\n`);
    });
    client.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        client.end();
        try {
          resolvePromise(JSON.parse(line));
        } catch (error) {
          reject(error);
        }
      }
    });
    client.on("error", reject);
  });
}

async function main() {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("operator console requires a real operator TTY");
  }
  const trusted = resolve(mustEnv("PRAXIS_BROKER_TRUSTED_DIR"));
  const socketPath = join(trusted, "operator.sock");
  if (!existsSync(socketPath)) {
    throw new Error(`operator socket missing: ${socketPath}; start praxis-broker.mjs serve-operator`);
  }
  try {
    accessSync(socketPath, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error("cannot access operator socket — wrong identity for human approval");
  }

  const planId = arg("--plan-id");
  if (!planId) throw new Error("--plan-id is required");
  const approver = arg("--approver") || process.env.USER || "operator";

  const shown = await request(socketPath, { cmd: "show", planId });
  if (!shown.ok) throw new Error(shown.error || "show failed");
  output.write(`${shown.text}\n\n`);
  output.write(`Fingerprint: ${shown.fingerprint}\n`);
  output.write(`Type exactly: APPROVE ${shown.fingerprint}\n`);
  output.write("Or type REJECT\n");

  const rl = createInterface({ input, output, terminal: true });
  const answer = await new Promise((resolvePromise) => {
    rl.question("> ", (line) => {
      rl.close();
      resolvePromise(String(line || "").trim());
    });
  });

  if (answer === "REJECT" || answer === "reject") {
    const rejected = await request(socketPath, { cmd: "reject", planId, approver });
    console.log(JSON.stringify(rejected));
    return;
  }
  if (answer !== `APPROVE ${shown.fingerprint}`) {
    throw new Error("confirmation did not match the exact plan fingerprint");
  }
  const approved = await request(socketPath, {
    cmd: "approve",
    planId,
    approver,
    fingerprint: shown.fingerprint,
  });
  console.log(JSON.stringify(approved));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
