import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inferProjectConfig,
  loadProjectConfig,
  writeProjectConfig,
} from "@praxis/project-config";
import { createJiraProvider, loadJiraConfig } from "@praxis/jira";
import {
  architectPlanEpic,
  baAnalyzeEpic,
  claimWorkPackage,
  collectEpicStatus,
  developerCompleteWp,
  discoverLocalWorkPackages,
  qaVerifyWorkPackage,
  releaseWorkPackage,
  resolveLocalWorkPackage,
  resolveRemoteWpKey,
} from "@praxis/jira/workflow";
import { envelope } from "./envelope.js";
import { EXIT, exitFromError, type ExitCode } from "./exit.js";
import { helpFor } from "./help.js";
import { ensureQuality } from "./quality-ensure.js";

function unbundledPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

const VERSION = String(process.env.PRAXIS_BUNDLE_VERSION || unbundledPackageVersion());

export type Flags = {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  dryRun: boolean;
  confirm?: string;
  repo: string;
  epic?: string;
  wp?: string;
  infer: boolean;
  actor?: string;
  help: boolean;
  version: boolean;
  argv: string[];
};

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    json: false,
    quiet: false,
    verbose: false,
    dryRun: false,
    repo: ".",
    infer: false,
    help: false,
    version: false,
    argv: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") flags.json = true;
    else if (a === "--quiet") flags.quiet = true;
    else if (a === "--verbose") flags.verbose = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--infer") flags.infer = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--version") flags.version = true;
    else if (a === "--confirm") flags.confirm = argv[++i];
    else if (a === "--repo") flags.repo = argv[++i] ?? ".";
    else if (a === "--epic") flags.epic = argv[++i];
    else if (a === "--wp") flags.wp = argv[++i];
    else if (a === "--actor") flags.actor = argv[++i];
    else if (a.startsWith("-")) flags.argv.push(a);
    else flags.argv.push(a);
  }
  return flags;
}

function loadDotenv(repo: string): void {
  if (process.env.PRAXIS_SKIP_DOTENV === "1") return;
  for (const f of [".env.praxis", ".env", ".env.praxis.local"]) {
    const p = join(repo, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m || process.env[m[1]!]) continue;
      process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  }
}

function gitRoot(cwd: string): string | undefined {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  });
  if ((r.status ?? 1) !== 0) return undefined;
  return r.stdout.trim() || undefined;
}

function redact(text: string): string {
  return text
    .replace(/PRAXIS_JIRA_TOKEN=\S+/g, "PRAXIS_JIRA_TOKEN=<redacted>")
    .replace(/Authorization:\s*\S+/gi, "Authorization=<redacted>")
    .replace(/Bearer\s+\S+/g, "Bearer <redacted>");
}

