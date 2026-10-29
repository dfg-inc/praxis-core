# Quality report 3

Verifier: independent Quality. Same read-only rules. Copies in `/tmp/q3` (`rt`, `core`, `ba`, my scripts in `h/`, `canonflow.mjs`, unpacked archives `zipx`, `zipf`, `zv`). `HOME` and `PRAXIS_STATE_HOME` pointed at `/tmp/q3/home`; the browser opener was shimmed (`/tmp/q3/shim`). One accident: while checking `claude plugin install --help` I ran `claude plugin install nonexistent-plugin --marketplace dfg-inc/praxis-marketplace`, which started a marketplace clone from the public GitHub repository into the temp HOME (nothing was installed, nothing touched `~/.claude`). HEADs under test: Core `f8c7058`, Runtime `7c96e76`, BA `3c5c249`, Marketplace `9e32160`, website branch `docs/ux-overhaul` `938b252`.

## 0. Summary

- N1 (the `.env` route) is closed, but the same mechanism has a second door: a repository `.env` can still inject **any other environment variable** into the Runtime process (`BROWSER`, `LD_PRELOAD`, `NODE_OPTIONS`, `GIT_ASKPASS` ... demonstrated). On Linux, `xdg-open` honours `$BROWSER`, so an agent that can write a project file can make the Runtime hand the secret link to an agent-written script (N8, blocker on Linux; not executable on this Mac, see section 1).
- Of the items under re-check: N1 FIXED (with N8 open), N2 PARTIAL, N3 FIXED (residual), N4 FIXED, N5 FIXED, N6 FIXED, D04 PARTIAL, D07 PARTIAL, D19 NOT FIXED.
- Tests: B01-B05, M (multi-repo E2E) and tool-compat are real tests, not tautologies; I broke behaviour in my copy and each of the three caught something. Two weaknesses found: the Origin check is covered by no acceptance script (mutation survived all three scripts; only a unit test catches it), and the unit test for N1 is a source-text grep that fails when `praxis-core` is not a sibling directory (T1).
- REMARKS-MATRIX: 3 of 20 claims overstated or wrong (rows 3, 14, 19), the rest hold.
- Dustin items: seven canon skills present and working through the CLI in both the Marketplace plugin and the full ZIP; `claude plugin validate` passes on all 13 targets; the hidden-prompt replacement works in zsh and bash. Stale BA prose remains (N9) and a stale BA README header (N10); LICENSE-AUDIT spot-check 10/10 true.
- New defects: N8 (blocker on Linux), N9, N10, T1, T2, N11 (minor).

## 1. Re-verification of N1-N6 and the open majors

