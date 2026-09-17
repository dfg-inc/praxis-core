#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname } from "node:path";

export function encodeMcpFrame(msg) {
  const json = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, json]);
}

export function readMcpMessages(buffer) {
  const messages = [];
  let rest = buffer;
  while (rest.length) {
    const parsed = readOne(rest);
    if (!parsed) break;
    rest = parsed.rest;
    if (parsed.msg) messages.push(parsed.msg);
  }
  return { messages, rest };
}

function readOne(buffer) {
  const text = buffer.toString("utf8");
  const headerMatch = text.match(/^Content-Length:\s*(\d+)\r\n\r\n/i);
  if (headerMatch) {
    const headerBytes = Buffer.byteLength(headerMatch[0], "utf8");
    const length = Number(headerMatch[1]);
    if (buffer.length < headerBytes + length) return null;
    const json = buffer.slice(headerBytes, headerBytes + length).toString("utf8");
    return { msg: JSON.parse(json), rest: buffer.slice(headerBytes + length) };
  }
  const lf = buffer.indexOf(0x0a);
  if (lf < 0) return null;
  const line = buffer.slice(0, lf).toString("utf8").replace(/\r$/, "").trim();
  const rest = buffer.slice(lf + 1);
  if (!line) return { msg: null, rest };
  if (line.startsWith("Content-Length:")) return null;
  return { msg: JSON.parse(line), rest };
}

export function spawnMcpServer({ command, args, cwd, env, timeoutMs = 20000 }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = Buffer.alloc(0);
  let stderr = "";
  const pending = new Map();
  let nextId = 1;
  let closed = false;

  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  child.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const parsed = readMcpMessages(buf);
    buf = parsed.rest;
    for (const msg of parsed.messages) {
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  function request(method, params) {
    const id = nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timeout ${method}\nstderr: ${stderr}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
      child.stdin.write(encodeMcpFrame(msg));
    });
  }

  function notify(method, params) {
    child.stdin.write(encodeMcpFrame({ jsonrpc: "2.0", method, params }));
  }

  async function close() {
    if (closed) return;
    closed = true;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    child.kill("SIGTERM");
    await new Promise((r) => {
      const t = setTimeout(r, 2000);
      child.once("exit", () => {
        clearTimeout(t);
        r();
      });
    });
  }

  return {
    request,
    notify,
    close,
    stderr: () => stderr,
    child,
    nodeDir: dirname(process.execPath),
  };
}

export async function mcpInitializeAndList(client, versionHint) {
  const init = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "praxis-hosted-acceptance", version: versionHint || "0.0.0" },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  client.notify("notifications/initialized", {});
  const list = await client.request("tools/list", {});
  if (list.error) throw new Error(`tools/list failed: ${JSON.stringify(list.error)}`);
  return {
    initialize: init.result,
    tools: list.result?.tools ?? [],
  };
}
