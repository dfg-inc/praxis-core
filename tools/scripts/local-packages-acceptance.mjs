#!/usr/bin/env node
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_WORKSPACES,
  installTest,
  packReleaseLocal,
} from "./local-packages.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  .version;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

packReleaseLocal(root, pkgVersion);
const consumer = mkdtempSync(join(tmpdir(), "praxis-ext-"));
if (consumer.startsWith(root)) fail("consumer must be outside monorepo");
writeFileSync(
  join(consumer, "package.json"),
  `${JSON.stringify({ name: "praxis-clean-consumer", private: true, type: "module" }, null, 2)}\n`,
);
const result = installTest({
  root,
  version: pkgVersion,
  testRepo: consumer,
});
console.log(
  JSON.stringify(
    {
      ok: true,
      source: "clean-external-tempdir",
      version: pkgVersion,
      packages: ALL_WORKSPACES.map((n) => `${n}@${pkgVersion}`),
      testRepo: result.testRepo,
    },
    null,
    2,
  ),
);
