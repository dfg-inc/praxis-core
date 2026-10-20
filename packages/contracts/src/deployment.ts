import { accessSync, constants, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { WorkflowError } from "./workflow.js";

/**
 * Can approvals on this host be trusted? A signature only proves something if the party that could
 * forge one cannot also rewrite what verifies it. This assesses the evidence a Runtime process can see
 * and says plainly when secure operation is not available. It does not and cannot prove isolation; it
 * finds the ways the agent identity can reach the trust anchor, the replay ledger, the signing key or
 * the broker's directory, and refuses to call such a host secure.
 */

/**
 * The packaged Desktop extension is built with PRAXIS_BUNDLE_KIND="production" as a compile-time constant, so the
 * same-identity test override cannot be switched on there by any environment value, file or setting. From source
 * (unit tests, the acceptance harness's test variant) the constant is absent and the override works as documented.
 */
export function productionBuild(): boolean {
  return process.env.PRAXIS_BUNDLE_KIND === "production";
}

/** The override as every caller must read it: requested AND allowed in this build. */
export function testIdentityOverrideActive(): boolean {
  return process.env.PRAXIS_TEST_ALLOW_SAME_IDENTITY === "1" && !productionBuild();
}

export type DeploymentTier =
  /** No blocking finding: the evidence visible from here is consistent with an isolated broker. */
  | "isolated"
  /** Secure mode, but the agent identity can reach or rewrite part of the trust chain. */
  | "unisolated"
  /** Secure mode with no broker trust anchor: protected mutations fail closed. */
  | "unconfigured"
  /** Explicit compatibility mode: approvals are not enforced against the agent. */
  | "compatibility"
  | "invalid";

export type DeploymentFinding = {
  id: string;
  severity: "blocking" | "warning";
  detail: string;
  remedy: string;
};

export type DeploymentAssessment = {
  tier: DeploymentTier;
  /** True only for tier "isolated". Never true by configuration alone. */
  secureOperation: boolean;
  findings: DeploymentFinding[];
  observed: {
    uid: number | null;
    trustAnchor: "env-inline" | "file" | "none";
    ledgerConfigured: boolean;
    brokerDirectoryVisible: boolean;
    dockerSocketReachable: boolean;
    signingKeyVisible: boolean;
    testHarnessOverride: boolean;
  };
};

export type DeploymentProbe = {
  uid(): number | null;
  /** owner uid and permission bits, or null when the path cannot be inspected by this process */
  stat(path: string): { uid: number; mode: number } | null;
  canWrite(path: string): boolean;
  canRead(path: string): boolean;
};

const defaultProbe: DeploymentProbe = {
  uid: () => (typeof process.getuid === "function" ? process.getuid() : null),
  stat: (path) => {
    try {
      const s = statSync(path);
      return { uid: s.uid, mode: s.mode };
    } catch {
      return null;
    }
  },
  canWrite: (path) => {
    try {
      accessSync(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  canRead: (path) => {
    try {
      accessSync(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
};

const DOCKER_SOCKETS = (home: string) => ["/var/run/docker.sock", `${home}/.docker/run/docker.sock`];

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function assessApprovalDeployment(opts: {
  env?: NodeJS.ProcessEnv;
  probe?: DeploymentProbe;
  /** Workspace the agent works in; a ledger or key inside it is agent-controlled by definition. */
  workspace?: string;
  dockerSockets?: string[];
} = {}): DeploymentAssessment {
  const env = opts.env ?? process.env;
  const probe = opts.probe ?? defaultProbe;
  const findings: DeploymentFinding[] = [];
  const add = (finding: DeploymentFinding) => findings.push(finding);
  const mode = nonEmpty(env.PRAXIS_SECURITY_MODE) ?? "secure";
  const uid = probe.uid();

  const keyInline = nonEmpty(env.PRAXIS_APPROVAL_PUBLIC_KEY);
  const keyPath = nonEmpty(env.PRAXIS_APPROVAL_PUBLIC_KEY_PATH);
  const ledger = nonEmpty(env.PRAXIS_APPROVAL_LEDGER);
  const brokerDir = nonEmpty(env.PRAXIS_BROKER_TRUSTED_DIR);
  const privateInline = nonEmpty(env.PRAXIS_APPROVAL_PRIVATE_KEY);
  const privatePath = nonEmpty(env.PRAXIS_APPROVAL_PRIVATE_KEY_PATH);
  const testHarnessOverride = env.PRAXIS_TEST_ALLOW_SAME_IDENTITY === "1" && !productionBuild();
  const sockets = opts.dockerSockets ?? DOCKER_SOCKETS(env.HOME ?? "");
  const dockerSocketReachable = sockets.some((socket) => probe.canRead(socket) && probe.canWrite(socket));
  const signingKeyVisible = Boolean(privateInline) || Boolean(privatePath && probe.canRead(privatePath));
  const trustAnchor: DeploymentAssessment["observed"]["trustAnchor"] = keyInline ? "env-inline" : keyPath ? "file" : "none";
  const brokerDirectoryVisible = Boolean(brokerDir && probe.stat(brokerDir));

  const finish = (tier: DeploymentTier): DeploymentAssessment => ({
    tier,
    secureOperation: tier === "isolated",
    findings,
    observed: {
      uid,
      trustAnchor,
      ledgerConfigured: Boolean(ledger),
      brokerDirectoryVisible,
      dockerSocketReachable,
      signingKeyVisible,
      testHarnessOverride,
    },
  });

  if (mode !== "secure" && mode !== "compatibility") {
    add({
      id: "security-mode-invalid",
      severity: "blocking",
      detail: "PRAXIS_SECURITY_MODE is neither 'secure' nor 'compatibility'; mutations fail closed.",
      remedy: "Set it to 'secure' (or leave it blank), or to 'compatibility' for trusted single-user development.",
    });
    return finish("invalid");
  }
  if (mode === "compatibility") {
    add({
      id: "compatibility-mode",
      severity: "blocking",
      detail: "Approvals are not enforced against the agent: stored approval files are forgeable by the same user.",
      remedy: "Use secure mode with an isolated broker for anything that matters. Compatibility is for trusted local development only.",
    });
    return finish("compatibility");
  }

  if (env.PRAXIS_TEST_ALLOW_SAME_IDENTITY === "1" && productionBuild()) {
    add({
      id: "test-override-ignored",
      severity: "warning",
      detail: "PRAXIS_TEST_ALLOW_SAME_IDENTITY=1 is set but this is a production build, which never honours it.",
      remedy: "Remove PRAXIS_TEST_ALLOW_SAME_IDENTITY from the environment.",
    });
  }
  if (testHarnessOverride) {
    add({
      id: "test-harness-override",
      severity: "blocking",
      detail: "PRAXIS_TEST_ALLOW_SAME_IDENTITY=1 lets the broker and the agent share an identity. This exists for automated tests only.",
      remedy: "Unset PRAXIS_TEST_ALLOW_SAME_IDENTITY. A host that needs it is not a secure deployment.",
    });
  }
  if (trustAnchor === "none" || !ledger) {
    add({
      id: "broker-not-configured",
      severity: "blocking",
      detail: `Secure mode has no ${trustAnchor === "none" ? "trust anchor (PRAXIS_APPROVAL_PUBLIC_KEY or _PATH)" : "replay ledger (PRAXIS_APPROVAL_LEDGER)"}, so protected mutations fail closed.`,
      remedy: "Deploy the broker and executor under a separate identity and point this Runtime at the public key and ledger.",
    });
  }
  if (trustAnchor === "env-inline") {
    add({
      id: "trust-anchor-unverifiable",
      severity: "blocking",
      detail:
        "The verifying public key reaches this process only through its environment, so it cannot be shown to be out of the agent's reach. On Claude Desktop that is the extension settings file, which the same user (and so the agent) can edit.",
      remedy: "Supply the public key as a file owned by the broker identity and not writable by this user (PRAXIS_APPROVAL_PUBLIC_KEY_PATH).",
    });
  }
  if (trustAnchor === "file" && keyPath && (probe.canWrite(keyPath) || probe.canWrite(dirname(resolve(keyPath))))) {
    add({
      id: "trust-anchor-writable",
      severity: "blocking",
      detail: "This identity can replace the public key that verifies approvals, then sign its own.",
      remedy: "Install the public key where only the broker identity can write it.",
    });
  }
  if (ledger) {
    const ledgerPath = resolve(ledger);
    const inWorkspace = opts.workspace ? !relative(resolve(opts.workspace), ledgerPath).startsWith("..") : false;
    if (inWorkspace || probe.canWrite(ledgerPath) || probe.canWrite(dirname(ledgerPath))) {
      add({
        id: "ledger-writable",
        severity: "blocking",
        detail: "This identity can edit the replay ledger, so a used approval could be made reusable.",
        remedy: "Keep the ledger in a directory only the executor identity can write.",
      });
    }
  }
  if (signingKeyVisible) {
    add({
      id: "signing-key-visible",
      severity: "blocking",
      detail: "The approval signing key is readable by this process.",
      remedy: "Keep the private key under the broker identity only. The Runtime must never see it.",
    });
  }
  if (brokerDir) {
    const info = probe.stat(brokerDir);
    if (info) {
      if (uid !== null && info.uid === uid) {
        add({
          id: "broker-same-identity",
          severity: "blocking",
          detail: `The broker directory is owned by uid ${info.uid}, the identity this Runtime runs as: the broker is not a separate identity.`,
          remedy: "Run the broker and executor as a different OS user (or on another machine).",
        });
      }
      if (probe.canWrite(brokerDir)) {
        add({
          id: "broker-directory-writable",
          severity: "blocking",
          detail: "This identity can write the broker's trusted directory.",
          remedy: "Make the trusted directory writable only by the broker identity.",
        });
      }
    }
  }
  if (dockerSocketReachable) {
    const claimed = env.PRAXIS_DEPLOYMENT_MODEL === "docker-uid";
    add({
      id: "docker-control",
      severity: claimed ? "blocking" : "warning",
      detail:
        "This identity can control Docker. A process that can start containers can mount a 'protected' volume and read it, so Docker volumes are not a boundary against it.",
      remedy: "Do not rely on Docker volumes for the broker. Use a separate OS identity or a remote broker, or remove Docker access from the agent identity.",
    });
  }

  const blocking = findings.filter((finding) => finding.severity === "blocking");
  if (blocking.some((finding) => finding.id === "broker-not-configured") && blocking.length === 1) return finish("unconfigured");
  if (blocking.length > 0) return finish("unisolated");
  // No blocking finding is evidence consistent with isolation, not proof of it.
  return finish("isolated");
}

export function assertSecureDeploymentAssessment(assessment: DeploymentAssessment): void {
  if (assessment.secureOperation) return;
  const reasons = assessment.findings.filter((finding) => finding.severity === "blocking").map((finding) => finding.id);
  throw new WorkflowError(
    "APPROVAL_ISOLATION_UNAVAILABLE",
    `${assessment.tier} deployment (${reasons.join(", ") || "no secure configuration"}): approval isolation is not available, so protected mutations are refused`,
  );
}
