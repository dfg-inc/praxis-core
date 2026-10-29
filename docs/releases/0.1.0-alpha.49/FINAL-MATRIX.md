# Final matrix: PRAXIS-questions v1 and Dustin's feedback (alpha.49 preparation, local)

Verdicts are the implementer's, backed by the named tests; the independent Quality verdicts are in QUALITY-REPORT-1..5. Test ids: unit = contracts/cli/mcp vitest files, S01-S20 = `praxis-runtime/tools/scripts/ux-overhaul-acceptance.mjs` (packaged Runtime, official MCP client, scripted dialog and Save), B01-B06 = `ux-browser-acceptance.mjs` (real Chrome, AUTOMATED), M = `ux-multirepo-e2e.mjs` (3 git repositories), T = `tool-compat-acceptance.mjs`, IN = `marketplace-install-acceptance.mjs`, FZ = `praxis-ba/tools/scripts/full-zip-acceptance.mjs`.

## A. PRAXIS-questions v1 (original-remarks.txt)

| # | Remark | Implementation | Tests | Verdict |
|---|---|---|---|---|
| 1 | Skills/instructions from analysed repos hijack the agent | precedence, skill plan, scanner (`context-trust.ts`); instruction files listed, never returned; `praxis_context_diagnose`; strict `.env` allowlist; project code out of process | unit `context-trust.test.ts`, `dotenv-*.test.ts`, `dotenv-runtime.test.ts`, `project-code-isolation.test.ts`; S19, S20 | PARTIAL: scanner is a heuristic; the host decides which skills load |
| 2 | Why JSON | docs "Why the state is JSON" | documentation | PASS (docs) |
| 3 | Context and log; new chat | `briefing.ts`, session notes, `resume-work`, `praxis_session_start` | unit `briefing.test.ts`; S12; M | PASS |
| 4 | User stories unusable | Story Plan first; guided is now the default | unit `planning.test.ts`, `modes-contracts.test.ts`; S01 (default), S05; B04 | PASS |
| 5 | HTML tool invented ad hoc | standard review pages + submission contract | unit `review-html.test.ts`; S03, S14; B01-B06 | PASS |
| 6 | No stories for viewing | coverage analysis gates `architecture` | unit `qa-fixes.test.ts`; S07 | PARTIAL: label-based (documented) |
| 7 | Cannot edit/remove stories or REQ scope | `update-story`, exclude/restore/split/merge, scope cascade | S05, S06; B01, B05 | PASS |
| 8 | HTML+mock prototype first | `Prototype`, viewer, API prototype | S04; B03 | PASS |
| 10 | (praise) | unchanged | alpha.48 suites | PASS |
| 11 | REQ in HTML | requirements page | S03; B01 | PASS |
| 12 | AC checkbox each | per-criterion controls | unit; B01 | PASS |
| 13 | Prototype refined in session | `update-prototype`, feedback, revisions | S04; B03 | PASS |
| 14 | Prototype reads app styles | `praxis_frontend_discover` | rt `planning-tools.test.ts`; S04; M | PARTIAL: CSS variables and Tailwind/MUI theme objects only |
| 15 | Plan maps stories to prototype and REQ | `StoryPlanEntry` | S05; B04 | PASS |
| 16 | Story generation | `add-story` inherits the plan line | unit; S05; M | PASS |
| 17 | HTML review of stories | stories page | B05 | PASS |
| 18 | What Praxis adds | docs section | documentation | PASS (docs) |
| 19 | Change requests | `change-request`, `record-impact`, kinds; regression checks reach Quality | unit; S02 | PASS |
| 20 | Local vs Jira | `docs/jira-vs-local.md` | documentation | PASS (docs) |
| 21 | Many repositories | registry, inspect, assign, services, contracts, brief, gates | unit `briefing.test.ts`; S08; M | PASS |

## B. Product decisions of this iteration

