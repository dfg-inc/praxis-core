# Quality report 4 (independent, current code)

Verifier: independent Quality (round 4). Read-only on the seven repositories and the website; everything ran in clones under `/tmp/q4` with `HOME`, `CLAUDE_CONFIG_DIR` and `PRAXIS_STATE_HOME` pointed at temp directories (`~/.claude` never touched, no `claude plugin install`, no marketplace add, nothing published, no Jira or other external system; the "Jira" in two tests is a local fake HTTP server on 127.0.0.1; the "browser" for the review pages was a PATH shim for `open` that logs the URL, and Chrome via playwright-core for the page checks).

HEADs under test: Core `7d4587a`, Runtime `09fddaa`, BA `ec0716c`, Architect `bc28749`, Developer `bbae9a8`, Quality `aace98b`, Marketplace `074914f`, website `docs/ux-overhaul` `51986bd`. Version string `0.1.0-alpha.48` everywhere (`check:version` PASS).

My test scripts (reproducible; run with node 25, from `/tmp/q4/h`): `seca.mjs` (every user-decision route), `secb.mjs` (page protocol), `secc.mjs` (HTML injection, concurrency), `secd.mjs` (stale page TOCTOU), `sece.mjs`, `flow1-4.mjs` (guided flow), `mig.mjs` (real alpha.48 bundle), `env1-5.mjs` (`.env`), `poc.mjs` and `poc2.mjs` (S1), `xss.mjs`/`xss2.mjs` (Chrome). They drive the shipped bundle `plugins/runtime/server/praxis-mcp.cjs` over stdio with the official MCP client (I rebuilt the bundle from source: byte-identical to the committed one, md5 `03e2929e...`, identical to the Marketplace copy).

Two checks were delegated to sub-agents running in separate copies (`/tmp/q4-a2`): the BA/Dustin audit and the test-edit audit. I re-verified the load-bearing parts myself (marked below); the rest is their report.

## 0. Summary

- Items: 6 product decisions + 5 "also verify" items = 11. PASS 5 (1, 4, 6, b, c), PARTIAL 6 (2, 3, 5, a, d, e), FAIL 0. There is no PASS-with-caveats: where a defect touches the item it is PARTIAL.
- Defects: 17 in total, 1 blocker, 7 major, 9 minor (section 3). Security defects S1-S10: 1 blocker, 6 major (S2-S7), 3 minor (S8-S10). Functional/docs defects F1-F7: 1 major (F3), 6 minor.
- **Is the `.env` boundary closed? No, not completely.** What the owner asked to close is closed: across ~10 file names x 11 syntaxes x 44 dangerous keys (barrage below) no approval/test/state/URL/credential/PATH/BROWSER/NODE_OPTIONS/LD_PRELOAD/GIT_* value reaches `process.env` or changes a protected tool. What is not closed: (S2) the allowlisted `PRAXIS_JIRA_PROJECT_KEY` is unvalidated and is spliced into Jira REST paths and JQL, so a repository file can send the operator's token to arbitrary paths on the operator's Jira host (the allowlist doc says allowlisted values "cannot redirect a request"; false); (S3) values loaded from one repository's `.env` stay in the long-lived Runtime process and silently apply to every other repository (demonstrated against the shipped bundle: repo B's own key ignored, Jira calls for B and for a repo with no `.env` went to repo A's project); (S4) a FIFO named `.env` hangs the whole Runtime.
- **More important than `.env`:** S1. Repository files `.praxis/quality/adapter.mjs` (and modules named by `.praxis/quality/checks.json`) are `import()`ed inside the Runtime process by `verify-stories`, through `praxis_workflow_apply` and even `praxis_workflow_preview`, with no dialog. I demonstrated (a) reading the operator's `PRAXIS_JIRA_TOKEN` from that code and (b) capturing the secret review link from inside the Runtime and POSTing `acceptAll` as "the user": the requirements ended `accepted / html-review` with no user involved. An agent only needs to be able to write one file (no shell). This code is from alpha.48, not new, but it defeats the central guarantee of this overhaul ("the agent cannot record the user's acceptance") and the docs' stated boundary ("protects against an agent that only has the Praxis tools"). I consider it the release blocker for the claim; whether to ship alpha.49 with it documented as a known limit is the owner's call.

## 1. Verdict table

