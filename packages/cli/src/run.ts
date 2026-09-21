import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { envelope } from "./envelope.js";
import { EXIT, exitFromError, type ExitCode } from "./exit.js";
import { helpFor } from "./help.js";
import {
  architectApplyOp,
  architectPreviewOp,
  architectStatusOp,
  baApplyOp,
  baPreviewOp,
  baStatusOp,
  developerClaimOp,
  developerCompleteOp,
  developerCompleteRecoveryPreviewOp,
  developerCompleteRecoveryApplyOp,
  developerReleaseOp,
  developerStatusOp,
  doctorOp,
  jiraDiscoverOp,
  jiraEpicOp,
  jiraSmokeOp,
  jiraStatusOp,
  PraxisOpError,
  projectInitApplyOp,
  projectInitPreviewOp,
  projectStatusOp,
  qualityEnsureOp,
  qualityReviewOp,
  qualityApplyPreviewOp,
  qualityApplyOp,
  qualityApplyStatusOp,
  qualityReviewShowOp,
  qualityStatusOp,
  redact,
  workPackageListOp,
  workPackageShowOp,
  type OpContext,
} from "./operations.js";

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
  fingerprint?: string;
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
    else if (a === "--fingerprint") flags.fingerprint = argv[++i];
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

function ctxFrom(flags: Flags, repo: string): OpContext {
  return {
    repo,
    epic: flags.epic,
    wp: flags.wp,
    confirmation: flags.confirm,
    previewFingerprint: flags.fingerprint,
    infer: flags.infer,
    actor: flags.actor,
  };
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
  const ctx = ctxFrom(flags, repo);
  if (a === "doctor") return doctorOp(ctx, VERSION);
  if (a === "project") return projectCmd(b, flags, ctx);
  if (a === "jira") return jiraCmd(b, ctx);
  if (a === "ba") return baCmd(b, ctx);
  if (a === "architect") return architectCmd(b, ctx);
  if (a === "work-package") return wpCmd(b, ctx);
  if (a === "developer") return developerCmd(b, ctx);
  if (a === "quality") return qualityCmd(b, ctx);
  throw new PraxisOpError("INVALID_INPUT", `unknown command: ${path.join(" ")}. See praxis --help`);
}

async function projectCmd(sub: string | undefined, flags: Flags, ctx: OpContext) {
  if (!sub || sub === "status") return projectStatusOp(ctx);
  if (sub === "init") {
    if (!flags.infer) {
      throw new PraxisOpError("INVALID_INPUT", "usage: praxis project init --infer [--confirm YES]");
    }
    if (flags.confirm !== "YES") return projectInitPreviewOp(ctx);
    return projectInitApplyOp(ctx);
  }
  throw new PraxisOpError("INVALID_INPUT", "usage: praxis project status|init");
}

async function jiraCmd(sub: string | undefined, ctx: OpContext) {
  if (!sub) return { help: helpFor(["jira"]) };
  if (sub === "smoke") return jiraSmokeOp(ctx);
  if (sub === "discover") return jiraDiscoverOp(ctx);
  if (sub === "epic") {
    if (!ctx.epic) throw new PraxisOpError("INVALID_INPUT", "usage: praxis jira epic --epic KEY");
    return jiraEpicOp(ctx);
  }
  if (sub === "status") {
    if (!ctx.epic) throw new PraxisOpError("INVALID_INPUT", "usage: praxis jira status --epic KEY");
    return jiraStatusOp(ctx);
  }
  throw new PraxisOpError("INVALID_INPUT", "usage: praxis jira smoke|discover|epic|status");
}

async function baCmd(sub: string | undefined, ctx: OpContext) {
  if (!sub) return { help: helpFor(["ba"]) };
  if (sub === "status") {
    if (!ctx.epic) throw new PraxisOpError("INVALID_INPUT", "usage: praxis ba status --epic KEY");
    return baStatusOp(ctx);
  }
  if (sub === "preview") {
    if (!ctx.epic) throw new PraxisOpError("INVALID_INPUT", "usage: praxis ba preview --epic KEY");
    return baPreviewOp(ctx);
  }
  if (sub === "apply") {
    if (!ctx.epic) throw new PraxisOpError("INVALID_INPUT", "usage: praxis ba apply --epic KEY");
    return baApplyOp(ctx);
  }
  throw new PraxisOpError("INVALID_INPUT", "usage: praxis ba status|preview|apply");
}

async function architectCmd(sub: string | undefined, ctx: OpContext) {
  if (!sub) return { help: helpFor(["architect"]) };
  if (sub === "status") {
    if (!ctx.epic) {
      throw new PraxisOpError("INVALID_INPUT", "usage: praxis architect status --epic KEY");
    }
    return architectStatusOp(ctx);
  }
  if (sub === "preview") {
    if (!ctx.epic) {
      throw new PraxisOpError("INVALID_INPUT", "usage: praxis architect preview --epic KEY [--wp WP-ID]");
    }
    return architectPreviewOp(ctx);
  }
  if (sub === "apply") {
    if (!ctx.epic) {
      throw new PraxisOpError("INVALID_INPUT", "usage: praxis architect apply --epic KEY [--wp WP-ID]");
    }
    return architectApplyOp(ctx);
  }
  throw new PraxisOpError("INVALID_INPUT", "usage: praxis architect status|preview|apply");
}

async function wpCmd(sub: string | undefined, ctx: OpContext) {
  if (!sub) return { help: helpFor(["work-package"]) };
  if (sub === "list") return workPackageListOp(ctx);
  if (sub === "show" || sub === "status") return workPackageShowOp(ctx);
  throw new PraxisOpError("INVALID_INPUT", "usage: praxis work-package list|show|status");
}

async function developerCmd(sub: string | undefined, ctx: OpContext) {
  if (!sub) return { help: helpFor(["developer"]) };
  if (!ctx.wp) {
    throw new PraxisOpError(
      "INVALID_INPUT",
      `usage: praxis developer ${sub ?? "status"} --wp ID_OR_KEY`,
    );
  }
  if (sub === "status") return developerStatusOp(ctx);
  if (sub === "claim") return developerClaimOp(ctx);
  if (sub === "release") return developerReleaseOp(ctx);
  if (sub === "complete") return developerCompleteOp(ctx);
  if (sub === "complete-recovery-preview") return developerCompleteRecoveryPreviewOp(ctx);
  if (sub === "complete-recovery-apply") return developerCompleteRecoveryApplyOp(ctx);
  throw new PraxisOpError(
    "INVALID_INPUT",
    "usage: praxis developer status|claim|release|complete|complete-recovery-preview|complete-recovery-apply",
  );
}

async function qualityCmd(sub: string | undefined, ctx: OpContext) {
  if (!sub) return { help: helpFor(["quality"]) };
  if (sub === "status") return qualityStatusOp(ctx);
  if (sub === "ensure") return qualityEnsureOp(ctx);
  if (sub === "review" || sub === "report") return qualityReviewOp(ctx);
  if (sub === "review-show") return qualityReviewShowOp(ctx);
  if (sub === "apply-preview") return qualityApplyPreviewOp(ctx);
  if (sub === "apply-status") return qualityApplyStatusOp(ctx);
  if (sub === "apply") return qualityApplyOp(ctx);
  throw new PraxisOpError(
    "INVALID_INPUT",
    "usage: praxis quality status|ensure|review|report|review-show|apply-preview|apply-status|apply",
  );
}