| Decision | Implementation | Tests | Verdict |
|---|---|---|---|
| New work items are guided by default | Core `openLocalWorkflow` default | unit `modes-contracts.test.ts`; S01; rt `planning-tools.test.ts` | PASS |
| alpha.48 items stay classic, no data loss | migration; no automatic mode change | S16 (genuine alpha.48 bundle), unit migration | PASS |
| Creating a work item in classic is the user's choice | open with classic needs the approval dialog or html-review channel (`USER_DECISION_REQUIRED` / `APPROVAL_CLIENT_UI_REQUIRED`); newItem, set-mode, replay do not bypass | unit `modes-contracts.test.ts`; rt `planning-tools.test.ts`; `approval-ux-acceptance.mjs`; final Quality review | PASS |
| Identical work item titles | `WORK_ITEM_TITLE_EXISTS` + `newItem`; replay recognised; stable Latin ids | rt `planning-tools.test.ts`; unit Cyrillic ids; final Quality review | PASS (low open: replay of a redacted request) |
| BA canon init for a new project | `praxis_canon_init_*`, `praxis-ba init`, skill `ba-init`; validates existing files, atomic, bounded product | rt `canon-init.test.ts` (golden parity with the CLI); ba `init.test.ts`; `ba-init-acceptance.mjs`; IN; `check-plugin-outputs` | PASS |
| `.env` migration docs and diagnostics | `docs/repository-env.md`, website reference; doctor `dotenvRefused` / `dotenvLoaded` | cli `diagnostics.test.ts`; website `pnpm check` | PASS |
| Safe explicit mode switch | `set-mode` + compatibility report; guided->classic is the user's | unit; S16; rt tests | PASS |
| Contract `agreed` is a user decision | `set-contract` agreed refused for agents; contracts page / approved dialog; gates on development, quality, delivery; agreed contract cannot be removed or silently changed by the agent | unit; rt; S08; M; B06 | PASS |
| Brand-style plugin icons, zero validator warnings | `tools/scripts/gen-plugin-icons.mjs` (from the existing brand mark); `claude plugin validate --profile directory` | each role repo `accept:plugin-validate`; marketplace `check:validate` | PASS |
| License untouched, version unchanged | audit only | n/a | PASS |
| `.env`: strict allowlist, no trusted settings from a repository | `dotenvKeyAllowed`, value shapes, scoping, regular files only | unit `dotenv-allowlist.test.ts`, `dotenv-trust.test.ts`, `host-placeholders.test.ts`; rt `dotenv-runtime.test.ts`; S20 | PASS (documented behaviour change: URLs and credentials no longer load from a repository file) |
| Agent cannot perform user confirmations through HTML Review / Story Plan | verified channel; `USER_DECISION_REQUIRED` for every decision command; link not given to the agent | rt consolidated test; S03, S14; B02 | PASS for the Praxis tool route; PARTIAL overall: an agent with a file-write tool can edit the unsigned state files, and project code runs as the user |

## C. Dustin feedback