| Item | Status | Evidence |
| --- | --- | --- |
| N1 `.env` route | FIXED | `h/n1.mjs`: for each of `.env`, `.env.praxis`, `.env.praxis.local` and each of `PRAXIS_TEST_REVIEW_NO_BROWSER`, `PRAXIS_REVIEW_NO_BROWSER`, `PRAXIS_REVIEW_OPEN`, `PRAXIS_TEST_ANY`: `openedInBrowser:true`, no `.url` file, no token in the tool result. `grep -rl "?t="` over the repo and the state home: nothing. `praxis_workflow_status`, `context_diagnose`, `session_start`, `doctor` outputs contain no token. The hook is now `PRAXIS_TEST_REVIEW_NO_BROWSER` (`review-service.ts:257,299`). |
| N8 (new) other `.env` variables | **NOT FIXED, new** | `h/n1b.mjs`: after one read-only tool call, `process.env` of the Runtime contains `BROWSER=<repo>/steal.sh`, `LD_PRELOAD`, `NODE_OPTIONS`, `GIT_ASKPASS` taken from the repository `.env`. `loadPraxisDotenv` (`cli/src/operations.ts:279-291`) only blocks the prefixes `PRAXIS_APPROVAL_`, `PRAXIS_ALLOW_`, `PRAXIS_FIXTURE_`, `PRAXIS_TEST_`, `PRAXIS_REVIEW_`, `PRAXIS_STATE_HOME`. `openInBrowser` runs `xdg-open <secret url>` on Linux, which executes `$BROWSER` with the URL as argument: an agent-written script then holds the token and the save token, and D01 returns. I could not run this on Linux (macOS `open` ignores `BROWSER`, `DYLD_*` is stripped for system binaries), so the exploit is demonstrated up to the environment injection plus the documented behaviour of `xdg-open`. Independent of the browser, `NODE_OPTIONS`, `LD_PRELOAD` and `GIT_*` from a repository file also reach every child process the Runtime starts (git, node). Fix direction: allow-list the keys a repository `.env` may set (only `PRAXIS_JIRA_*`, `PRAXIS_GITHUB_*`, `PRAXIS_GITLAB_*`), or drop `.env` loading for hosted runs. |
| D01 | PARTIAL | Tool result carries no token (r2/r3). Remaining: N8; the link is the argv of `open`/`xdg-open` (shim log: `http://127.0.0.1:<port>/r/<id>?t=<token>`), visible to `ps` and in browser history. Documented under "Known limits" for an agent with a shell. |
| N2 secrets in prototypes | PARTIAL | `r3.mjs`/`r12.mjs`: `Bearer <20+>`, JWT, `sk-...` refused in mock rows; a `Bearer` token, `sk-` string and `ghp_` string in the prototype title, screen title and element label are now refused too (was accepted). Still accepted (heuristic by design): base64 and hex-40 secrets, a space-split `sk-` key, plain passwords in mock rows. Feedback comments are not scanned. Acceptable as a heuristic; the docs should not call it protection. |
| N3 opener result | FIXED with residual | `r10.mjs`: an opener that exits 1 at once -> `openedInBrowser:false` and the offline-copy instruction. An opener that fails after 800 ms still reports true (timer, `review-service.ts:260-280`). Every render still launches another tab/session; Windows `explorer.exe` returns exit 1 even on success, so it will always take the offline path. |
| N4 dialog | FIXED | `r9.mjs`: a 300-character statement edit is shown in full (400-char excerpts), requirement-level `comment` and `scope note` are listed. |
| N5 skills | FIXED | `story-plan` and `stories-review` now say the user waives (a `waivers` entry through `praxis_review_apply`). Error text for an unsupported state-file version (N5b of report 2) is unchanged (`t39.mjs`). |
| N6 history size | FIXED | `r5.mjs`: 200 edits of 20 KB -> `artifactHistory` 49 entries, item file 1.0 MB (was 150 entries, 3 MB). Oldest revisions are still dropped. |
| D04 default mode | PARTIAL (accepted decision) | New: `workflow_status` for a classic item carries `modeNote` ("stages are recorded but the gates ... are not enforced. New work items should be opened with mode guided."); guided items do not. This informs the agent, not the user, and does not stop an agent that opens without `mode`. |
| D07 implementation path | PARTIAL | `r4.mjs` (guided): `.`, `src`, `../../etc`, `/etc/hosts`, symlink-out, nonexistent file refused; an existing file such as `package.json` is accepted whether or not it was touched or committed; classic items unchanged. The multi-repo E2E (below) commits real code but the Runtime only checks that the file exists. |
| D19 contract `agreed` | NOT FIXED | `r7.mjs`: an agent `set-contract` with `status: "agreed"` is accepted and the brief reports `agreed`. |

## 2. Are the new acceptance scripts real tests?

Method: read each script, run it in a copy, then mutate the Runtime or contracts in the copy and re-run.

