import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The shipped text of a macOS script: the shared library is inlined at the marker, placeholders are filled. */
export function renderMacScript(file, { arch = "@ARCH@", version = "@VERSION@" } = {}) {
  const lib = readFileSync(join(here, "macos-lib.sh"), "utf8");
  return readFileSync(join(here, file), "utf8").replace("# @@LIB@@", lib).replaceAll("@ARCH@", arch).replaceAll("@VERSION@", version);
}
