import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CI on a loaded shared runner sets PRAXIS_TEST_TIMEOUT_MS; the default (vitest's 5 s) is unchanged everywhere else.
    testTimeout: Number(process.env.PRAXIS_TEST_TIMEOUT_MS) || 5000,
    // Absolute path: workspace runs (`npm test -w ...`) resolve relative paths against their own cwd.
    setupFiles: [fileURLToPath(new URL("./vitest.setup.ts", import.meta.url))],
  },
});