**B01-B05 (`ux-browser-acceptance.mjs`, real Chrome via Playwright)**: run 5/5, 64 checks. They drive real controls (`fill`, `check`, `pressSequentially`) and then read the on-disk state, so they are not tautologies.
- Mutation 1: restore the old behaviour of the prototype search (rebuild the screen on input, no value restore) in the installed contracts -> `B03 FAIL: the search box keeps what is typed: expected "A-", got ""`. Caught.
- Mutation 2: remove the Origin check in `review-service.ts` -> B01-B05 all pass, `ux-overhaul-acceptance` 18/18 pass, `packages/mcp` unit tests 2 failures (one is the real Origin test, one is the sibling-path artefact). So the claim in B02 ("arbitrary requests do not write") does not cover a POST without Origin; only a unit test does. Weak coverage, not a tautology.
- The scripts run with `PRAXIS_SKIP_DOTENV=1`, so they cannot see N1/N8.

**M (`ux-multirepo-e2e.mjs`)**: run, 6 stages, 128 checks. The code, tests and commits in three git repositories are real; the contract check Quality runs is a script that imports the real files of all three repositories and executes them; the first run genuinely fails for mobile (`order_number` vs `number`) and the verdict FAIL and the refused delivery follow from that. The agents' choices, the user's saves and dialog answers are played (stated in the header). Limits: the Runtime itself never runs the check, it only stores the scenario results the script passes in; `record-implementation` only needs an existing file (D07).
- Mutation 3: make `markDownstreamStale` leave verdicts untouched -> `FAIL multi-repo: earlier verdicts no longer count`. Caught.
- Mutation 4: delete the old "current feature verdict not FAIL" delivery condition -> still PASS, because the newer per-service delivery conditions refuse the same case. That line is now redundant in this scenario, so the scenario does not prove it on its own.

**T (`tool-compat-acceptance.mjs`)**: run, 7 groups, alpha.48 52 tools vs now 59. It really starts the alpha.48 bundle (git ref `d55ed5b`) and the new one and diffs `tools/list`. Mutation 5: remove the `workItemId` property of `praxis_workflow_status` -> `FAIL tool-compat: praxis_workflow_status: property workItemId removed`. Caught. Limits: it proves registration and schema compatibility only, not behaviour; only 16 of the 39 non-protected tools answer a minimal call (23 are refused for a missing required argument, counted as "refused cleanly"); the list of expected added tools is hard-coded; one line (`problems.push(...replace(/.*/, ""))`) is dead code.

**Tautological or fragile tests**
- **T1** `planning-tools.test.ts` "N1: a repository .env cannot turn on the link-file test hook" does not test behaviour. It reads `../../../../praxis-core/packages/cli/src/operations.ts` and greps for the string `"PRAXIS_TEST_", "PRAXIS_REVIEW_"`, and greps `review-service.ts` for the hook name. In my copy (`/tmp/q3/core` instead of `praxis-core`) it fails with ENOENT (157/158); with a symlink named `praxis-core` it passes (158/158). It would also have passed with N8 present. My `n1.mjs` is the behavioural test it should be.
- **T2** No test sets an unrelated variable such as `BROWSER` through `.env` (N8).

## 3. REMARKS-MATRIX.md claim by claim

Files named in the matrix exist (`briefing.test.ts` 5 tests, `qa-fixes.test.ts` 8, `context-trust.test.ts` 10, `review-html.test.ts` 20, `planning.test.ts` 42; S01-S19, B01-B05, M, T). Row by row:

| Row | Matrix verdict | Mine | Note |
| --- | --- | --- | --- |
| 1 | PARTIAL | agree | heuristic scanner, host decides; N1 claim in the "implementation" cell is true for `PRAXIS_REVIEW_`/`PRAXIS_TEST_` but not for other variables (N8). |
| 2 | PASS (docs) | agree | |
| 3 | PASS | PARTIAL | `docs/workflow-stages.md` has no sentence about what to do when the context window ends or whether to continue in the same chat (grep: none); the briefing/new-chat part is true (S12, M step 6). |
| 4 | PASS for guided | agree | stated limit is accurate. |
| 5, 7, 8, 11, 12, 13, 15, 16, 17 | PASS | agree | B01-B05/S-scenarios do exercise them (checked B04 for ids and B05 for per-item marks). |
| 6 | PARTIAL | agree | `r8.mjs`: create-only text with view/search labels passes coverage. |
| 10 | PASS | agree | alpha.48 suites pass in my runs. |
| 14 | PARTIAL, tests "S04; M step 1" | agree on PARTIAL, claim wrong | M does not call `praxis_frontend_discover` (it hard-codes `styles` in `set-prototype`); only S04 and the unit test cover discovery. |
| 18, 20 | PASS (docs) | agree | |
| 19 | PASS, test S02 | PARTIAL | S02 checks the kind, the inspection and the impact gate; nothing tests that the recorded regression checks reach Developer/Quality; the gate applies to guided items only. |
| 21 | PASS, `briefing.test.ts`, S08, M | agree | M is the strongest evidence; caveat D07. |
| tool surface | 52+7=59 | agree | `TOOLS.length` is 59 in my build. |

