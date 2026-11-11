import { defineConfig, mergeConfig } from "vitest/config";
import root from "../../vitest.config.js";

// The repository's settings (CI's test timeout, the shared setup file) plus the test harness standing in for the client's
// approval dialog (createUserApproval channel "test"); a shipped bundle never accepts it. Tests that check the refusal
// without the harness unset it themselves.
export default mergeConfig(root, defineConfig({ test: { env: { PRAXIS_TEST_APPROVALS: "1" } } }));
