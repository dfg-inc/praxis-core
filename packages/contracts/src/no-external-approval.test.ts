import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Approval is the user's, in the MCP client. Nothing may depend on a separate daemon, an OS account, an installer, a
 * signing key store or a WebAuthn page again: this fails if the source grows one back.
 */
const root = resolve(import.meta.dirname, "../../..");
const FORBIDDEN: Array<[RegExp, string]> = [
  [/PRAXIS_BROKER/, "the approval broker"],
  [/PRAXIS_SECURITY_MODE/, "the security mode switch"],
  [/PRAXIS_APPROVAL_(PUBLIC_KEY|PRIVATE_KEY|LEDGER|AUTHORIZATION|SERVICE_ENDPOINT)/, "signed authorizations or the approval service endpoint"],
  [/approval[-_ ]service/i, "the Approval Service"],
  [/LaunchDaemon|systemctl|New-Service|launchctl (bootstrap|bootout|kickstart|load|print)/, "an OS service manager"],
  [/_praxisapproval/, "the service account"],
  [/webauthn|navigator\.credentials/i, "WebAuthn"],
  [/\bsudo\b/, "administrator rights"],
];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|mjs|cjs|js|json|sh|yml)$/.test(name) && !/\.test\.(ts|mjs)$/.test(name) && !/package-lock\.json$/.test(name)) out.push(path);
  }
  return out;
}

describe("no mandatory external approval component", () => {
  const files = ["packages", "plugins", "tools", ".github"].flatMap((dir) => {
    try {
      return sources(join(root, dir));
    } catch {
      return [];
    }
  });

  it("scans the source of the packages, plugins and tools", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const [pattern, what] of FORBIDDEN) {
    it(`no source depends on ${what}`, () => {
      const hits = files.filter((file) => pattern.test(readFileSync(file, "utf8"))).map((file) => relative(root, file));
      expect(hits).toEqual([]);
    });
  }
});