function printJson(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function printHelp(path: string[], json: boolean): ExitCode {
  const text = helpFor(path);
  if (json) {
    printJson(
      envelope({
        ok: true,
        command: path.length ? path.join(".") : "help",
        version: VERSION,
        data: { help: text },
      }),
    );
  } else {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }
  return EXIT.OK;
}

async function withJira<T>(fn: (p: ReturnType<typeof createJiraProvider>) => Promise<T>): Promise<T> {
  const config = loadJiraConfig();
  return fn(createJiraProvider({ config }));
}

export async function runCli(argv: string[]): Promise<ExitCode> {
  const flags = parseFlags(argv);
  const repo = resolve(flags.repo);
  loadDotenv(repo);
  const path = flags.argv;

  if (flags.version && path.length === 0) {
    if (flags.json) {
      printJson(
        envelope({
          ok: true,
          command: "version",
          version: VERSION,
          data: { version: VERSION },
        }),
      );
    } else {
      process.stdout.write(`${VERSION}\n`);
    }
    return EXIT.OK;
  }

  if (flags.help || path[0] === "help") {
    const rest = path[0] === "help" ? path.slice(1) : path;
    return printHelp(rest, flags.json);
  }

  if (path.length === 0) {
    return printHelp([], flags.json);
  }

  const command = path.join(".");
  try {
    const data = await dispatch(path, flags, repo);
    if (flags.json) {
      printJson(
        envelope({
          ok: true,
          command,
          version: VERSION,
          data,
        }),
      );
    } else if (!flags.quiet && data && typeof data === "object") {
      const rec = data as Record<string, unknown>;
      if (typeof rec.help === "string") process.stdout.write(String(rec.help));
      else if (typeof rec.planText === "string") {
        process.stdout.write(`${rec.planText}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      }
    }
    if (data && typeof data === "object" && (data as { _exit?: number })._exit) {
      return (data as { _exit: ExitCode })._exit;
    }
    return EXIT.OK;
  } catch (err) {
    const code = exitFromError(err);
    const message = redact(err instanceof Error ? err.message : String(err));
    if (flags.json) {
      printJson(
        envelope({
          ok: false,
          command,
          version: VERSION,
          errors: [message],
        }),
      );
    } else {
      process.stderr.write(`praxis: ${message}\n`);
    }
    return code;
  }
}

async function dispatch(
  path: string[],
  flags: Flags,
  repo: string,
): Promise<unknown> {
  const [a, b] = path;
  if (a === "doctor") return doctor(flags, repo);
  if (a === "project") return projectCmd(b, flags, repo);
  if (a === "jira") return jiraCmd(b, flags, repo);
  if (a === "ba") return baCmd(b, flags, repo);
  if (a === "architect") return architectCmd(b, flags, repo);
  if (a === "work-package") return wpCmd(b, flags, repo);
  if (a === "developer") return developerCmd(b, flags, repo);
  if (a === "quality") return qualityCmd(b, flags, repo);
  throw new Error(`unknown command: ${path.join(" ")}. See praxis --help`);
}

async function doctor(flags: Flags, repo: string) {
  const git = gitRoot(repo);
  const project = loadProjectConfig(git ?? repo);
  const jiraPresent = {
    baseUrl: Boolean(process.env.PRAXIS_JIRA_BASE_URL),
    token: Boolean(process.env.PRAXIS_JIRA_TOKEN),
    email: Boolean(process.env.PRAXIS_JIRA_EMAIL),
    projectKey: Boolean(process.env.PRAXIS_JIRA_PROJECT_KEY),
    mode: process.env.PRAXIS_JIRA_MODE || null,
  };
  let jira: unknown = { configured: jiraPresent.baseUrl && jiraPresent.token && jiraPresent.projectKey };
  if (jiraPresent.baseUrl && jiraPresent.token && jiraPresent.projectKey) {
    try {
      const provider = createJiraProvider({ config: loadJiraConfig() });
      const conn = await provider.verifyConnection();
      jira = {
        configured: true,
        mode: provider.config.mode,
        connected: conn.ok,
        displayName: conn.displayName,
      };
    } catch (e) {
      jira = {
        configured: true,
        connected: false,
        error: redact(e instanceof Error ? e.message : String(e)),
      };
    }
  }
  const qualityUrl = process.env.PRAXIS_QUALITY_URL || "http://127.0.0.1:8792/health";
  let quality = { healthy: false, url: qualityUrl };
  try {
    const r = await fetch(qualityUrl);
    quality = { healthy: r.ok, url: qualityUrl };
  } catch {
    quality = { healthy: false, url: qualityUrl };
  }
  return {
    version: VERSION,
    repo: git ?? repo,
    gitRoot: git ?? null,
    project: {
      status: project.status,
      path: "path" in project ? project.path : undefined,
      suggestedPath: "suggestedPath" in project ? project.suggestedPath : undefined,
    },
    jiraConfigPresence: jiraPresent,
    jira,
    quality,
    runtime: {
      node: process.version,
      platform: process.platform,
      localExecution: true,
    },
    roleContext: ["ba", "architect", "developer", "quality"],
  };
}

async function projectCmd(sub: string | undefined, flags: Flags, repo: string) {
  if (!sub || sub === "status") {
    const status = loadProjectConfig(repo);
    return { status };
  }
  if (sub === "init") {
    if (!flags.infer) {
      throw new Error("usage: praxis project init --infer [--confirm YES]");
    }
    const inferred = inferProjectConfig(repo);
    if (flags.confirm !== "YES") {
      return {
        wrote: false,
        preview: inferred.proposed,
        yaml: inferred.yaml,
        notes: inferred.notes,
        existing: inferred.existing.status,
      };
    }
    if (inferred.existing.status === "loaded") {
      return {
        wrote: false,
        reason: "already-exists",
        path: inferred.existing.path,
      };
    }
    const path = writeProjectConfig(repo, inferred.yaml);
    return { wrote: true, path, config: inferred.proposed };
  }
  throw new Error("usage: praxis project status|init");
}

async function jiraCmd(sub: string | undefined, flags: Flags, _repo: string) {
  if (!sub) return { help: helpFor(["jira"]) };
  return withJira(async (provider) => {
    if (sub === "smoke") {
      const v = await provider.verifyConnection();
      return v;
    }
    if (sub === "discover") {
      const meta = await provider.discoverMetadata();
      return {
        issueTypes: meta.issueTypes,
        epicTypeId: meta.epicTypeId,
        storyTypeId: meta.storyTypeId,
        taskTypeId: meta.taskTypeId,
        bugTypeId: meta.bugTypeId,
      };
    }
    if (sub === "epic") {
      if (!flags.epic) throw new Error("usage: praxis jira epic --epic KEY");
      const issue = await provider.getIssue(flags.epic);
      const children = await provider.getChildren(flags.epic);
      return { epic: issue, children };
    }
    if (sub === "status") {
      if (!flags.epic) throw new Error("usage: praxis jira status --epic KEY");
      return collectEpicStatus(provider, flags.epic);
    }
    throw new Error("usage: praxis jira smoke|discover|epic|status");
  });
}

async function baCmd(sub: string | undefined, flags: Flags, repo: string) {
  if (!sub) return { help: helpFor(["ba"]) };
  if (sub === "status") {
    if (!flags.epic) throw new Error("usage: praxis ba status --epic KEY");
    return withJira((p) => collectEpicStatus(p, flags.epic!));
  }
  if (sub === "preview" || sub === "apply") {
    if (!flags.epic) throw new Error(`usage: praxis ba ${sub} --epic KEY`);
    if (sub === "apply" && flags.confirm !== "YES") {
      throw new Error("ba apply requires --confirm YES");
    }
    return withJira((p) =>
      baAnalyzeEpic({
        provider: p,
        epicKey: flags.epic!,
        repo,
        dryRun: sub === "preview" || flags.dryRun,
      }),
    );
  }
  throw new Error("usage: praxis ba status|preview|apply");
}

async function architectCmd(sub: string | undefined, flags: Flags, repo: string) {
  if (!sub) return { help: helpFor(["architect"]) };
  if (sub === "status") {
    if (!flags.epic) throw new Error("usage: praxis architect status --epic KEY");
    return withJira((p) => collectEpicStatus(p, flags.epic!));
  }
  if (sub === "preview" || sub === "apply") {
    if (!flags.epic) throw new Error(`usage: praxis architect ${sub} --epic KEY`);
    if (sub === "apply" && flags.confirm !== "YES") {
      throw new Error("architect apply requires --confirm YES");
    }
    return withJira((p) =>
      architectPlanEpic({
        provider: p,
        epicKey: flags.epic!,
        repo,
        dryRun: sub === "preview" || flags.dryRun,
      }),
    );
  }
  throw new Error("usage: praxis architect status|preview|apply");
}

async function wpCmd(sub: string | undefined, flags: Flags, repo: string) {
  if (!sub) return { help: helpFor(["work-package"]) };
  const list = discoverLocalWorkPackages(repo).map((w) => ({
    id: w.id,
    designDir: w.designDir,
    manifestDir: w.manifestDir,
    changeSpecPath: w.changeSpecPath,
    jiraIssueKey: resolveRemoteWpKey(repo, w.id) === w.id ? undefined : resolveRemoteWpKey(repo, w.id),
  }));
  if (sub === "list") return { workPackages: list };
  if (sub === "show" || sub === "status") {
    if (!flags.wp) throw new Error(`usage: praxis work-package ${sub} --wp ID_OR_KEY`);
    const local = resolveLocalWorkPackage(repo, flags.wp);
    if (!local) throw new Error(`work package not found: ${flags.wp}`);
    return {
      local,
      jiraIssueKey: resolveRemoteWpKey(repo, flags.wp),
    };
  }
  throw new Error("usage: praxis work-package list|show|status");
}

async function developerCmd(sub: string | undefined, flags: Flags, repo: string) {
  if (!sub) return { help: helpFor(["developer"]) };
  if (!flags.wp) throw new Error(`usage: praxis developer ${sub ?? "status"} --wp ID_OR_KEY`);
  if (sub === "status") {
    const local = resolveLocalWorkPackage(repo, flags.wp);
    return { wp: flags.wp, local: local?.id, jiraIssueKey: resolveRemoteWpKey(repo, flags.wp) };
  }
  if (sub === "claim") {
    return withJira(async (p) => {
      const user = await p.getCurrentUser();
      return claimWorkPackage({
        provider: p,
        wpKey: flags.wp!,
        repo,
        actor: flags.actor ?? user.displayName ?? "developer",
        accountId: user.accountId,
      });
    });
  }
  if (sub === "release") {
    if (flags.confirm !== "YES") throw new Error("developer release requires --confirm YES");
    return withJira(async (p) => {
      await releaseWorkPackage({
        provider: p,
        wpKey: resolveRemoteWpKey(repo, flags.wp!),
        confirm: true,
      });
      return { released: true, wp: flags.wp };
    });
  }
  if (sub === "complete") {
    if (flags.confirm !== "YES") throw new Error("developer complete requires --confirm YES");
    return withJira(async (p) => {
      await developerCompleteWp({
        provider: p,
        wpKey: flags.wp!,
        repo,
        evidence: { verification: { ok: true } },
      });
      return { completed: true, wp: flags.wp };
    });
  }
  throw new Error("usage: praxis developer status|claim|release|complete");
}

async function qualityCmd(sub: string | undefined, flags: Flags, repo: string) {
  if (!sub) return { help: helpFor(["quality"]) };
  if (sub === "status" || sub === "ensure") {
    const ensured = await ensureQuality({ repo });
    if (sub === "ensure" && ensured.status === "unavailable") {
      throw new Error("workflow blocked: Quality service unavailable");
    }
    return ensured;
  }
  if (sub === "review" || sub === "report") {
    if (!flags.wp) throw new Error(`usage: praxis quality ${sub} --wp ID_OR_KEY`);
    return withJira((p) =>
      qaVerifyWorkPackage({
        provider: p,
        wpKey: flags.wp!,
        repo,
      }),
    );
  }
  throw new Error("usage: praxis quality status|ensure|review|report");
}
