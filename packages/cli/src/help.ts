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
  praxis architect preview --epic KEY [--wp WP-ID] [--repo PATH] [--json]
  praxis architect apply --epic KEY --confirm YES [--wp WP-ID] [--fingerprint SHA] [--repo PATH] [--json]

preview returns the actual future Jira mutations (not empty dry-run arrays).
--wp is the explicit materialization scope (not a hint). If omitted and
multiple materializable WPs exist, preview fails with WORK_PACKAGE_SCOPE_AMBIGUOUS.
apply materializes the exact fingerprinted WP (e.g. WP-20260914-002).
Does not invent generic technical tasks or placeholder diagrams.
apply requires --confirm YES.
`,
  "architect status": `USAGE
  praxis architect status --epic KEY [--json]
Required: --epic. Read-only.
`,
  "architect preview": `USAGE
  praxis architect preview --epic KEY [--wp WP-ID] [--repo PATH] [--json]
Required: --epic. Optional: --wp (hard scope). Dry-run of apply. Read-only.
`,
  "architect apply": `USAGE
  praxis architect apply --epic KEY --confirm YES [--wp WP-ID] [--fingerprint SHA] [--repo PATH] [--json]
Required: --epic, --confirm YES. Write. Uses the same --wp scope as preview.
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
  praxis developer complete-recovery-preview --wp ID_OR_KEY [--repo PATH] [--json]
  praxis developer complete-recovery-apply --wp ID_OR_KEY --confirm YES --fingerprint sha256:... [--repo PATH] [--json]
  praxis developer git-status --wp ID_OR_KEY [--json]
  praxis developer git-preview --wp ID_OR_KEY [--json]
  praxis developer git-commit --wp ID_OR_KEY --confirm YES --fingerprint sha256:... [--json]
  praxis developer git-publish --wp ID_OR_KEY --confirm YES --fingerprint sha256:... [--mode baseline|branch] [--json]
  praxis developer git-merge-request --wp ID_OR_KEY --confirm YES [--json]

claim writes Jira claim. complete verifies, persists evidence and Quality handoff, and keeps Jira In Progress.
complete does not mark the issue Done and does not start Quality.
git-* is GitHub-MVP delivery (no force-push, no merge). release requires --confirm YES.
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
Required: --confirm YES. Write. Runs required tests, writes completion evidence and Developer→Quality handoff. Does not mark Jira Done.
`,
  "developer complete-recovery-preview": `USAGE
  praxis developer complete-recovery-preview --wp ID_OR_KEY [--repo PATH] [--json]
Read-only preview of premature Done / missing evidence recovery. Does not write.
`,
  "developer complete-recovery-apply": `USAGE
  praxis developer complete-recovery-apply --wp ID_OR_KEY --confirm YES --fingerprint sha256:... [--repo PATH] [--json]
Required: --confirm YES and matching preview fingerprint. Restores development status then reconciles completion evidence.
`,
  quality: `USAGE
  praxis quality status [--wp ID_OR_KEY] [--json]
  praxis quality ensure [--json]
  praxis quality review --wp ID_OR_KEY [--repo PATH] [--json]
  praxis quality report --wp ID_OR_KEY [--repo PATH] [--json]
  praxis quality apply-preview --wp ID_OR_KEY [--repo PATH] [--json]
  praxis quality apply --wp ID_OR_KEY --confirm YES --fingerprint sha256:... [--repo PATH] [--json]

ensure starts the Quality service bundled in Praxis Runtime and waits until /health is ready.
review executes Quality Service acceptance checks and stores evidence. It does not write Jira.
apply-preview shows proposed Jira writes for the persisted review.
apply performs those writes only with --confirm YES and a current fingerprint.
`,
  "quality status": `USAGE
  praxis quality status [--json] [--repo PATH] [--wp ID_OR_KEY]
Read-only health and latest review status. Does not start Quality.
`,
  "quality ensure": `USAGE
  praxis quality ensure [--json] [--repo PATH]
Starts the bundled Quality service if needed, waits for health, reuses a healthy instance.
Does not run review or write Jira.
`,
  "quality review": `USAGE
  praxis quality review --wp ID_OR_KEY [--repo PATH] [--json]
Execute Quality Review via Quality Service. Persists QA evidence. Does not write Jira.
`,
  "quality report": `USAGE
  praxis quality report --wp ID_OR_KEY [--repo PATH] [--json]
Safe alias of quality review. Does not write Jira.
`,
  "quality apply-preview": `USAGE
  praxis quality apply-preview --wp ID_OR_KEY [--repo PATH] [--json]
Read-only Jira apply preview for the persisted Quality Review. Returns previewFingerprint.
`,
  "quality apply": `USAGE
  praxis quality apply --wp ID_OR_KEY --confirm YES --fingerprint sha256:... [--repo PATH] [--json]
Required: --confirm YES and matching preview fingerprint. Writes Jira only for the approved plan.
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