## 4. Dustin items

**Seven canon skills** (`capture-cr`, `grill-cr`, `ba-plan-slice`, `shape-requirement`, `prepare-wp`, `approve-plan`, `accept`, the list in `full-zip-acceptance.mjs`):
- Present in the Marketplace plugin (`praxis-marketplace/plugins/praxis-ba/skills`) and in the full ZIP (committed `dist/claude-plugins-full/praxis-ba.zip`, unpacked; and a fresh ZIP from `pack-claude-plugins.mjs`, same skills, same CLI bytes). `full-zip-acceptance.mjs` passes (29 skills, 12 `${CLAUDE_PLUGIN_ROOT}` references resolve, CLI runs with no `node_modules`).
- Working: `canonflow.mjs` drives the real CLI from the **unpacked ZIP** (`tools/praxis-ba.cjs`) and from the **Marketplace plugin** (`bin/praxis-ba.cjs`) through the verbs these skills use, on a temp canon: `id next --scope cr`, `fmt`, `validate --check`, `id next --scope fr:E1`, `cr confirm --entry requirement --impacts-file`, `cr realize --spawn`, `req edit --activate`, `validate`, `id next --scope wp --date`, `wp prepare`, `wp approve-plan`. Both: 11/11 steps ok, FR ends `batched`, WP `plan-approved`, `wp/<id>/handoffs/ba-architect.handoff.json` emitted. `accept` refuses without `--evidence` (the human gate); I did not run a full acceptance.
- **N9 (minor)**: the full ZIP's skill prose still says `bin/praxis-ba.cjs` (`prepare-wp/SKILL.md:12`, `confirm-vision/SKILL.md:34-37` "node <plugin-dir>/bin/praxis-ba.cjs"), although the ZIP has `tools/praxis-ba.cjs` and no `bin/`. Only the `${CLAUDE_PLUGIN_ROOT}/...` references were rewritten and checked. Five skills also name `.claude/plugins/praxis-ba/templates/...` (valid for neither artifact; the templates are at `templates/`).

**`read -s -p` replacement** (website `content/docs/getting-started/cli.md`, `printf` + `stty -echo` + `IFS= read -r` + `stty echo`): run with a pseudo-terminal in `bash` and `zsh`: prompt shown, typed token not echoed, `len=15`, variable exported (`/tmp/q3/snippet.sh`). With piped input both shells read the value correctly but print `stty: stdin isn't a terminal` (harmless). The old form fails in zsh (`read:1: -p: no coprocess`, empty value) and works in bash, as the doc says. Residual: no `trap` to restore echo on Ctrl-C.

**`claude plugin validate`**: pass on all six Marketplace plugins (`praxis`, `-runtime`, `-ba`, `-architect`, `-developer`, `-quality`), the marketplace root manifest, the four light ZIPs (unpacked) in the role repos, the committed full BA ZIP, my freshly packed full ZIP, and the five BA staging directories alpha.44-48. (The validator states that it does not run the safety/policy review.)

