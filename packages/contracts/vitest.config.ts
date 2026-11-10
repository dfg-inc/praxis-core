import { defineConfig } from "vitest/config";

// The test harness stands in for the client's approval dialog (createUserApproval channel "test"); a shipped bundle never
// accepts it. Tests that check the refusal without the harness unset it themselves.
export default defineConfig({ test: { env: { PRAXIS_TEST_APPROVALS: "1" } } });
