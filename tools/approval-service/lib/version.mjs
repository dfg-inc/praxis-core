import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* __PRAXIS_VERSION__ is replaced at build time in the packaged bundle; from source it is read from the core package. */
export const SERVICE_VERSION =
  typeof __PRAXIS_VERSION__ !== "undefined"
    ? __PRAXIS_VERSION__
    : (() => {
        try {
          return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../package.json"), "utf8")).version;
        } catch {
          return "0.0.0-unknown";
        }
      })();