**Stale BA instructions**
- **N10 (minor)** `praxis-ba/plugins/ba/README.md` line 5 (the generated header) is the old text: "invoke Jira Epic Analysis. Jira operations use shared Runtime MCP tools ..., not the Praxis CLI" and "upload `claude-plugins/praxis-ba.zip`" (the light ZIP) although the canon skills need the full ZIP; line 9 "What's new in 0.4.0" for a release numbered alpha.48; line 99 says "the 8 canon page skeletons" while `templates/` has 10 files plus `layer/` (10 more). The `--marketplace <source>` install form is valid (`claude plugin install --help`). The skill table is correct: `skill-list.mjs --check` passes and 29 skills, the 10 light-ZIP skills and the full/Marketplace columns match the unpacked archives.
- Website `content/docs/plugins/ba.md`: skill table matches; "Marketplace plugin ships the CLI as `bin/praxis-ba.cjs`; full ZIP as `tools/praxis-ba.cjs`; the light ZIP ships no CLI" is true of the artifacts; the approve-plan handoff path is true (file emitted in my run); the technical sequence matches the skill graph. Not verified: "The canon CLI has 26 usable paths" (older text, I did not count).

**LICENSE-AUDIT.md spot-check (10 of ~40 claims, all true)**: (1) no LICENSE/COPYING/NOTICE at the root of core, runtime, ba, architect, developer, quality, marketplace, docs; (2) the three role plugin LICENSE files are identical (md5 `33f9e5a5...`) and 13 lines; (3) Quality plugin `package.json` and `plugin.json` say `UNLICENSED`, no LICENSE file in the plugin directory; (4) Runtime `package.json` and plugin.json `UNLICENSED` while the MCPB manifest says `Apache-2.0` (`claude-extensions-shared.mjs:95`); (5) `canon-graph/package.json` has no license field; (6) `@praxis/contracts` has none, `@praxis/cli` has one; (7) zod 3.25.76 MIT, gray-matter 4.0.3 MIT, yaml 2.9.1 ISC, js-yaml 3.15.2 MIT, sql.js 1.14.2 MIT; (8) the MCP SDK 2.0.0 LICENSE text describes the MIT-to-Apache transition as quoted; (9) `praxis-mcp.cjs` contains no `@license`/`Copyright` comments, the BA bundle keeps two "Copyright (c) 2015 ... Jon Schlinkert" lines; (10) `marketplace-acceptance.mjs` lines 49-54 hard-code Apache for roles and UNLICENSED for jira/quality-service. Only drift: the audit says the Runtime license field is at `package.json` line 39, it is line 42 now (minor). No license is chosen in the file, as stated.

## 5. Anything new broken

- N8, N9, N10, T1, T2 above.
- **N11 (minor)** The `openedInBrowser` fix still reports success for an opener that fails after 800 ms; the 800 ms timer makes the result time-dependent.
- Regressions: none found. Runtime unit 158/158 (with the sibling directory), Core 179/179, `ux-overhaul-acceptance` 18/18 (317 checks), `workflow-external`, `story-quality`, `generic-quality`, `approval-ux`, `mcpb-runtime`, `quality-review` acceptance and typecheck pass; `ux-browser-acceptance` 5/5; `ux-multirepo-e2e` 6 stages / 128 checks; `tool-compat` pass; `full-zip-acceptance` and `skill-list --check` pass.

## 6. Status of earlier items touched this round

FIXED: N1, N4, N5, N6, N3 (residual N11). PARTIAL: D01 (N8 open), D04, D07, N2. NOT FIXED: D19, N8 (new). Report-2 items not re-run this round keep their report-2 status (D16 documented, D13/D15/D17/D20/D22 partial).

## 7. Open items by severity

- **Blocker (Linux; major elsewhere):** N8 (repository `.env` can set `BROWSER`, `LD_PRELOAD`, `NODE_OPTIONS`, `GIT_*`; with D01 it lets an agent obtain the review link).
- **Major-minor:** D04 (soft), D07 (existence-only), D19 (agent-set `agreed`), D16 (label-only coverage), T1 (source-grep test of a security property).
- **Minor:** N2 heuristic limits, N9, N10, N11, T2, no acceptance coverage of the Origin check, remarks-matrix rows 3/14/19, plus the report-2 residuals.
