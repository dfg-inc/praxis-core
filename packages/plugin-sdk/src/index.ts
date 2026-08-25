import { loadApplicableSlice } from "@praxis/knowledge";
import { loadProjectConfig, type ProjectConfig } from "@praxis/project-config";

export type HumanGateDecision = "approved" | "rejected";

export type HumanGateResult = {
  decision: HumanGateDecision;
  actor: string;
  reason?: string;
  at: string;
};

export type VersionCheckResult = {
  installed: string;
  published: string;
  outdated: boolean;
  incompatibleCanon: boolean;
  message: string;
  updateCommand: string;
  continueAllowed: boolean;
};

/**
 * Records a human approval decision. Production callers must obtain a real human response;
 * tests may inject decisions without bypassing the gate shape.
 */
export function recordHumanGate(input: {
  decision: HumanGateDecision;
  actor: string;
  reason?: string;
}): HumanGateResult {
  if (input.decision === "rejected" && !input.reason) {
    throw new Error("rejection requires a reason");
  }
  return {
    decision: input.decision,
    actor: input.actor,
    reason: input.reason,
    at: new Date().toISOString(),
  };
}

export type SessionBootstrap = {
  project: ReturnType<typeof loadProjectConfig>;
  knowledge:
    | { status: "loaded"; count: number; ruleIds: string[] }
    | { status: "unavailable"; message: string }
    | { status: "skipped"; message: string };
  plugin: { name: string; version: string; updateHint?: string };
  version?: VersionCheckResult;
};

export function bootstrapSession(opts: {
  repoRoot: string;
  role: string;
  stage: string;
  pluginName: string;
  pluginVersion: string;
  latestVersion?: string;
  installedCanonMajor?: number;
  requiredCanonMajor?: number;
  installSource?: "marketplace" | "local" | "git";
}): SessionBootstrap {
  const project = loadProjectConfig(opts.repoRoot);
  const config: ProjectConfig = project.config;
  let knowledge: SessionBootstrap["knowledge"];

  if (!config.knowledge.path) {
    knowledge = {
      status: "skipped",
      message: "knowledge.path unset; rules not applied",
    };
  } else {
    try {
      const slice = loadApplicableSlice({
        knowledgeRoot: config.knowledge.path,
        role: opts.role,
        stage: opts.stage,
      });
      knowledge = {
        status: "loaded",
        count: slice.rules.length,
        ruleIds: slice.rules.map((r) => r.frontmatter.id),
      };
    } catch (err) {
      knowledge = {
        status: "unavailable",
        message: `knowledge unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const version = checkPluginVersion({
    installed: opts.pluginVersion,
    published: opts.latestVersion ?? opts.pluginVersion,
    installedCanonMajor: opts.installedCanonMajor ?? 3,
    requiredCanonMajor: opts.requiredCanonMajor ?? 3,
    installSource: opts.installSource,
  });

  const updateHint = version.outdated ? version.message : undefined;

  return {
    project,
    knowledge,
    plugin: {
      name: opts.pluginName,
      version: opts.pluginVersion,
      updateHint,
    },
    version,
  };
}

export function formatSessionBootstrap(boot: SessionBootstrap): string {
  const lines: string[] = [];
  lines.push(`plugin ${boot.plugin.name}@${boot.plugin.version}`);
  if (boot.plugin.updateHint) lines.push(boot.plugin.updateHint);
  if (boot.version?.outdated) lines.push(boot.version.updateCommand);
  if (boot.version && !boot.version.continueAllowed) {
    lines.push(`STOP: ${boot.version.message}`);
  }
  if (boot.project.status === "missing") {
    lines.push(
      `.project missing; defaults in use; unset: ${boot.project.unset.join(", ")}`,
    );
    lines.push(`suggest create: ${boot.project.suggestedPath}`);
  } else if (boot.project.status === "loaded") {
    lines.push(`.project loaded: ${boot.project.path}`);
    if (boot.project.unset.length) {
      lines.push(`unset parameters: ${boot.project.unset.join(", ")}`);
    }
  } else {
    lines.push(`.project invalid: ${boot.project.errors.join("; ")}`);
  }
  if (boot.knowledge.status === "loaded") {
    lines.push(`knowledge rules loaded: ${boot.knowledge.count}`);
  } else {
    lines.push(boot.knowledge.message);
  }
  if (boot.project.status === "loaded" || boot.project.status === "missing") {
    lines.push(
      `requirementsFormat: ${boot.project.config.requirementsFormat}`,
    );
  }
  return lines.join("\n");
}

/**
 * Session-start plugin version check (WBS 8.4).
 * - Outdated but compatible: warn + update command; work continues.
 * - Canon format incompatible: hard stop.
 */
export function checkPluginVersion(opts: {
  installed: string;
  published: string;
  /** Installed plugin's max supported canon format major. */
  installedCanonMajor: number;
  /** Required canon format major for this repo. */
  requiredCanonMajor: number;
  installSource?: "marketplace" | "local" | "git";
}): VersionCheckResult {
  const outdated = opts.installed !== opts.published;
  const incompatibleCanon = opts.installedCanonMajor < opts.requiredCanonMajor;
  const source = opts.installSource ?? "marketplace";
  const updateCommand =
    source === "marketplace"
      ? `claude plugin update praxis — see https://marketplace.praxis.local/plugins`
      : source === "git"
        ? `git pull && npm install && claude plugin reload`
        : `npm install && claude plugin reload`;

  if (incompatibleCanon) {
    return {
      installed: opts.installed,
      published: opts.published,
      outdated,
      incompatibleCanon: true,
      message: `canon format major ${opts.requiredCanonMajor} required; plugin supports ${opts.installedCanonMajor}. Upgrade to ${opts.published} before continuing.`,
      updateCommand,
      continueAllowed: false,
    };
  }
  if (outdated) {
    return {
      installed: opts.installed,
      published: opts.published,
      outdated: true,
      incompatibleCanon: false,
      message: `update available: ${opts.installed} → ${opts.published}`,
      updateCommand,
      continueAllowed: true,
    };
  }
  return {
    installed: opts.installed,
    published: opts.published,
    outdated: false,
    incompatibleCanon: false,
    message: `up to date (${opts.installed})`,
    updateCommand,
    continueAllowed: true,
  };
}
