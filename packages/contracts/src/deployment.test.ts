import { describe, expect, it } from "vitest";
import { assertSecureDeploymentAssessment, assessApprovalDeployment, type DeploymentProbe } from "./index.js";

const ME = 501;
/** A probe describing an isolated deployment unless a case changes it. */
function probe(over: Partial<{ writable: string[]; readable: string[]; stats: Record<string, { uid: number; mode: number }> }> = {}): DeploymentProbe {
  return {
    uid: () => ME,
    stat: (path) => over.stats?.[path] ?? null,
    canWrite: (path) => over.writable?.includes(path) ?? false,
    canRead: (path) => over.readable?.includes(path) ?? false,
  };
}

const isolatedEnv = {
  PRAXIS_APPROVAL_PUBLIC_KEY_PATH: "/etc/praxis/approval.pub",
  PRAXIS_APPROVAL_LEDGER: "/var/lib/praxis/ledger",
};
const ids = (a: ReturnType<typeof assessApprovalDeployment>) => a.findings.filter((f) => f.severity === "blocking").map((f) => f.id).sort();

describe("assessApprovalDeployment", () => {
  it("a broker whose key, ledger and directory the agent cannot touch is isolated", () => {
    const result = assessApprovalDeployment({
      env: { ...isolatedEnv, PRAXIS_BROKER_TRUSTED_DIR: "/var/lib/praxis/trusted" },
      probe: probe({ stats: { "/var/lib/praxis/trusted": { uid: 999, mode: 0o40700 } } }),
      dockerSockets: [],
    });
    expect(result).toMatchObject({ tier: "isolated", secureOperation: true });
    expect(ids(result)).toEqual([]);
  });

  it("compatibility mode is never secure", () => {
    const result = assessApprovalDeployment({ env: { PRAXIS_SECURITY_MODE: "compatibility" }, probe: probe() });
    expect(result).toMatchObject({ tier: "compatibility", secureOperation: false });
  });

  it("a junk mode fails closed", () => {
    expect(assessApprovalDeployment({ env: { PRAXIS_SECURITY_MODE: "off" }, probe: probe() })).toMatchObject({ tier: "invalid", secureOperation: false });
  });

  it("secure mode with no broker configured is unconfigured: protected writes fail closed", () => {
    const result = assessApprovalDeployment({ env: {}, probe: probe(), dockerSockets: [] });
    expect(result).toMatchObject({ tier: "unconfigured", secureOperation: false });
    expect(ids(result)).toEqual(["broker-not-configured"]);
  });

  it("regression: a Claude Desktop style deployment is not called secure", () => {
    // Public key passed through the extension settings, ledger and broker dir owned by the same user.
    const result = assessApprovalDeployment({
      env: {
        PRAXIS_APPROVAL_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\nxx\n-----END PUBLIC KEY-----",
        PRAXIS_APPROVAL_LEDGER: "/Users/me/ledger",
        PRAXIS_BROKER_TRUSTED_DIR: "/Users/me/broker",
      },
      probe: probe({ writable: ["/Users/me/ledger", "/Users/me", "/Users/me/broker"], stats: { "/Users/me/broker": { uid: ME, mode: 0o40700 } } }),
      dockerSockets: [],
    });
    expect(result.secureOperation).toBe(false);
    expect(result.tier).toBe("unisolated");
    expect(ids(result)).toEqual(["broker-directory-writable", "broker-same-identity", "ledger-writable", "trust-anchor-unverifiable"]);
  });

  it("flags each way the agent can reach the trust chain", () => {
    const base = { env: isolatedEnv, dockerSockets: [] as string[] };
    expect(ids(assessApprovalDeployment({ ...base, probe: probe({ writable: ["/etc/praxis/approval.pub"] }) }))).toEqual(["trust-anchor-writable"]);
    expect(ids(assessApprovalDeployment({ ...base, probe: probe({ writable: ["/etc/praxis"] }) }))).toEqual(["trust-anchor-writable"]);
    expect(ids(assessApprovalDeployment({ ...base, probe: probe({ writable: ["/var/lib/praxis"] }) }))).toEqual(["ledger-writable"]);
    expect(
      ids(assessApprovalDeployment({ env: { ...isolatedEnv, PRAXIS_APPROVAL_PRIVATE_KEY_PATH: "/k/private.pem" }, dockerSockets: [], probe: probe({ readable: ["/k/private.pem"] }) })),
    ).toEqual(["signing-key-visible"]);
    expect(ids(assessApprovalDeployment({ env: { ...isolatedEnv, PRAXIS_APPROVAL_PRIVATE_KEY: "pem" }, dockerSockets: [], probe: probe() }))).toEqual(["signing-key-visible"]);
  });

  it("a ledger inside the agent's workspace is agent-controlled", () => {
    const result = assessApprovalDeployment({
      env: { ...isolatedEnv, PRAXIS_APPROVAL_LEDGER: "/work/repo/.praxis/ledger" },
      workspace: "/work/repo",
      probe: probe(),
      dockerSockets: [],
    });
    expect(ids(result)).toEqual(["ledger-writable"]);
  });

  it("docker control is a warning on its own and blocking when a docker-uid deployment is claimed", () => {
    const sock = "/var/run/docker.sock";
    const reach = probe({ readable: [sock], writable: [sock] });
    const plain = assessApprovalDeployment({ env: isolatedEnv, probe: reach, dockerSockets: [sock] });
    expect(plain.tier).toBe("isolated");
    expect(plain.findings.find((f) => f.id === "docker-control")?.severity).toBe("warning");
    expect(plain.observed.dockerSocketReachable).toBe(true);
    const claimed = assessApprovalDeployment({ env: { ...isolatedEnv, PRAXIS_DEPLOYMENT_MODEL: "docker-uid" }, probe: reach, dockerSockets: [sock] });
    expect(claimed).toMatchObject({ tier: "unisolated", secureOperation: false });
  });

  it("the test-harness override is reported and never yields a secure tier", () => {
    const result = assessApprovalDeployment({ env: { ...isolatedEnv, PRAXIS_TEST_ALLOW_SAME_IDENTITY: "1" }, probe: probe(), dockerSockets: [] });
    expect(result).toMatchObject({ tier: "unisolated", secureOperation: false });
    expect(result.observed.testHarnessOverride).toBe(true);
  });

  it("assertSecureDeploymentAssessment throws with the reasons unless secure", () => {
    const bad = assessApprovalDeployment({ env: {}, probe: probe(), dockerSockets: [] });
    expect(() => assertSecureDeploymentAssessment(bad)).toThrow(/unconfigured deployment \(broker-not-configured\)/);
    try {
      assertSecureDeploymentAssessment(bad);
    } catch (error) {
      expect((error as { code?: string }).code).toBe("APPROVAL_ISOLATION_UNAVAILABLE");
    }
    const good = assessApprovalDeployment({ env: isolatedEnv, probe: probe(), dockerSockets: [] });
    expect(() => assertSecureDeploymentAssessment(good)).not.toThrow();
  });

  it("never reports secret values", () => {
    const secret = "TOP-SECRET-PEM-BODY";
    const result = assessApprovalDeployment({ env: { PRAXIS_APPROVAL_PRIVATE_KEY: secret, PRAXIS_APPROVAL_PUBLIC_KEY: secret }, probe: probe(), dockerSockets: [] });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