| # | Item | Verdict | Evidence (what I ran, what I saw) |
|---|---|---|---|
| 1 | New items default to guided; alpha.48 items stay classic, no data loss | **PASS** | `flow1.mjs`: `open` without `mode` -> `state.mode === "guided"`. `mig.mjs`: alpha.48 bundle from `git show d55ed5b:plugins/runtime/server/praxis-mcp.cjs` (md5 `806aadec...`, 52 tools) created `WI-LEGACY-LIST-001` (state version 1.0.0). New bundle: `praxis_workflow_status` shows mode classic; read-only call did not rewrite the file; `session_start` resumed it; first write migrated to 1.1.0, mode stays classic, 1 requirement / 1 story / 1 service / 1 implementation / 1 handoff kept, backup `WI-LEGACY-LIST-001.json.v1.0.0.bak` created; further writes keep classic; a new item opened next to it is guided. Mutation m4 (default `"classic"`) fails the unit test "a new work item opened without a mode is guided". Caveat: acceptance scripts always pass `mode` explicitly (`openItem(..., mode = "guided")`), so only the unit test guards the default. |
| 2 | Safe mode switching (`set-mode`, report, user decision for guided->classic) | **PARTIAL** | Works: agent classic->guided allowed with report (`dataKept`, `storiesWithoutPlanLine`, `stagesWithoutUserAcceptance`, `gatesAtCurrentPhase`), nothing deleted; agent guided->classic refused `USER_DECISION_REQUIRED` (also `" classic"` -> INVALID_INPUT); user page `modeChange:{to:"classic"}` works; `praxis_review_apply` with `modeChange` refused with no dialog (state unchanged) and works after an approved dialog whose text says "SWITCH this work item from guided to classic: stage gates ... stop being enforced (nothing is deleted)". Gap: **S6** an agent can simply `open` a NEW work item with `mode:"classic"` (gates off from the start, no user involvement) and nothing tells the user. |
| 3 | Contract `agreed` is a user decision | **PARTIAL** | Works: `set-contract` agreed by the agent refused for `status` `agreed` with any `via` (none/html-review/approved/user/system), with a forged `agreement` object, with case/space/zero-width/array/object variants (INVALID_INPUT); agent can propose; dev gate refuses `advance-phase development` with a proposed contract ("not agreed by the user"); user agrees on the contracts page (agreement `via: html-review`); changing an agreed contract makes it proposed; the page is bound to the contract content (a contract swapped after the page was rendered is reported as a conflict, not agreed: `secd.mjs`); review_apply shows the contract in the dialog. Mutation m1 (agent may agree): 2 unit tests fail, S08 and B06 fail. Defects: **S5** `remove-contract` by the agent deletes an agreed contract and the gate then passes with no contract at all (`flow1.mjs`); **S7** the gate is only checked when entering `development`: after entering, an agent can change the agreed contract (-> proposed), `record-implementation` and `advance-phase quality` still succeed (`flow2.mjs`); **S8** the approval dialog for agreeing a contract omits `description`, requirement and story ids, which are part of what is agreed. Docs (`workflow-stages.md:27`: "Implementation across services waits for it") are not true after entry (S7) or after removal (S5). |
| 4 | Plugin icons, zero validator warnings | **PASS** | I ran `claude plugin validate <dir> --profile directory` with temp HOME on all 6 Marketplace plugins: "Validation passed", 0 warnings each; `file .claude-plugin/icon.png`: "PNG image data, 512 x 512, 8-bit/color RGBA" for each. `npm run verify` in the Marketplace: `PASS validate-claude-plugins (6 plugins + the marketplace manifest, no errors, no warnings)`, `check-plugin-outputs` 6 checks, `test:rc` 6/6. Sub-agent additionally validated the unpacked role ZIPs and the full BA ZIP: 0 warnings. |
| 5 | Repository `.env` strict allowlist | **PARTIAL** | See section 2. Approval/credential/URL/exec/state keys: closed (no file route works). Open: S2, S3, S4, S9; and the broader "repository content -> trusted behaviour" question: S1. |
| 6 | License untouched, version unchanged | **PASS** | `git diff <merge-base>..HEAD` over `*LICENSE*`, `*NOTICE*`, `*COPYING*` and any `"license"` change in `package.json`/`plugin.json`/manifests in all six repos + Marketplace: none (only lockfile "license" fields of third-party packages in `package-lock.json`). Website diff touches no license file. `grep alpha.49`: no hits; `check:version` PASS 0.1.0-alpha.48. LICENSE-AUDIT.md exists only in the release directory. |
| a | No route lets an agent perform user confirmations | **PARTIAL** | All protocol routes closed (details below); **S1 bypasses them all** with a repository file. Also documented limit: an agent with a shell can edit `.praxis/workflow/items/*.json` directly (I confirmed a hand-edited state is trusted: `forge.mjs`; `docs/workflow-stages.md` "Known limits" and `user-approval.md` state it). |
| b | alpha.48 compatibility | **PASS** | `accept:tool-compat`: "PASS tool-compat (7 groups; alpha.48 = 52 tools, now 59)". Real alpha.48 state: migrated, continued (above). Approvals on an old item in the new Runtime: stale `previewFingerprint` refused, `confirmation:"NO"` -> `APPROVAL_REJECTED`, declined dialog refused, approved dialog confirms the story. Test-edit audit below: LEGIT, nothing weakened; one deliberate behaviour reversal (repository `.env` URL/credential no longer loaded) is documented as a change from alpha.48. |
| c | Real suites, mutation checks | **PASS** | See section 4. 5 of 5 mutations were caught (by unit tests; acceptance catches some). |
| d | Dustin items | **PARTIAL** | Seven canon skills present and working in the Marketplace plugin and in the full BA ZIP; `read -s -p` replaced and works in bash and zsh; N9/N10 of report 3 fixed. Defects F3-F5: the full ZIP is a build output only (gitignored, release workflow publishes only the 10-skill light ZIP, no doc says where to get it), no instructions create `.ba/`, several stale doc sentences. See section 5. |
| e | Functional defects of the whole flow | **PARTIAL** | Guided flow request -> requirements review -> prototype -> story plan -> stories -> architecture (contract) -> development -> quality (PASS feature verdict) -> delivery works end to end with real page saves (`flow3.mjs`); returning to requirements after delivery marks verdicts/implementations/stories stale, loses nothing, refuses to jump forward; a new MCP process resumes it (`praxis_session_start` resume names item, phase, next action). Defects: S5, S7, S6, F1, F2. |

### Per-route results for (a) (`seca.mjs`, 69 checks, shipped bundle, client without a dialog)

- Generic `praxis_workflow_apply` with every user-decision command (`accept-requirements`, `review-requirements` with a status, `accept-prototype`, `agree-story-plan`, `update-story-plan` op `review`, `review-stories`, `accept-stories`, `waive-coverage`, `set-contract` agreed, `set-mode` classic) and `via` in {absent, html-review, approved, user, system}: all refused (`USER_DECISION_REQUIRED` or INVALID_INPUT), no new accepted/agreed/approved/html-review value anywhere in the state file (before/after scan of every leaf). Forged `approval`, `batch`, `channel`, `via`, `grant`, `userApproval`, `approved` as command fields or tool arguments: refused (`sece.mjs`). `add-requirement`/`set-prototype`/`set-story-plan` with pre-filled `review`/`status: accepted|agreed|approved`: refused or ignored (final state: criteria pending, plan entry `planned`, requirement `proposed`).
- `praxis_review_apply` with no dialog (inline submission, file under `.praxis/workflow/reviews/<id>/`, file in repo root, fake approval args, odd confirmation text, `modeChange` classic): `APPROVAL_CLIENT_UI_REQUIRED`, state unchanged. File arguments `../../../../etc/passwd`, `/etc/passwd`, `../x.json`, `~/Downloads/../../.ssh/id_rsa`, NUL byte: refused.
- Page protocol (`secb.mjs`, 32 checks): POST without token, with the link token, with a tampered token, without Origin, foreign Origin, `Origin: null`, suffix-trick Origin, rebinding Host, `text/plain`: all refused with state unchanged; GET without token, `/r/../../etc/passwd`, GET on `/submit`: refused; submission for another view or work item: 400; stale page: per-item (a criterion unchanged since render is applied, a changed one is not; `acceptAll` with a stale fingerprint applies nothing); contracts page TOCTOU: conflict; story-plan/prototype stale pages accept nothing (`flow4.mjs`); replay of an identical save is idempotent; a save token of one page does not work on another session; 25 parallel saves and 20 writes from two Runtime processes leave valid JSON and unique ids; no link token or save token appears anywhere under `.praxis` or in any tool result; `workItemId` / `view` with `../x`, `..`, `/etc`, NUL, `WI-.../../../x` refused by render, status, inspect, select-work-item.
- Stored text with `</script><script>..`, `<img onerror>`, `<svg onload>` in titles, requirements, criteria, prototype labels/mock rows/state messages, stories, plan lines, services, contract fields: no script executed on any of the five pages in real Chrome (`window.PWN` stayed 0 after clicking every control); offline copy escaped.

### Test-edit audit for (b) (sub-agent, diffs read in full; I re-read `host-placeholders.test.ts`)

Baselines: Runtime `d55ed5b`, Core `0f71e38`. No baseline test deleted, no `.skip`/`.todo`/lowered count added, no assertion removed except the reversal below.