| Item | Result | Evidence | Verdict |
|---|---|---|---|
| Seven BA canon skills present and working in the built Marketplace plugin | present; every path they use exists; CLI runs | IN | PASS |
| Full standalone BA ZIP for Desktop Chat (alpha.48 packaging defect) | CLI shipped under `tools/` (a top-level `bin/` is refused by Desktop upload rules); skills point there | FZ | PASS for the build; the BA release workflow now also uploads it (not run) |
| `read -s -p` not portable to zsh | replaced by `stty -echo` + `read` with Ctrl-C restore; says installing needs no Jira token | website cli.md (checked in bash and zsh by Quality) | PASS |
| `claude plugin validate` on all built plugins | zero errors and warnings | role `accept:plugin-validate`, marketplace `check:validate` | PASS |
| README Marketplace instruction warnings | install line generated into every packed README | same | PASS |
| Stale BA instructions | BA README rewritten from files and archives; generated skill table | `check:skill-list` | PASS |
| BA website page | generated skill table per artifact (local branch, not deployed) | website `pnpm check` | PASS (not deployed) |
| License audit | `LICENSE-AUDIT.md`, nothing chosen | n/a | PASS (decision is the owner's) |

Open owner decisions: see FINAL-REPORT.md.

## D. Defects found during manual acceptance (after the matrix above)

| # | Defect | Fix | Tests | Verdict |
|---|---|---|---|---|
| D1 | The user's Reject + comment on a criterion was invisible to the BA (`praxis_workflow_inspect` returned only id/statement/revision) | per-criterion `review` and `requirementReview` in inspect; comment vs decision times; `previous`; the agent cannot overwrite a user remark | Core `review-comments.test.ts`; rt `planning-tools.test.ts`; S21 | PASS (independent review round 1; final state not re-reviewed) |
| D2 | A single criterion could not be changed by id; an invented key was silently dropped; a no-op wrote history | `revise-acceptance {edits:[{id,statement,expectedRevision?}]}`; `acceptanceChanges` in the preview; `UNKNOWN_COMMAND_PARAMETER`; no-op returns the same state | Core `acceptance-edit.test.ts`; rt `acceptance-edit-tools.test.ts`; S22 | PASS (review round 1) |
| D3 | The agent's `confirmation=YES` was the only gate for rewording, accepted criteria included | `revise-acceptance` is a human act: the user's approval of the exact wording in the client dialog (existing mechanism, no new service); no dialog or Trusted Client -> `APPROVAL_CLIENT_UI_REQUIRED`; an agent cannot reword or remove an accepted criterion through `review-requirements` (`USER_DECISION_REQUIRED`); refusals that the user cannot fix by approving come before the dialog | Core `acceptance-edit.test.ts` (approval binding, wrong wording, replay after a state change); rt `acceptance-edit-tools.test.ts` (self-approval, no dialog, rejected dialog, trusted-client, stale preview, protected accepted); S11, S22; M | PASS (review round 2: no bypass or replay found) |
| D4 | A misspelt tool argument (`workitemId`) was dropped and the action ran on the current Work Item | tool arguments are checked in `callTool`: an undeclared argument gives `INVALID_INPUT` with the accepted list and a "did you mean"; `provider` declared for the git tools that read it | rt `acceptance-edit-tools.test.ts` (4 tools x 3 typos, nothing runs); S22; approval-ux, git-delivery-e2e | PASS (review round 2) |
| D5 | A stale review page could overwrite a fresher comment, decision or wording | the page sends what it showed (`from`, `fromComment`, revision); a stale criterion, story mark or requirement remark is a conflict ("this page is out of date ... Reload"); other changes in the same Save still apply | Core `review-comments.test.ts`, `review-html.test.ts`; rt two-tabs test; S22; B05 (real Chrome) | PARTIAL: story-plan entries and handed-over decision files without `from` are not protected (see FINAL-REPORT) |

Result of this round: Core, Runtime (21/21 scenarios, 408 checks; 6/6 Chrome scenarios, 72 checks), BA, Marketplace verify and install acceptance green; `accept:workflow|stories|generic|claude-code-approval` green. Independent Quality round 2 found: stale-save gaps (fixed: story marks and remarks, requirement remarks), a whitespace edge of `.trim()` (fixed), and residual items below. The fixes after round 2 were verified by tests and the full verify, not by a third independent review.

### D6-D8. Round 4 (integrity of the user's decisions)

| # | Defect | Fix | Tests | Verdict |
|---|---|---|---|---|
| D6 | host-permission ("always allow") could stand in for the person's approval | human-only acts (`confirm-story`, `confirm-decision`, `approve-service`, `review-decisions`, `revise-acceptance`, `open-classic-work-item`) and the Quality fix commit always need the client's dialog in host-permission and Trusted Client mode (`APPROVAL_CLIENT_UI_REQUIRED`); `praxis_approval_plan` returns no plan text for them; Trusted Client asks a real dialog when there is one | rt `human-only-integrity.test.ts` (6 tests); S22; approval-ux, claude-code-approval | PASS (review round 3 found no way around it; the Trusted-Client-with-dialog fix was re-verified) |
| D7 | Stale pages: unprotected fields (requirement scope/scope note/remark, plan lines, story remarks, accept-all/agree/accept controls); base values could be omitted; a handed-over file or a moved work item during the dialog | `baseStamp` (hash of all that the page showed, marks and remarks included) plus per-field base values (`from*`, plan line `base`, revision); with an out-of-date stamp every changed field must carry its base value; accept-all, plan agree, prototype/story accept need a current page; submissions are strict; decisions are recomputed after the dialog (`REVIEW_CHANGED`) | Core `review-stale.test.ts`, `review-comments.test.ts`, `review-html.test.ts`; rt `human-only-integrity.test.ts` (two tabs x 3 reviews, file import, dialog race); B01-B07 in real Chrome | PARTIAL: `modeChange` and `waivers` in a handed-over file carry no base (they need the dialog and are recomputed after it); non-decision edits in a handed-over file are applied after approval but are outside the approved subject |
| D8 | Parameter strictness at depth; `verify-stories` / `prepare-fix` read raw; approval-plan arguments | `parseStrict` walks arrays, optionals, defaults, records, tuples, intersections, unions, brands, pipes; authority-shaped keys on a command are dropped (never read), submissions tolerate none; `verify-stories` / `prepare-fix` and the approval-plan target arguments are checked | Core `command-strict.test.ts` (13); rt `human-only-integrity.test.ts` | PASS (review round 3 found the two gaps, fixed; re-verified) |

Result of round 4: Core 260 tests, Runtime MCP 221 tests, packaged-Runtime scenarios 21/21 (410 checks), real Chrome 7/7 (76 checks), BA verify, Marketplace verify and install acceptance, `accept:workflow|stories|generic|claude-code-approval` all PASS. NOT PROVEN: the Claude Desktop / Claude Code UI, and that a person answers the dialogs (scripted here).

### D9-D12. Round 5 (what is shown is what is applied; paths)

| # | Defect | Fix | Tests | Verdict |
|---|---|---|---|---|
| D9 | `praxis_review_apply`: story edits (text, exclude, restore) were applied outside the shown plan; plan edits showed key names only and the agreement an old revision; details were cut at 400 chars; the dialog was silently cut at 12000 chars while Approve bound everything; cascades to stories were silent | when a file holds anything that needs the person (decisions, story/contract/mode/waiver changes, or a change that reaches a story) the dialog shows the whole plan in full (old -> new text, the plan as it will be agreed, the story cascade) and the approval binds every command (normalized form); a message the dialog cannot carry whole is refused (`APPROVAL_TOO_LARGE`), never cut; details are recomputed after the dialog and any difference ends `REVIEW_CHANGED` | Core `review-stale.test.ts`; rt `human-only-integrity.test.ts` (story edit/exclude, cascade, too large, dialog race); S22 (too large in the packaged Runtime) | PASS (re-verified independently, 3 rounds) |
| D10 | `modeChange` / `waivers` had no protection against stale state | the file must carry `baseState` (from `praxis_review_render` or the page); applied only if the whole item is still as it was (mode, stage, requirements with marks and remarks, plan, stories, prototype, contracts, waivers, acceptances, services, decisions, verdicts); replaying a waiver adds nothing; a reused page reports the stamps of the state it was created for | Core `review-stale.test.ts`; rt `human-only-integrity.test.ts` | PASS (re-verified independently, 3 rounds) |
| D11 | agent-supplied paths followed symlinks (`implementationPath`, Quality proposals, check modules, diff targets) | `containedPath` judges the real path (links in the root, any directory or the file, dangling links, absolute, `..`, NUL, non-regular and oversized files); the same logic is in the isolated check runner; a proposal diff may touch only the file it was approved for; the proposal file is read through the same check | rt `path-guard.test.ts` (6), `human-only-integrity.test.ts` (diff paths) | PASS (explicit `path` of `praxis_frontend_discover` is kept on purpose: the app is often another checkout; it reads style files only) |
| D12 | union strictness edge | no ambiguous object union is reachable from any command schema; the audit test now looks through wrappers and lazies and lists the free-form fields (prototype API example bodies); no code change was needed | Core `command-strict.test.ts` | PASS (not exploitable today; guarded for the future) |

Result of round 5: Core 271 tests, Runtime MCP 235 tests, packaged-Runtime scenarios 21/21 (411 checks), real Chrome 7/7 (76 checks), BA / Marketplace verify, install acceptance and `accept:workflow|stories|generic|claude-code-approval` PASS. The first independent review of the changed components found 8 defects (dialog cut at 12000 characters, plan edit text not shown, truncated details, silent story cascade, incomplete stamp, stamps of a reused page, diff paths, minor path gaps); all but the deliberate discovery path were fixed in this round.

Independent review of the changed components, round 5, in four passes on the same reviewer: pass 1 found 8 defects (all fixed except the deliberate discovery path); pass 2 found the diff-path bypass via the `-p1` prefix, a wrong "agreed after the edits" listing, a duplicate-entry merge, a space and `--- note` regression, plan-line-only cascades; pass 3 found the subdirectory-root prefix bypass, the matching regression and a symlink alias; pass 4 (final state) found no defect in the diff check across subdirectory, nested, symlinked, submodule, worktree and non-git roots. Final suites: Core 273, Runtime MCP 235, packaged scenarios 21/21 (411 checks), real Chrome 7/7, BA / Marketplace verify, install acceptance and four accept scripts PASS. Not exercised by the reviewer: `apply.whitespace`, `.gitattributes`, a well-formed binary patch.

### D13. Round 6 (interactive prototype, review polish)

| # | Defect / requirement | Fix | Tests | Verdict |
|---|---|---|---|---|
| D13 | Prototype Viewer: no real filter, drawer/modal, tabs, row clicks, URL query, mock data switching; technical report look | interactive model + engine, Preview/Inspect/Review page, Scenarios, collapsed Coverage, honest limitations, tokens from the app styles | Core `prototype-viewer.test.ts` (33), Chrome B08 (49 checks) | PASS (Chrome only; Claude UI not proven) |
| D14 | Requirements / Story reviews visual quality | hierarchy, progress, groups, segmented controls, auto-size, previous markers, dark and phone | B01, B04, B05, B07, S21, S22 unchanged and passing; screenshots at 1100 and 390 px | PASS |
| D15 | Compatibility of saved PROTO-1 and acceptances | new fields optional; empty defaults ignored by the fingerprint; no silent migration | legacy fingerprint test (fails without the rule), lab copy run | PASS |
| D16 | Independent review findings (7) | selector escaping, tab focus, history dedupe, token safety, legacy fallback, reserved param names, dangling-reference validation | 7 new regression tests | FIXED, not re-reviewed |

Result of round 6: Core 306 tests, Runtime MCP 235, packaged scenarios 21/21 (411 checks), real Chrome 8/8 (126 checks), BA / Marketplace verify, install acceptance and `accept:workflow|stories|generic|claude-code-approval` PASS.

### D17-D30. Round 7 (manual E2E blockers)

| # | Defect | Fix | Tests | Verdict |
|---|---|---|---|---|
| D17 | PASS with part of the criteria proven (S17) | per-criterion model, counts per requirement and Story | `quality-coverage.test.ts`, Q01 | FIXED |
| D18 | verify-stories vs feature-verdict disagree (S18) | one computation | `quality-coverage.test.ts`, Q03 | FIXED |
| D19 | record-verification replaced coverage; agent text counted as proof (S19) | merge, ids, stale writes, engine-stamped provenance | `quality-coverage.test.ts`, `quality-evidence-model.test.ts`, Q02 | FIXED |
| D20 | no browser evidence (S16) | declarative checks, operator Playwright, isolated driver, digests | Q01-Q07, `browser-driver-hardening.test.ts` | FIXED (Chrome; operator provides Playwright) |
| D21 | architecture gate without confirm; stale upstream does not hold (S8, S12) | gates, restore clears excluded-only fields | `gates-consistency.test.ts` | FIXED |
| D22 | no durable audit of human decisions; wrong channel text (S11, S20) | `approvals[]`, trust levels, truthful notes | `approval-audit.test.ts` | FIXED |
| D23 | fingerprint only from an error (S13) | returned by record-decision, validated at preview | `approval-audit.test.ts` | FIXED |
| D24 | false capability gaps, no waiver in the page, agree before waivers (S1-S4) | statement operations + built elements, advisory wording, waive control, order | `capabilities-waivers.test.ts` | FIXED |
| D25 | service ignores registry path (S15) | `effectiveServices` | `quality-evidence-model.test.ts` | FIXED |
| D26 | preview too large, no command file, one-time link (S9, W2, P4) | compact, `commandFile`, explaining page | `workflow-ergonomics.test.ts` | FIXED |
| D27 | prototype address, empty states, inspector, labels (B1-B3, P2, P5, RD5) | viewer | `prototype-viewer.test.ts` | FIXED |
| D28 | review pass 1 (12 findings) | see FINAL-REPORT round 7 | `quality-review-fixes.test.ts`, Q06 | FIXED |
| D29 | S14, S5, S6, RD2, P3 | - | - | DEFERRED (stated) |
| D30 | HTML Save "not verified", D1 (app) | - | B01-B08 | NOT REPRODUCED / not a Praxis defect |

Result of round 7: Core contracts 354 tests, Runtime MCP 246 tests, packaged scenarios 21/21 (413 checks), real Chrome 8/8 (126 checks), Quality browser on the React app 7/7 (53 checks), multi-repo E2E 6 stages (141 checks), BA / Architect / Developer / Quality verify, Marketplace verify and install acceptance PASS. Lab update on a copy of the real lab: Work Item, PROTO-1, plan, four Stories, approvals, implementation, Quality state and history unchanged.

## Round 8 (independent check of the real E2E, release readiness)

| # | Finding | Fix | Evidence | Status |
|---|---|---|---|---|
| D31 | evidence did not follow the bundle: `subjectDigest` recorded, never compared | browser results stale in memory when the bundle differs or is gone; stripped before write; not in the preview token | Runtime `browser-evidence-drift.test.ts`; lab copy 31/31 then 12/31 after a 13-byte edit | FIXED |
| D32 | `runId` masked as a secret; differed from the artifacts directory | not masked; equals the directory name | `quality-review-fixes.test.ts` | FIXED |
| D33 | service verdict counted a drifted PASS | excluded | Core tests | FIXED |
| D34 | WebRTC and `preconnect` egress to the LAN | resolver rules and WebRTC policy | `browser-driver-hardening.test.ts` (UDP and TCP listeners) | FIXED |
| D35 | `serve.root: "."` exposed `.env`, `.git`, `.praxis` | root equal to the service directory refused; served from a private copy without dot-names or links | hardening tests | FIXED |
| D36 | killed parent left driver, 7 Chromium processes and temp dir | driver watchdog and parent-loss exit, removes its directory | hardening test (SIGKILLed parent) | FIXED |
| D37 | served bytes differed from the digested bytes; artifact symlink; viewport range; criterion numbering | snapshot digest, `wx` writes, 200-3000, 1-6 digits | hardening tests, `quality-review-fixes.test.ts` | FIXED |
| D38 | drift mark in the preview token; digest cache; bundle copy left by self-stop; run id in the idempotency comparison | removed or fixed | review pass 3 | FIXED |
| D39 | reproducible Playwright/Chromium setup | `setup-quality-browser.mjs` | run twice, headless launch OK | FIXED |
| D40 | lab checks: 13 strong, 15 weak, 3 formal; 13 of 34 mutations survived | not changed (the source Work Item stays as it is); human review recommended | review table in FINAL-REPORT round 8 | NOTED |
| D41 | real person approval on alpha.49, Desktop Code dialog, live Jira, Linux/Windows | scenario H prepared | - | NOT VERIFIED |
| D42 | console errors do not fail a check; `localhost` origin; dot-files not served; legacy layout not drift-marked | - | - | DEFERRED |

## Round 9 (scenario H, final state)

| # | Finding | Fix | Evidence | Status |
|---|---|---|---|---|
| D43 | scenario H: H1, H2 | - | `approval-check.mjs`, APR-0001 | PASS |
| D44 | H3: APR-0002 `confirm-story` US-ORD-001 via client dialog where none was expected | - | `approval-check.mjs` | INCONCLUSIVE (neither human action nor defect proven) |
| D45 | H4 HTML Save in Chrome, reopen; H5 stale per Review item | MANUAL-ACCEPTANCE step 5 corrected | user run on the isolated copy | PASS (copy) |
| D46 | H6 | - | source hash unchanged, legacy decisions unverified | PASS with reservations |
| D47 | Desktop Code/GUI dialog, Desktop Chat on alpha.49, live Jira, Linux, Windows | - | - | NOT VERIFIED |
| D48 | release checklist | `RELEASE-CHECKLIST-alpha.49.md` | - | PREPARED, nothing run |

## Round 10 (release candidate)

| # | Item | Result | Evidence | Status |
|---|---|---|---|---|
| D49 | local bump alpha.48 to alpha.49, 7 repos, vendor refresh | done on `feature/ux-overhaul`, not published | `set-ecosystem-version.mjs`, verify | DONE |
| D50 | licence decision | Apache-2.0, holder `dfuture-co` 2026 | LICENSE/NOTICE in 7 repos and archives | DONE |
| D51 | third-party notices | 18 (Runtime/MCPB) and 9 (roles) packages, texts unchanged | `gen-third-party-notices.mjs` | DONE; wasm internals NOT VERIFIED |
| D52 | holder legal name, handbook dataset, unattributed prompts, `<corporate-domain>` commits | cannot be settled from files | - | OPEN (owner) |
| D53 | install + in-place upgrade alpha.48 to alpha.49, single role, Approval/Trusted Client | PASS, clean profile | `marketplace-install-acceptance.mjs` 11 checks | PASS |
| D54 | rollback to alpha.48 | uninstall + install from the previous marketplace revision | throwaway profile | PASS |
| D55 | Quality runner security model | documented, unconfirmed scenarios labelled | `QUALITY-RUNNER-SECURITY-MODEL.md` | DONE |
| D56 | Quality backlog (3 FORMAL, 15 WEAK, 13 survivors) | recorded | `QUALITY-BACKLOG.md` | DONE |
| D57 | H3 controlled retest | prepared, needs the owner's Reject click | `h3-check.mjs` | PENDING |

## Round 14 (notices, H3 control, closing out)

| # | Item | Result | Evidence | Status |
|---|---|---|---|---|
| D58 | Emscripten (MIT/UIUC) and musl (MIT) notices for `sql-wasm.wasm` | added to the Runtime THIRD-PARTY-NOTICES (repo, plugin, stage, MCPB); texts from the Emscripten 5.0.0 tag | `check-public-content` requires them wherever a `.wasm` ships | DONE |
| D59 | licences in the final archives | LICENSE and NOTICE identical, `license` Apache-2.0, `author` dfuture-co in the MCPB and four ZIPs; THIRD-PARTY-NOTICES in the MCPB (Emscripten, musl) and BA ZIP (MIT notice) | archive extraction | PASS |
| D60 | H3 negative control, automated | decline, cancel, decision=reject, no-dialog client, confirmation=NO: nothing executed, Story `proposed`, `approvals[]` empty, file byte-identical | `manual-lab/h3-automated.mjs` | PASS (automated) |
| D61 | H3 with a person's Reject in the real Claude Code dialog | not done | - | NOT VERIFIED |
| D62 | `extension-functions.c` inside the upstream wasm; upstream toolchain | no licence text; not provable | PROVENANCE-AUDIT round 13 B | RESIDUAL (inherited) |
| D63 | public dataset in history, old Releases, vendor archives | untouched by decision | OWNER-DECISIONS | ACCEPTED RISK |
