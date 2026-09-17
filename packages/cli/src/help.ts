export const HELP: Record<string, string> = {
  "": `Praxis public CLI — machine/runtime contract for Skills, CI, and debugging.

USAGE
  praxis [--json] [--quiet] [--verbose] [--help] [--version] <command> [args]

COMMANDS
  doctor              Runtime, repo, .project, Jira config (no secrets), Quality
  project             Project onboarding (.project status / init)
  jira                Jira smoke, discover, epic, status
  ba                  BA preview / apply / status
  architect           Architect preview / apply / status
  work-package        List / show / status local and Jira work packages
  developer           Claim / release / complete / status
  quality             Ensure runtime, review, report, status

GLOBAL OPTIONS
  --json              Machine-readable envelope on stdout (logs on stderr)
  --quiet             Suppress non-error prose
  --verbose           Extra diagnostics on stderr
  --help              Show this help
  --version           Print Praxis version

EXIT CODES
  0  success
  2  invalid usage or missing configuration
  3  human confirmation required
  4  workflow blocked / gate not satisfied
  5  external service failure
  6  conflict / concurrency
  7  local execution unavailable
  8  validation failure

Examples
  praxis --help
  praxis doctor --json
  praxis ba preview --epic PRX-1 --repo . --json
`,
  doctor: `USAGE
  praxis doctor [--json] [--repo PATH]

Read-only. Reports Praxis version, git root, .project status, Jira mode/config
presence (never token/email values), optional connectivity, Quality health, and
shell/runtime capability.

Exit 0 even when Jira is disconnected. Exit 2 if --repo is invalid.
`,
  project: `USAGE
  praxis project status [--json] [--repo PATH]
  praxis project init --infer [--confirm YES] [--json] [--repo PATH]

status   Read-only .project load/missing/invalid.
init     Infer config from package.json / repo layout.
         Without --confirm YES: preview only, no write (safe).
         With --confirm YES: write minimal .project once.

Never silently creates .project.
`,
  "project status": `USAGE
  praxis project status [--json] [--repo PATH]

Read-only. Safe.
`,
  "project init": `USAGE
  praxis project init --infer [--confirm YES] [--json] [--repo PATH]

Optional: --infer (required for inference).
Write: --confirm YES. Without it, preview only (exit 0, wrote=false).
`,
  jira: `USAGE
  praxis jira smoke [--json]
  praxis jira discover [--json]
  praxis jira epic --epic KEY [--json]
  praxis jira status --epic KEY [--json]

Read-only Jira operations. Requires Jira env/config (no secrets printed).
`,
  "jira smoke": `USAGE
  praxis jira smoke [--json]

Read-only connectivity check.
`,
  "jira discover": `USAGE
  praxis jira discover [--json]

Read-only issue-type discovery (semantic types + numeric ids).
`,
  "jira epic": `USAGE
  praxis jira epic --epic KEY [--json]

Required: --epic. Read-only.
`,
  "jira status": `USAGE
  praxis jira status --epic KEY [--json]

Required: --epic. Read-only epic + canonical/superseded + work packages.
`,
  ba: `USAGE
  praxis ba status --epic KEY [--json]
  praxis ba preview --epic KEY [--repo PATH] [--json]
  praxis ba apply --epic KEY --confirm YES [--repo PATH] [--json]

preview is a true dry-run of apply (plan of CREATE/UPDATE/UNCHANGED/SUPERSEDED).
apply requires --confirm YES. Human gate. Write.
`,
  "ba status": `USAGE
  praxis ba status --epic KEY [--json]
Required: --epic. Read-only.
`,
  "ba preview": `USAGE
  praxis ba preview --epic KEY [--repo PATH] [--json]
Required: --epic. Optional: --repo (default .). Read-only / dry-run.
`,
  "ba apply": `USAGE
  praxis ba apply --epic KEY --confirm YES [--repo PATH] [--json]
Required: --epic, --confirm YES. Write after human approval.
`,
  architect: `USAGE
  praxis architect status --epic KEY [--json]
  praxis architect preview --epic KEY [--repo PATH] [--json]
  praxis architect apply --epic KEY --confirm YES [--repo PATH] [--json]

preview returns the actual future Jira mutations (not empty dry-run arrays).
apply materializes the canonical local Work Package (e.g. WP-20260914-002).
Does not invent generic technical tasks or placeholder diagrams.
apply requires --confirm YES.
`,
  "architect status": `USAGE
  praxis architect status --epic KEY [--json]
Required: --epic. Read-only.
`,
  "architect preview": `USAGE
  praxis architect preview --epic KEY [--repo PATH] [--json]
Required: --epic. Optional: --repo. Dry-run of apply. Read-only.
`,
  "architect apply": `USAGE
  praxis architect apply --epic KEY --confirm YES [--repo PATH] [--json]
Required: --epic, --confirm YES. Write. Idempotent Jira Work Package.
`,
  "work-package": `USAGE
  praxis work-package list [--repo PATH] [--json]
  praxis work-package show --wp ID_OR_KEY [--repo PATH] [--json]
  praxis work-package status --wp ID_OR_KEY [--repo PATH] [--json]

Resolves local WP-YYYYMMDD-NNN or Jira key to the same canonical package.
Read-only.
`,
  "work-package list": `USAGE
  praxis work-package list [--repo PATH] [--json]
Read-only.
`,
  "work-package show": `USAGE
  praxis work-package show --wp ID_OR_KEY [--repo PATH] [--json]
Required: --wp. Read-only.
`,
  "work-package status": `USAGE
  praxis work-package status --wp ID_OR_KEY [--repo PATH] [--json]
Required: --wp. Read-only.
`,
  developer: `USAGE
  praxis developer status --wp ID_OR_KEY [--repo PATH] [--json]
  praxis developer claim --wp ID_OR_KEY [--repo PATH] [--json]
  praxis developer release --wp ID_OR_KEY --confirm YES [--repo PATH] [--json]
  praxis developer complete --wp ID_OR_KEY --confirm YES [--repo PATH] [--json]

claim writes Jira claim. complete marks Ready for QA (verification required).
release requires --confirm YES.
`,
  "developer status": `USAGE
  praxis developer status --wp ID_OR_KEY [--repo PATH] [--json]
Required: --wp. Read-only.
`,
  "developer claim": `USAGE
  praxis developer claim --wp ID_OR_KEY [--repo PATH] [--json] [--actor NAME]
Write. Resolves local WP id or Jira key.
`,
  "developer release": `USAGE
  praxis developer release --wp ID_OR_KEY --confirm YES [--repo PATH] [--json]
Required: --confirm YES. Write.
`,
  "developer complete": `USAGE
  praxis developer complete --wp ID_OR_KEY --confirm YES [--repo PATH] [--json]
Required: --confirm YES. Write. Marks Ready for QA after verification.
`,
  quality: `USAGE
  praxis quality status [--json]
  praxis quality ensure [--json]
  praxis quality review --wp ID_OR_KEY [--repo PATH] [--json]
  praxis quality report --wp ID_OR_KEY [--repo PATH] [--json]

ensure starts the local Quality service if it is not healthy (no duplicate spawn).
review runs the QA workflow. Does not require make quality-up in normal UI flow.
`,
  "quality status": `USAGE
  praxis quality status [--json]
Read-only health.
`,
  "quality ensure": `USAGE
  praxis quality ensure [--json]
Starts Quality if needed. Safe reuse when already healthy.
`,
  "quality review": `USAGE
  praxis quality review --wp ID_OR_KEY [--repo PATH] [--json]
Write (bugs/report) after local build/test.
`,
  "quality report": `USAGE
  praxis quality report --wp ID_OR_KEY [--repo PATH] [--json]
Read-only last report if present; otherwise same as review without extra writes when already stored.
`,
};

export function helpFor(path: string[]): string {
  const keys = [
    path.join(" "),
    path.slice(0, 1).join(" "),
    "",
  ];
  for (const k of keys) {
    if (HELP[k]) return HELP[k]!;
  }
  return HELP[""]!;
}