| File | Change | Verdict |
|---|---|---|
| core `contracts/milestone-1-2.test.ts`, `quality-evidence.test.ts`, `requirement-only-evidence.test.ts`, `workflow.test.ts` | `mode:"classic"` added at `openLocalWorkflow` call sites; assertions untouched; counts equal (5, 7, 8, 15) | LEGIT (alpha.48 behaviour kept for classic; guided equivalents exist in new `planning.test.ts`, `modes-contracts.test.ts`) |
| core `cli/dotenv-trust.test.ts` | trailing blank line | LEGIT |
| core `cli/host-placeholders.test.ts` | 9 -> 10 tests. A repository `.env` used to fill a blank URL/token placeholder; now only an allowlisted key (`PRAXIS_JIRA_PROJECT_KEY`) does and `PRAXIS_GITLAB_BASE_URL`, `PRAXIS_JIRA_BASE_URL`, `PRAXIS_GITLAB_TOKEN` assert `undefined`. Inverted on purpose, with a comment, plus `dotenv-allowlist.test.ts` (9) and runtime `dotenv-runtime.test.ts` (4) | LEGIT, deliberate compatibility break (alpha.48 users who kept Jira/GitLab URL or token in a repository `.env` lose that silently apart from the doctor's refused-key list; documented in `docs/repository-env.md`, website `cli.md`) |
| runtime `mcp/multi-work-item.test.ts`, `quality-evidence.test.ts`, `user-approval-flow.test.ts`, `workflow-inspect.test.ts` | `mode:"classic"` on the open calls | LEGIT; counts equal (13, 1, 28, 25) |
| runtime `tools/scripts/approval-ux`, `generic-quality`, `story-quality`, `workflow-external` acceptance | `mode:"classic"` on the open call | LEGIT |
| runtime `marketplace-install-acceptance.mjs` | one added check (15 skills, plugin-root paths exist) | LEGIT (additive) |

Gaps (not weakening): the evidence tests and four acceptance scripts exist only in classic; the guided equivalents are `ux-overhaul` S-scenarios, `ux-multirepo-e2e` (the only script that runs the guided flow to a delivered feature) and the unit tests. S01, S09, S10 of `ux-overhaul-acceptance` use classic for their full-flow claims.

## 2. Item 5 in detail: the repository `.env` boundary

**Method.** (1) In-process (`env1.mjs`, `callTool` of the built Runtime): for each of 10 file names (`.env`, `.env.praxis`, `.env.praxis.local`, `sub/.env`, `.praxis/.env`, `.praxis/env`, `.project`, `.env.local`, `.env.production`, `config/.env.praxis`) and 11 syntaxes (plain, `export `, spaces around `=`, lowercase, double and single quotes, CRLF, BOM, trailing comment, leading space/tab, zero-width space), a file containing 44 dangerous assignments (`PRAXIS_APPROVAL_MODE=trusted-client|host-permission`, `PRAXIS_TEST_APPROVALS`, `PRAXIS_APPROVAL_FORGED/STRICT`, `PRAXIS_STATE_HOME`, `PRAXIS_SKIP_DOTENV=0`, Jira/GitLab URL, token, email, Quality URL/port/adapter/token, knowledge path, `PRAXIS_REVIEW_OPEN`, `PRAXIS_TEST_REVIEW_NO_BROWSER`, `PATH`, `BROWSER`, `NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_SSH_COMMAND`, `HOME`, `HTTPS_PROXY`, `PRAXIS_BUNDLE_KIND`, ...) then `praxis_doctor` and `praxis_workflow_status`; diff of `process.env` against the baseline. Result: **0 forbidden keys leaked** (the only new variable is the allowlisted prefix `PRAXIS_JIRA_TRANSITION_DONE`, expected). (2) Shipped bundle over stdio (`env2.mjs`): `.env`, `.env.praxis`, `.env.praxis.local` all carrying `trusted-client`, `PRAXIS_TEST_APPROVALS`, `PATH=/tmp/q4/evilbin`, `BROWSER=...`, `PRAXIS_STATE_HOME`, `NODE_OPTIONS`, a Jira URL: protected `praxis_project_init_apply` -> `APPROVAL_CLIENT_UI_REQUIRED`, nothing written; the doctor lists the refused names (`PRAXIS_APPROVAL_MODE`, `PRAXIS_JIRA_BASE_URL`, `PRAXIS_STATE_HOME`, `PRAXIS_TEST_APPROVALS`, `PRAXIS_TEST_REVIEW_NO_BROWSER`; names only); `praxis_review_render` used the real `open` (the planted `open` in the `.env` PATH never ran); `/tmp/q4/evilstate` never created; the fake Jira received only requests addressed to the operator's base URL. (3) Precedence: among the three files the first read wins; the operator's environment wins over every file (unit test `priority:` passes; `PRAXIS_SKIP_DOTENV` is honoured only from the real environment). (4) Mutation: allowing `PRAXIS_APPROVAL_MODE` and `PRAXIS_TEST_APPROVALS` in `dotenvKeyAllowed` makes `dotenv-runtime.test.ts` fail 13 tests (all trusted-client / everything-at-once cases and the doctor test) and core `dotenv-allowlist.test.ts` fail 8; the acceptance scripts do not see it because they run with `PRAXIS_SKIP_DOTENV=1`.

**What does leak or hang.** S2, S3, S4, S9 below.

**Other repository content that changes trusted behaviour** (asked in the brief):

| Source | Effect | Verdict |
|---|---|---|
| `.praxis/quality/adapter.mjs`, `.praxis/quality/checks.json` + modules, `.py` modules | code runs in the Runtime process (or `python3`), no dialog, operator env visible | **S1 blocker** |
| `.project` `quality.test/build/coverage/install/start` | executed with `shell: true` and `env: process.env` by `praxis_developer_complete` (protected tool) and Jira workflows; by design a repository's own test command, but it receives the operator's tokens | note, pre-existing, not tested end to end (needs a work-package context) |
| `.project` `knowledge.path` (absolute allowed) | only rule count and ids are returned by `session_start`; a path outside the repository is read for `.md` front matter | minor, no content returned |
| `.project` `jira.baseUrl/projectKey` | not read by any code path (grep) | no effect |
| `.praxis/workflow/*.json` | trusted as state without integrity protection | documented limit (shell/file-write agent) |
| `.git/config` remote URL | decides the push/PR target (by design, in the preview); `PRAXIS_GIT_PROVIDER` from a file can flip GitHub/GitLab inference but API base URLs and tokens come only from the operator's environment | no redirect found |

## 3. Defects

### 3.1 Security defects

**S1 (blocker) Repository code runs inside the Runtime with no dialog; it can steal operator secrets and forge the user's acceptance.**
Repro (`/tmp/q4/h/poc.mjs`, `poc2.mjs`): client without a dialog; open a guided item, add a requirement and a service with `localPath`; write `<repo>/.praxis/quality/adapter.mjs`; apply `{"action":"verify-stories"}` through `praxis_workflow_apply` (it also runs from `praxis_workflow_preview`).
PoC 1: adapter top-level code wrote `token=OPERATOR-SECRET-TOKEN-123` (the Runtime's `PRAXIS_JIRA_TOKEN`) and the Runtime pid to a file.
PoC 2: adapter wraps `child_process.spawn`; the next `praxis_review_render` calls `open <secret link>` through the wrapper, which logs the link; the agent GETs it, takes `token` from the page's `praxis-data`, POSTs `{acceptAll:true}` with the right Origin: HTTP 200, both criteria `accepted` / `html-review`.
Expected: repository content must not execute in the Runtime without the user's approval (or must run out of process with a scrubbed environment); at minimum the doc must name it as a limit.
Observed: both succeed. `docs/workflow-stages.md` "Known limits" only mentions an agent with an unrestricted shell. Not new in alpha.48 (`loadAdapter` predates it), but it voids the guarantees of items 3 and (a).
Files: `praxis-runtime/packages/mcp/src/story-engine.ts:52-62` (`loadAdapter` -> `import()`), `:64-75` (`loadModule`), `:141-168`; `generic-verification.ts:98-124` (`runSteps`: `import()` for JS, `python3` for `.py`), `:127-134` (`readChecks`); `tools.ts:502-510` (runs on preview and apply, not in `PROTECTED_TOOLS` semantics for this command).

**S2 (major) `PRAXIS_JIRA_PROJECT_KEY` from a repository file is unvalidated: path and JQL injection with the operator's credentials; the allowlist claim is false.**
Repro (`env2.mjs`): operator env has Jira URL, token, email, mode; repository `.env` has `PRAXIS_JIRA_PROJECT_KEY=X/../../rest/api/2/myself?a=b#`; `praxis_jira_discover`. The fake Jira received `GET /rest/api/2/rest/api/2/myself?a=b` with the operator's `Authorization`. The same value is also interpolated into JQL (`project = <key>`) and into POST bodies.
Expected: a key matching `^[A-Z][A-Z0-9_]+$` or refused; `docs/repository-env.md` says allowlisted values "cannot redirect a request".
Observed: any string. Files: `praxis-core/plugins/jira/src/config.ts:124`, `rest-provider.ts:710,731,740`, `quality-apply.ts:438`; allowlist `packages/cli/src/operations.ts:257`. Same class for the other allowlisted values (`PRAXIS_JIRA_STORY_POINTS_FIELD` becomes a JSON field name, `PRAXIS_JIRA_TRANSITION_*` an id, types): not validated either; I did not test the write previews (Jira writes need the dialog; I could not verify that the dialog shows the key).

**S3 (major) Values loaded from one repository's `.env` persist in the Runtime process and apply to all other repositories.**
Repro (`env4.mjs`, shipped bundle, operator sets Jira URL/token but not the key): repos A (`KEY=AAA`), B (`KEY=BBB`), C (no `.env`); `praxis_doctor` on A, B, C, then `praxis_jira_discover` on A, B, C. Result: all three Jira calls were `GET /rest/api/2/project/AAA/version`; C reports `projectKeyConfigured:true`. In-process (`env1.mjs`): `process.env.PRAXIS_JIRA_PROJECT_KEY` is `AAA` after A, still `AAA` after B and after C.
Expected: file values scoped to the call (set and restore) so another repository's file or its absence is honoured; the operator's real value untouched.
Observed: `loadPraxisDotenv` assigns `process.env[k]` and never restores; `if (process.env[k]) continue` then treats the first repository's value as if the operator had set it. Same for `PRAXIS_GIT_PROVIDER` (verified in-process: `gitlab` stays) and the other allowlisted keys. An agent in repository A can therefore steer Jira/Git behaviour for work in repository B.
File: `praxis-core/packages/cli/src/operations.ts:289-312` (assignment at `:310`); called per tool call from `praxis-runtime/packages/mcp/src/tools.ts:282`.

**S4 (major, availability) A FIFO (or any blocking file) named `.env` hangs the whole Runtime.**
Repro (`env3.mjs`): `mkfifo <repo>/.env`; any tool call with that `repo`: no answer after 8 s, and a following call for a clean repository also never returns (single process, synchronous `readFileSync`). A very large `.env` costs a full read per tool call; no size cap or `lstat` regular-file check.
File: `operations.ts:297-301`.

**S5 (major) The agent can delete an agreed contract and the development gate then passes with no contract.**
Repro (`flow1.mjs`): user agrees `C-1` on the contracts page; agent applies `{"action":"remove-contract","id":"C-1"}` (ok, no dialog); `advance-phase development` succeeds, `state.contracts.length === 0`. Nothing requires a contract when there are several services, and `isUserDecision` does not cover `remove-contract`.
Expected: removing an agreed contract is a user decision (or leaves a record that blocks the gate).
Files: `praxis-core/packages/contracts/src/planning.ts:1188-1209` (`isUserDecision`), `:1594-1596` (`remove-contract`), `:999` (gate checks only existing contracts).

**S6 (major) An agent can open a new work item directly in classic mode, with the gates off, without the user.**
Repro (`mig.mjs` last probe): `{"action":"open",...,"mode":"classic"}` is accepted; `state.mode === "classic"`; nothing is shown to the user (the `modeNote` goes to the agent). Decision 2 says switching the gates off is the user's call; opening is an unguarded back door to the same effect. Also classic items accept `advance-phase` to any phase unchecked.
File: `praxis-core/packages/contracts/src/workflow.ts:414-420,1382` and `planning.ts:1201-1202` (only `set-mode` is guarded).

**S7 (major) The contract gate is only checked when entering `development`.**
Repro (`flow2.mjs`): enter development with an agreed contract; agent `set-contract` with a changed `schemaRef` -> `proposed`; `record-implementation` for both services succeeds; `advance-phase quality` succeeds; delivery has no contract condition (`phaseGates` `:1011-1018`). The user is never asked again. Contradicts `docs/workflow-stages.md:27` ("Implementation across services waits for it, and changing an agreed contract makes it proposed again": the second half is true, the first is not after entry).
File: `planning.ts:999` (only in the `development` case).

**S8 (minor) The contract agreement dialog is incomplete.** For a contract with `description: "GET /orders returns {items:[]}"` the dialog line is `AGREE contract C-1 'Orders API': provider api, consumers web, schema openapi.yaml#/orders`: description, requirement and story ids are part of the agreed content (they are in the hash that "changed contract -> proposed" uses) but are not shown. Source: `review-submission.ts` detail line for contracts.

**S9 (minor) `.env` parsing is silently different from what users expect, and the doc does not say.** `env5.mjs`: LF `KEY=value` loads; CRLF, a BOM on the first line, and `export KEY=value` are silently ignored (no entry in the doctor, which lists only refused `PRAXIS_*` names); `KEY=value # comment` keeps the comment in the value; `KEY=value  ` keeps trailing spaces (a project key with spaces reaches S2). Safe, but a functional trap on Windows. File: `operations.ts:299-312` (`/^([A-Z0-9_]+)=(.*)$/`, no trim).

**S10 (minor) `praxis_review_render` is typed `read` but has side effects without the user.** It writes files and opens a browser tab on every call: 30 agent calls produced 30 `open` invocations (`spam.mjs`); no rate limit or de-duplication (a live page for the same view is not reused). The tool text says "Does not change workflow state". File: `review-service.ts:268-316`. Related minor: `praxis_frontend_discover` (`path` argument) and `praxis_repository_inspect` (agent-registered `localPath`) read any directory the Runtime can read and return file and directory names (e.g. `screenCandidates: ["src/pages/PrivatePayroll.tsx"]`, `instructionFiles`, parsed colours) from outside the registered repositories (`insp.mjs`); content is not returned.

### 3.2 Functional and documentation defects

**F1 (minor, pre-existing in alpha.48, confirmed with the old bundle) Opening a second work item with the same title and a different request silently returns the first one.** `ids2.mjs` and `ids3.mjs` (old bundle): `open` title "Order list" request "first" then request "SECOND different": same id `WI-ORDER-LIST-001`, `duplicate:true`, `ok:true`, one item in the list; the second request is lost. Non-Latin titles all become `WI-WORK-00N` (not descriptive for the Russian-speaking owner; unique, so only a usability note).

**F2 (minor) Catalog text does not match behaviour.** `praxis_workflow_commands` lists `set-contract` as `userOnly:false` with optional `via` and `set-mode` as `userOnly:false` although `agreed` and `classic` are user decisions; the `praxis_workflow_preview` description lists the old command set; no tool description mentions modes or the default. (`catalog.ts:780-790`, `:911-913`; `command-catalog.ts:46-50` computes `userOnly` from a template that lacks the conditional fields.)

**F3 (major for Desktop Chat users; minor otherwise) The full BA ZIP (the only artifact with the canon skills for Chat) has no distribution path.** `praxis-ba/.gitignore` ignores `dist/`; the committed `claude-plugins/praxis-ba.zip` is the light ZIP (10 skills); `.github/workflows/release.yml:25,40` runs `pack:zip` and uploads only `dist/claude-plugins/**/praxis-ba.zip`; `pack:full-zip` is not run; website `installation.md:14,26` offers one `praxis-ba.zip` described as "BA Skills only"; `ba.md` tabulates a "Desktop Chat full ZIP" and never says where to get it. (Report 3 called the full ZIP "committed"; it is not.) Wording that is wrong for the full ZIP: `installation.md:26`, `ba-only.md:3`, `platform/ba.md:41`, `pack-claude-plugins.mjs:161` ("skills-only upload").

**F4 (minor) No user-facing way to create the canon root.** `praxis-ba id next --scope cr --repo <empty dir>` -> `ENOENT .../.ba/.lock` (re-run by me); `ba-scaffold` says it does not create the canon; `epic add` is named by no skill or doc; only the maintainer README (Marketplace plugin only) explains `.ba/counters.yaml`. (Sub-agent; the ENOENT I reproduced.)

**F5 (minor, sub-agent findings; not individually re-run by me)** Website `docs/guide/handoffs.md:56-72` example handoff is stale (`version`, `workPackagePath`, check names differ from real output) and names a source-only path; `ba.md:27` lists 5 CLI-dependent skills, at least 15 depend on the CLI; `plugins/ba/README.md:129` says `link_root` is a required link prefix but `gates.ts:85` does not use it for matching; `shape-requirement` Case A runs `validate --check` before `cr realize`, which fails with a misleading `cr-citations-declared` message; `accept` with incomplete evidence prints a raw zod array; the `stty -echo` snippet leaves echo off after Ctrl-C.

**F6 (minor) Test design.** Acceptance scripts pass `mode` explicitly (so the default is guarded by one unit test only), run with `PRAXIS_SKIP_DOTENV=1` (so the `.env` boundary is guarded by unit tests only), and the full-flow scenarios S01/S09/S10 run in classic; the guided end-to-end exists only in `ux-multirepo-e2e` (passes: 6 stages, 135 checks). My guided end-to-end (`flow3.mjs`) passes but no committed script does what it does for a single-repository item (including a return to an earlier stage after delivery). The stale-page checks for stories/prototype/plan are covered by unit and browser tests, which I confirmed only for the contracts and requirements pages by direct tests.

**F7 (note) Concurrency between sessions.** Two Runtime processes writing the same item concurrently produced `FINGERPRINT_MISMATCH` for 18 of 20 preview/apply pairs (alpha.48 design: preview binds to the state revision); the state stays valid JSON. Not a defect, but agents in two sessions will see frequent retries.

## 4. Suites run (all in my clones, temp HOME)

| Suite | Result |
|---|---|
| Core `npm test` | 438 passed, 5 skipped (the skipped ones are `quality-ensure` `needsService` and a root-only `delivery` test, unchanged by this work); `typecheck` exit 0; `check:tests` "58 test file(s), 0 problem(s)" |
| Runtime `npm test` | 179 + 38 + 77 passed (`packages/mcp` 179 incl. `planning-tools` 33, `dotenv-runtime` 4); `typecheck` exit 0; `check:tests`, `check:version` pass |
| `accept:ux-overhaul` | "18/18 scenarios passed; 334 checks; Jira requests: 2" |
| `accept:ux-browser` (real Chrome, Playwright) | "6/6 browser scenarios passed (automated, real Chrome); 72 checks" (B06 contracts review included) |
| `accept:ux-multirepo` | "PASS multi-repo E2E: 6 stages, 135 checks, 3 repositories" |
| `accept:tool-compat` | PASS (52 -> 59 tools) |
| `accept:approval-ux` | PASS (19 checks) |
| `accept:workflow`, `accept:stories`, `accept:generic`, `accept:mcpb-runtime`, `accept:quality-review` | pass |
| Marketplace `npm run verify` | PASS (check-marketplace, check-plugin-outputs 6 checks incl. 31 `${CLAUDE_PLUGIN_ROOT}` references, validate-claude-plugins 0 warnings, test:rc 6/6) |
| BA `full-zip-acceptance`, `skill-list --check`, `check-skill-cli`, `plugin-validate-acceptance` | pass (sub-agent run: 29 skills, 17 plugin-root references resolve, CLI runs with no `node_modules`) |
| Vendored Core in Runtime vs a fresh `pack:vendor` of Core HEAD | identical file contents for contracts, cli, jira, knowledge, project-config, vcs |

**Mutations** (each in a separate copy; unit = `npm test -w @praxis/mcp`):

| # | Mutation | Caught by |
|---|---|---|
| m1 | `isUserDecision`: `set-contract` agreed no longer a user decision | unit 2 failures; S08; B06 (acceptance); core `modes-contracts.test.ts` 2 failures |
| m2 | `dotenvKeyAllowed` allows `PRAXIS_APPROVAL_MODE`, `PRAXIS_TEST_APPROVALS` | unit (`dotenv-runtime`) failures; core `dotenv-allowlist`/`dotenv-trust` 8 failures; **not** by acceptance (SKIP_DOTENV) |
| m3 | Origin check removed from the review server | unit 2 failures; S03 of `ux-overhaul` (new since report 3); **not** by the browser scenarios |
| m4 | default mode `classic` | unit 1 failure; **not** by acceptance (explicit modes) |
| m5 | (core) allowlist and `set-contract` mutations | core tests fail as in m1/m2 |

## 5. Dustin items (details)

Verified by me: Marketplace verify and validation (above); `bin/praxis-ba.cjs` in the Marketplace plugin fails with ENOENT on an empty directory (F4); full ZIP not committed and not in the release workflow (F3). Sub-agent (`/tmp/q4-a2`, same rules): both artifacts contain `capture-cr`, `grill-cr`, `ba-plan-slice`, `shape-requirement`, `prepare-wp`, `approve-plan`, `accept` (29 skills each); the real CLI from both (`tools/praxis-ba.cjs` in the ZIP, `bin/praxis-ba.cjs` in the plugin) produced identical output through `vision confirm`, `epic add`, `id next`, `cr confirm --entry requirement --impacts-file`, `req edit --activate`, `cr realize --spawn`, `wp prepare` (11 gates OK), `wp approve-plan` (refused without `plan.md`, wrong `--plan`; OK with the right one; handoff JSON emitted), `accept` (refused without `--evidence`, with wrong commit; OK with the right commit; `BL-20260103` written); `cr capture`, `baseline`, `req add`, `wp author` are refused. N9 and N10 of report 3 are fixed. `read -s -p`: the only remaining occurrence is prose in website `cli.md:63` saying it does not work in zsh; the replacement (`printf` + `stty -echo` + `IFS= read -r` + `stty echo`) ran under a pty in bash 3.2 and zsh 5.9: not echoed, assigned, exported; `zsh -c 'read -s -p "tok: " V'` fails with `read: -p: no coprocess` as the doc says. Doc claims table: skill counts, per-skill plugin/full/light matrix, CLI "26 usable paths", paths, install names true; false or incomplete rows are F3 and F5.

## 6. What I could not verify

- Claude Desktop / Claude Code UI behaviour: how the elicitation dialog renders, whether Desktop auto-approves protected tools, whether a user would notice an unexpected browser tab. The "user" in every test is a scripted MCP client answering `approve`/`decline` and my own `fetch` to the loopback page.
- Linux and Windows: `xdg-open` honouring `$BROWSER` (report 3's N8) is now unreachable through `.env`, but I could not execute it on this Mac; `explorer.exe` return code behaviour not tested.
- Real Jira, GitHub, GitLab: only a local fake Jira. The preview text of Jira write tools was not inspected, so I cannot say whether the dialog shows a hostile project key (S2) or a hostile transition id.
- `praxis_developer_complete` and Jira workflows executing `.project` `quality.*` commands with the operator's environment: read in code, not run.
- Huge `.env` files (memory), and `.env` read through symlinks to other files (reads the target; only allowlisted keys are used, so no content leaks).
- The stale-page checks for stories, prototype and plan beyond what `flow4.mjs` shows (the stories check in `flow4.mjs` does not prove the control case; the unit/browser suites cover it).
- Sub-agent results F3-F5 other than the items I reproduced.

## 7. Open defects by severity

- Blocker: S1.
- Major: S2, S3, S4, S5, S6, S7 (security/gate integrity); F3 (distribution of the full BA ZIP).
- Minor: S8, S9, S10, F1, F2, F4, F5, F6, F7.
- The `.env` boundary: closed for approvals, test switches, state location, credentials, URLs, executables and environment; **not closed** while S2 (unvalidated key in request paths/JQL), S3 (cross-repository leakage) and S4 (hang) stand, and S1 shows the same class of problem (repository content controlling trusted behaviour) through a different file.

---

## Round 5 (current code; fresh clones in `/tmp/q5`, my scripts re-pointed in `/tmp/q5/h`)

HEADs: Core `ddcda3b`, Runtime `e9841a8`, BA `2bb5a20`, Architect `892fd75`, Developer `bed5c63`, Quality `039c9b5`, Marketplace `51380c2`, website `474dc2c`. Rebuilt Runtime bundle is byte-identical to the committed one and to the Marketplace copy (md5 `490ae082...`). License files and `license` fields: still untouched in all six repos; version still `0.1.0-alpha.48`.

### R5.1 Status of every round-4 defect

| Id | Status | Evidence |
|---|---|---|
| S1 repository code in the Runtime | **PARTIAL** | The two round-4 PoCs fail now (`poc.mjs`: token `undefined`; `poc2.mjs`: no captured link). Project code runs in a child Node process with a scrubbed env (`project-code-runner.ts`); legit adapters still work (`adp.mjs`: adapter with stdout noise and `ctx.loadModule` -> PASS_WITH_RISKS; throw, early `process.exit`, syntax error -> clean refusals). But the isolation is not a security boundary against deliberate code, and the docs overclaim: see N2. |
| S2 project-key shape | **FIXED** | `env2.mjs`: `X/../../rest/api/2/myself?a=b#` is refused (doctor lists `PRAXIS_JIRA_PROJECT_KEY` as rejected), no Jira request at all. Shapes in `operations.ts:277-287`. Residual (minor, N5): `PRAXIS_JIRA_*_FIELD` accepts any plain name (`description`, `summary`, `labels`), so a file can aim story points at another Jira field. |
| S3 cross-repo leakage | **FIXED** | `env1.mjs`: after A `AAA`, after B `BBB`, after C `undefined`; `env4.mjs` on the bundle: Jira calls went to `AAA` then `BBB`, C reports `projectKeyConfigured:false`; `env6.mjs` (5 concurrent discover calls on A,B,C,A,B) each used its own key. Not proven for calls that interleave around an `await` after the config is read (restore happens at the next call's load). |
| S4 FIFO hang | **FIXED** | `env3.mjs`: FIFO `.env`: doctor returns, a second repo is served. `lstat`, regular file, 64 KB cap, no symlinks. (A swap between `lstat` and `readFileSync` is theoretically racy; not exploited.) |
| S5 remove agreed contract | **PARTIAL** | Direct `remove-contract` of an agreed contract is refused `USER_DECISION_REQUIRED`. **Bypass (N1)**: the agent edits the agreed contract (becomes `proposed`, allowed), then `remove-contract` (allowed for a proposed one): `s5b.mjs` -> contracts 0, no dialog. |
| S6 agent opens classic | **PARTIAL (judgement below)** | `open ... mode:"classic"` still accepted; it now writes a session-log note ("opened in classic mode: ... user decisions still are"). |
| S7 gate after entry | **FIXED** | `flow2/3.mjs`: after the agent changes an agreed contract, `advance-phase quality` is refused ("not agreed by the user (it was changed after implementation started?)"); `record-implementation` still works (by design); after the user re-agrees the flow reaches delivery. Core mutation c5 caught. |
| S8 dialog content | **FIXED** | `dlg.mjs`: line now ends `, description 'GET /orders returns {items:[]}'`. (Requirement/story ids shown only if the contract has them; not exercised.) |
| S9 `.env` parsing | **FIXED** | `env5.mjs`: CRLF, BOM, `export`, trailing space, inline comment now load the clean value. |
| S10 tab spam; any-path discovery | **FIXED / NOT FIXED** | 30 `praxis_review_render` calls -> 1 browser open (reuse; `reopen:true` forces). The link is no longer in argv (below). `praxis_frontend_discover(path)` and `praxis_repository_inspect` still read any directory (`insp.mjs`): unchanged, minor, not claimed. |
| F1 duplicate title | **NOT FIXED** (not claimed) | `ids2.mjs`: same id, `duplicate:true`, second request dropped. |
| F2 catalog | **FIXED** | `set-contract`: `userOnlyWhen "contract.status is agreed"`; `set-mode` "mode is classic"; `remove-contract` "the contract was agreed by the user". |
| F3 full BA ZIP | **FIXED (workflow not run)** | `release.yml` now runs `pack:full-zip`, `accept:full-zip`, copies to `praxis-ba-full.zip` and uploads it. I ran those commands locally: `accept:full-zip` passes (29 skills, 17 root references, CLI `VERIFY-OK`), `praxis-ba-full.zip` has 29 skills, the light ZIP 10. Website `installation.md:27` and `plugins/ba/README.md:56` describe light vs full. |
| F4 canon root | **NOT FIXED** | `praxis-ba id next --scope cr --repo <empty>` still `ENOENT .../.ba/.lock`. |
| F5 stale BA docs | not re-checked | |
| F6 acceptance coverage | **FIXED** | `accept:ux-overhaul` 19/19 (344 checks): S01 opens without a mode and asserts guided; S20 runs the packaged bundle with dotenv enabled and hostile files. Mutations n1, n2 (below) fail S20. |
| F7 concurrency note | unchanged (note) | |

### R5.2 Attack on the project-code isolation (new `poc3.mjs`)

Setup: repository files only (no shell, no state-file edit): `.praxis/quality/adapter.mjs` and `daemon.mjs`; the agent applies `verify-stories`, then later calls `praxis_review_render`.
1. The adapter child reads the Runtime's environment: `ps eww -p <process.ppid>` printed `PRAXIS_JIRA_TOKEN=OPERATOR-SECRET-TOKEN-123` (`token_visible=true`, macOS; on Linux `/proc/<ppid>/environ` is the same-user equivalent). The scrubbed env protects only against `process.env`, not against a same-user process.
2. The adapter starts a detached daemon (`spawn(..., {detached:true}).unref()`); it survives the run. After the agent's `praxis_review_render` the daemon read the new `praxis-open-*/open-review.html` in the Runtime's temp dir (same user, mode 0600/0700 does not stop the same uid), extracted the link, loaded the page, POSTed `acceptAll`: `forged status 200`, criteria `accepted / html-review`.
So the answer to "can adapter/check code forge the user's acceptance through a route other than editing state files": **yes**, through the capture of the review link. It is in the same capability class as editing state (same-user code), and the docs say project code "runs as you", but the docs also say it "cannot read the Runtime's secrets or its memory" (`workflow-stages.md:75`), which is false for secrets on macOS/Linux. Not reachable: the Runtime's heap/pid state, the approval channel (it lives in the MCP client; no way found), `process.env` of the Runtime through the module system.
Not scrubbed although the coordinator's note says "project test runs": `developer-complete.ts:152` and `jira/workflows.ts:729` (`env: process.env`), `review-engine.ts:190`, `wp-review.ts:142` (`{...process.env}`) still run `.project` `quality.test`/`npm run test` with the Runtime's environment. Story-engine and generic-verification test runs are scrubbed (`story-engine.ts:72,86`, `generic-verification.ts:109`). I read this in code; I could not run the Quality service here (`praxis_quality_ensure` fails in the bare bundle), so it is not demonstrated.

### R5.3 New defects introduced or found this round

- **N1 (major) Contract removal can be laundered.** `s5b.mjs`: user agrees C-1 on the page; agent `set-contract` with a changed `schemaRef` (-> `proposed`); agent `remove-contract` (allowed, it is proposed now); `contracts` is empty and the quality/delivery gates have nothing to check. The core test for S5 only covers the direct removal. Expected: removal of a contract that was ever agreed (keep `agreement` history, or tombstone) needs the user, or the gate must remember removed agreed contracts. `planning.ts` `remove-contract` case (~line 1596-1600) checks `doomed.status` only.
- **N2 (major, claim) "cannot read the Runtime's secrets" is false** and project code can still capture the review link (R5.2). Either fix the wording (project code is the user's code with the user's privileges; the isolation limits accidents and in-process tampering) or add real separation. Until the claim is corrected the S1 documentation is wrong. Also `.project` test commands and Quality-service test runs still inherit the full environment.
- **N3 (minor) Link-in-file opener.** The page is opened through `open <tmp>/open-review.html` with a meta refresh. Works in Chrome (`chrome-open.mjs`: file mode 600, dir 700, landed on the live review, file removed after 15 s). Risks: if the default `.html` handler is not a browser (an editor) or a cold browser takes longer than 15 s the user gets a missing file or the source, and the reuse logic then tells the agent the review "is already open" for 10 minutes (the agent has to know to pass `reopen:true`); the link is still in browser history. Previously `open <url>` always used the browser.
- **N4 (minor) Reuse logic.** A reused review keeps the old fingerprint: if the agent changed the artifact after the tab was opened, the user's save reports conflicts (safe), but the tool says "already open" without saying it is stale. Not a security issue.
- **N5 (minor) `PRAXIS_JIRA_*_FIELD` shape allows any field name** (see S2 residual).
- **N6 (minor, test design)** Runtime unit tests do not catch mutations of `dotenvValueValid`, the scoping restore, the agent-removal rule or the quality/delivery gates; only the Core suite and (for `.env`) S20 do. Fine as long as both suites run in `verify`.

### R5.4 Judgement on S6 (agent may open classic)

I accept it as a product decision, with a condition. The decision text said leaving guided is the user's. Opening a new item in classic is not leaving guided, user decisions (acceptance, agreement, waiver, mode switch to classic) stay enforced in classic (verified in `seca.mjs` on classic items and by `mig.mjs`), and classic still records the stage. What the agent gains is skipping process gates (plan before stories, prototype, coverage, contract gate). The new note is written to the session log, which the agent reads and the user does not unless told; the `open` result carries nothing. Condition: show it where the user decides, for example in the `open` result and in the next dialog or briefing, or make `mode:"classic"` at open need the dialog. Residual: minor (process-gate bypass without user knowledge), not a decision-integrity break.

### R5.5 Suites and mutation checks, round 5

| Suite | Result |
|---|---|
| Core `npm test` | 93 + 191 + 14 + 12 + 6 + 1 + 127 + 28 + 64 + 1 passed, 5 skipped (unchanged environment skips); typecheck 0 |
| Runtime `npm test` | 184 (`packages/mcp`) + 38 + 77 passed; typecheck 0; `check:tests`, `check:version` pass |
| `accept:ux-overhaul` | 19/19, 344 checks (S20 new) |
| `accept:ux-browser` (real Chrome) | 6/6, 72 checks |
| `accept:ux-multirepo` | PASS, 6 stages, 135 checks |
| `accept:tool-compat` | PASS, 52 -> 59 |
| `accept:approval-ux`, `workflow`, `stories`, `generic`, `mcpb-runtime`, `quality-review` | pass |
| Marketplace `verify` | PASS (0 warnings, 31 root references, `test:rc`) |
| BA `pack:full-zip` + `accept:full-zip` | pass (local) |
| Chrome XSS (`xss2.mjs`, five pages) | no script executed |
| Round-4 scripts `seca` (69), `secb` (32), `secc` (10), `secd`, `flow4`, `mig` (19) | all PASS; the only FAILs are probes that now correctly fail (remove agreed contract; quality while contract unagreed), `sece` (my own over-strict assertion, state unchanged) and `forge` (documented state-file limit) |

Mutations (each in its own copy):

| Mutation | Caught by |
|---|---|
| `dotenvValueValid` returns true | Core `dotenv-allowlist.test.ts` (S2 test); packaged `accept:ux-overhaul` S20; not by Runtime unit tests |
| remove the scoping restore | Core `dotenv-allowlist.test.ts` (S3 test); S20; not by Runtime unit tests |
| agent may remove an agreed contract | Core `modes-contracts.test.ts` (S5 test); not by any Runtime test or acceptance |
| quality/delivery contract gates removed | Core `modes-contracts.test.ts` (S7 test); not by any Runtime test or acceptance |
| project code spawned with the full environment (stand-in for "in-process again") | Runtime `project-code-isolation.test.ts`, 2 failures |

### R5.6 Re-judgement

**`.env` boundary: closed.** Barrage of 10 files x 11 syntaxes x 44 keys: 0 leaks; value shapes stop path/query/JQL; scoping stops cross-repository carry-over; FIFO, symlink and size are handled; packaged-bundle acceptance S20 guards it with dotenv enabled. Residuals are minor (N5, a theoretical `lstat`/read race).

**"The agent cannot perform user confirmations": holds for the Praxis tool route, not as an absolute.** Every protocol route stays closed (round-4 matrix re-run, 100+ checks). It does not hold against (a) agents with a file-write tool editing unsigned state (documented), (b) any same-user code started from repository files, which can additionally read the Runtime's secrets and capture the review link (R5.2; the docs say the opposite for secrets, N2), and (c) laundering of a removed agreed contract through N1.

### R5.7 Per-defect summary

FIXED: S2, S3, S4, S7, S8, S9, F2, F3 (workflow not run), F6, S10 (tab spam). PARTIAL: S1, S5, S6 (accepted with a condition). NOT FIXED: F1, F4, any-path discovery; F5/F7 not re-checked. New: N1 major, N2 major, N3-N6 minor.

Open by severity: major N1, N2 (S1/S5 residue); minor F1, F4, N3, N4, N5, N6, discovery paths, F5.

### R5.8 Verdict

**Not an unconditional Quality PASS for alpha.49 preparation.** The product-decision work (guided default, set-mode, user-agreed contracts, icons, `.env`) is solid and well tested. Two items block an unqualified PASS: **N1** (an agent can erase what the user agreed, with no dialog) is a small fix with a clear test; **N2** is a wrong security claim in the docs (and the isolation is weaker than described). If N1 is fixed and the Known-limits sentence is corrected to say that project code runs with the user's privileges and can read the Runtime's environment and the review link, I would pass it, accepting N3-N6 and the minors as documented limits. Not verified in this round: Claude Desktop UI, Linux/Windows openers, real Jira/GitHub, the Quality-service environment (R5.2), the not-yet-run release workflow.

## Round 6 (fresh clones `/tmp/q6`: Core `faa9076`, Runtime `aa7b97a`, BA `be5112a`)

| Item | Result | Evidence |
|---|---|---|
| N1 laundering of an agreed contract | **FIXED** | `s5b.mjs`: user agrees, agent edits (-> proposed), agent `remove-contract` is refused; the contract stays. `s5c.mjs`: injecting `everAgreed:false` and a fake `agreement` in the agent's `set-contract` is stripped and `everAgreed:true` is kept. Direct removal, the quality/delivery gates (`flow1`, `flow3`) and the user's own removal path behave as before. |
| N2 docs | **FIXED, accurate** | `workflow-stages.md:75` now says project code is not a security boundary, runs with the user's privileges, can read other processes' environment and arguments (`ps`), state files and the short-lived review-open file, and that `.project` test commands and the Quality service inherit the environment. `poc3.mjs` on the fresh clone still reproduces exactly those three behaviours (token visible via `ps eww`, link file captured, acceptance forged by a same-user daemon), so the sentence now matches what happens. The forgery route remains, as a documented limit. |
| S6 condition | **FIXED** | `open ... mode:"classic"` result now carries `mode` and a `note` ("This work item is classic: ... user decisions still are"), plus the session-log line; the BA skill tells the user. |
| N4 | **FIXED** (text) | reused-review text updated (not exercised beyond reading). |
| Regression check | none found | Core tests: 93 + 193 + 14 + 12 + 6 + 1 + 127 + 28 + 64 + 1 passed, 5 environment skips. Runtime: 184 + 38 + 77 passed. `accept:ux-overhaul` 19/19, 344 checks. My scripts `seca` (69), `flow1/flow3` (only the inverted probes fail, as intended), `mig` (19, alpha.48 migration intact with the new `everAgreed` field defaulting for old states), `s6` pass. |

Remaining open (all minor or documented limits): F1 duplicate title returns the existing item, F4 canon-root bootstrap, N3 opener temp-file edge cases, N5 Jira field-name shape, N6 Runtime-level test coverage of the contract rules (Core tests cover them), any-path discovery, F5. Not verified: Claude Desktop UI, Linux/Windows openers, real Jira/GitHub, the Quality-service environment, the unrun release workflow.

**Verdict: independent Quality PASS for alpha.49 preparation**, with the documented limits above (project code and file-write agents are outside the user-decision guarantee; the guarantee covers the Praxis tool route) and the minor open items accepted by the owner. No blockers remain.
