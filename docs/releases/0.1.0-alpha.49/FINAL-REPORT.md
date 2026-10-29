# Praxis alpha.49 preparation: final report (local; nothing released)

Branches `feature/ux-overhaul` (core, runtime, ba, architect, developer, quality, marketplace) and `docs/ux-overhaul` (praxis-website). No version bump, tag, release, publication, merge or deployment. License untouched.

## Implemented (decisions 1-7)
1. New work items are **guided** by default. Opening one in **classic** is the user's choice: the Runtime asks in the approval dialog (or the verified html-review channel); the agent cannot do it through `mode=classic`, generic apply, `set-mode`, replay or `newItem` (Quality tried; Trusted Client / host-permission modes stand in for the dialog by design).
2. alpha.48 items stay **classic** (migration, genuine alpha.48 bundle used in S16), no automatic mode change, no data loss.
3. **`set-mode`** with a compatibility report (what is kept, stories without a plan line, stages without the user's acceptance); to guided is the agent's, back to classic is the user's (page or approved dialog).
4. **Contract `agreed` is the user's decision** through the existing approval mechanism: contracts review page (real Chrome tested) or approved dialog; the agent can propose, never agree; an ever-agreed contract cannot be removed by the agent; development, quality and delivery wait for agreed contracts; changing an agreed contract makes it proposed again.
5. **Icons** (512 px PNG) for all six plugins; `claude plugin validate --profile directory` has zero errors and warnings, enforced by each role repository's verify and the marketplace verify.
6. License audit left for the owner. 7. Version string unchanged (0.1.0-alpha.48).
8. **Identical titles:** a second `open` with the same title (compared ignoring case and surrounding spaces) and a different request is refused with `WORK_ITEM_TITLE_EXISTS` and two choices (continue the existing item, or `newItem: true` for a separate one); an identical request is a replay. Ids are stable `WI-<TITLE>-<NNN>`; Cyrillic titles are transliterated, titles without Latin letters become `WORK-NNN`.
9. **BA canon init for a new project, without a Praxis checkout:** Runtime tools `praxis_canon_init_preview` / `praxis_canon_init_apply` (user dialog; Claude Desktop Chat too) and `praxis-ba init` (CLI), skill `ba-init`. Creates `.ba/config.yaml`, `.ba/counters.yaml`, a draft `vision.md` and the canon folders; never overwrites; refuses symlinks and wrong-kind paths; **validates an existing `config.yaml` / `counters.yaml` (refuses an invalid one, never repairs or rewrites a valid one)**; product name limited to 120 characters; **writes are atomic (temporary file + rename) and a failure removes what the run created**.
10. **`.env` diagnostics and docs:** `praxis_doctor` reports `dotenvRefused` (key names and reasons, never values) and `dotenvLoaded`, with next steps; `docs/repository-env.md` (and the website reference page) says where Jira / GitHub / GitLab settings now go and how to migrate old repository config.
11. **Icons:** unified Praxis style generated from the existing brand mark; no new dependency, zero validator warnings.

## `.env` and security
Repository `.env`, `.env.praxis` and `.env.praxis.local` (root only) are read through a strict allowlist with value shapes: project key and Jira naming settings, Git provider, work-package hours. Approval modes, test switches, state location, every URL, e-mail and credential, Quality service settings and any non-Praxis variable are never loaded. Values are scoped to the call's repository, only small regular files are read, parsing is tolerant (BOM, CRLF, export, quotes, comments). Negative tests: unit (files, nested files, tricks, symlinks, priorities, shapes, scoping, FIFO), Runtime tool entry point, and the packaged bundle with dotenv enabled (S20). Behaviour change from alpha.48: URLs and credentials in a repository `.env` no longer load (documented in `docs/repository-env.md`).
Project-supplied Quality code (adapter, check modules, test runs) no longer runs inside the Runtime process; it runs in a separate Node process with a scrubbed environment. This is **not** a security boundary (documented): such code runs with the user's privileges.
The review link is never given to the agent; it goes to the browser through a short-lived 0600 file; one tab per review.

## Verification (all local)
- `npm run verify` passes in core, runtime, ba, architect, developer, quality, in the working trees and in **fresh clones with `npm ci`** (Architect and Developer need the `PRAXIS_*_ROOT` variables at the repo roots).
- Runtime verify includes: 19 acceptance scenarios (344 checks, incl. alpha.48 migration, approvals reject/confirm/stale/no-dialog, default mode, `.env`), **6 real-Chrome scenarios** (automated, 72 checks), **multi-repository E2E** (3 git repositories, real code/tests/commits, executed contract check, 135 checks), tool compatibility (52 alpha.48 tools unchanged, 61 now).
- Marketplace: verify, `claude plugin validate` on all six plugins, clean-clone install (10 checks, Claude Code CLI). Website docs branch: `pnpm check` passes.
- Tests changed for guided-by-default: alpha.48-style test helpers and scripts now open items with an explicit `mode: "classic"` (they model alpha.48 items; expectations untouched, audited by Quality); the guided default has its own tests. Two alpha.48 tests about `.env` credentials were changed deliberately (security decision, documented).

- **Final fresh-clone run** (`git clone` of each branch, `npm ci && npm run verify`, all six repositories, after the last commits): all pass. It caught one real defect, fixed: a Runtime test that runs the BA CLI next to the Runtime checkout needed the BA build (`dist/`), not only the checkout; it now skips unless the build exists.
- **Manual lab verified in an isolated folder** (`PRAXIS_LAB=/tmp/lab-final`): `setup-lab.sh` twice, `start-alpha49.sh` for all four projects (right folder, lab `CLAUDE_CONFIG_DIR`), the lab Runtime connects and lists 61 tools; checksums of `~/.claude` settings and plugin registries, `~/.claude.json` and the output of `claude plugin list` of the normal profile unchanged (alpha.48 untouched).

## Fix found in manual acceptance: Requirements Review remarks were invisible to the BA
`praxis_workflow_inspect` (`requirements` and `all`) now returns for every criterion its `review`: status, comment, who/when decided (`decidedAt`/`decidedVia`), comment time/source (`commentAt`/`commentVia`) and `previous` (the earlier decision and reason once the text was revised); the `requirements` and `all` views also carry `requirementReview` (rejected, commented, pending, progress, acceptance, fingerprint; in-scope criteria only). Additive and backward compatible: alpha.48 items read unchanged. Also fixed: `at`/`via` mean the status decision only (a comment edit no longer looks like a new decision); the history says what changed (no more "marks only"); an empty comment clears; the agent cannot replace or clear a remark the user wrote; editing a rejected criterion keeps the reason as `previous` and the page shows it; "accept all" keeps comments; a token-shaped comment is redacted in inspect; a later rejection keeps the gate to the next stage shut although the content fingerprint (deliberately content-only, tested) is unchanged. Tests: Core `review-comments.test.ts`, Runtime integration (Save via the page, then inspect, alpha.48-shape state), acceptance S21 (reject, comment, Save, inspect, targeted edit through the dialog, updated page). Independent Quality review of the fix: no blocker; its findings (agent overwriting a user remark, dialog line for cleared comments, out-of-scope lists, redaction, `all` summary, `previous` display, accept-all) were fixed. Open and low: a remark stored by alpha.48 has no `commentAt` (its `decidedAt` is then the last touch); a stale review page can still overwrite a comment changed elsewhere (the dialog now shows the current comment).

## Independent Quality (QUALITY-REPORT-1..4, plus the final review of the last state)
Four review rounds, then a final independent review of the latest state (classic-open bypass attempts, duplicate titles, `.env`/diagnostics, canon init from packaged artifacts, icons/validator, regression sweep, manual lab). Result: **PASS, no blockers; no way found to open classic without the user.** Its minor findings were fixed (case/space title matching, read-only BA verbs on a pre-init canon, doc nits, init validation/atomicity/length); still open and low: replaying an identical `open` whose request was rewritten by redaction (very long or token-like text) is refused as "different request" (fail-safe); `praxis_doctor` shows `PRAXIS_*` key names from `.env` verbatim (values never).

## Documented limits / open minor items
Project code is not a security boundary; state files are unsigned JSON (an agent with a file-write tool or same-user code can edit them; the guarantees cover the Praxis tool route); coverage is label-based; the instruction scanner is a heuristic; guided is the default but an agent can still open classic (visible note, user decisions still enforced); `praxis_frontend_discover` and `praxis_repository_inspect` can read file and directory names of any readable directory; the review-open temp file can fail on unusual default handlers (N3); Jira field-name values accept any plain name (N5); migration to contract 1.1.0 is one-way (the `.bak` of the item is kept); the BA release workflow change (full ZIP asset) was not run.

## Decisions for the owner
1. License and beta terms (`LICENSE-AUDIT.md`: contradictions, third-party notices, options, open questions).
2. Version bump to alpha.49 and the release itself. 3. Whether the two low open items above go into alpha.49. (Decided by you and implemented: guided default with classic as the user's choice, the `.env` policy, duplicate-title choice, BA init, brand icons.)

## What needs your manual testing in Claude (not proven by any script)
1. **Review pages in your real client.** In Claude Code (terminal) start a new work item, answer until requirements exist, ask for the requirements review. A page should open in your browser; tick/untick criteria, edit one requirement and one criterion, Save. Ask "what is the status?": decisions must be there. Close the Claude session, reopen the page file under `.praxis/workflow/reviews/<item>/requirements.html`, press Copy decisions, paste to a new session: Claude Code must show an approval dialog listing exactly those decisions. In **Claude Desktop Code** dialogs are answered automatically (not a human approval): use the page Save there.
2. **Does the model follow the skills?** Fresh chat, a real request: does it stop at each stage, give you pages instead of JSON, refuse to accept things for you, write the plan before stories, ask you to agree contracts?
3. **Prototype on your real frontend:** run `praxis_frontend_discover` on your app: colors, font, radius and screens right? (CSS variables and Tailwind/MUI theme objects only.)
4. **Continue in a new chat:** say "continue this task": right item, right next step, asks when several, says the old chat is not restored.
5. **Several repositories:** web + mobile + API in one work item: brief, order, contract agreement page, Developer edits in the right repository.
6. **Old work item:** open a work item created by alpha.48 in the new build: it stays classic and works; try `set-mode` guided and read the report; moving back to classic must ask you.
7. **Marketplace via the Claude UI** (Customize -> Plugins -> add the local branch), including the plugin icons; **BA full ZIP in Desktop Chat** (upload `praxis-ba` full ZIP built by `npm run pack:full-zip`).
8. **zsh token prompt** from the website CLI page in your own macOS terminal.
9. Other browsers and phone width for the review pages (only Chrome was automated).

## Fix found in manual acceptance: single acceptance criteria could not be changed by id

Cause: `review-requirements` could carry `acceptance[].statement` but nothing documented it; `revise-requirement` takes only a requirement id; an invented key (`editAcceptance`) was silently dropped by schema parsing and the command ran as a "no change" that still wrote a history line.

Fix (Core, Runtime, BA skills; no version change):
- New command `revise-acceptance {edits:[{id, statement, expectedRevision?}]}`: only the named criteria get revision +1, return to pending and keep the earlier decision and remark as `previous`; other criteria (accepted included) are unchanged. Preview returns `acceptanceChanges` (before/after per criterion). `praxis_workflow_commands` and the preview tool description point to it; BA `local-workflow` and `requirements-review` skills describe the flow.
- Unknown command parameters are refused with `UNKNOWN_COMMAND_PARAMETER` (names the key, the accepted keys, and a pointer to `revise-acceptance`). Authority-shaped keys (`via`, `approval`, `userApproval`, ...) and server-owned contract fields echoed back are still dropped, never trusted.
- No-op commands (same text, same marks/remarks, same scope, `revise-requirement` with the same statement) return the same state: no revision, no history line, `noChange` in the preview.
- Stale preview: the fingerprint binds the whole stored state, so any later change (user mark, other edit) gives `FINGERPRINT_MISMATCH`; `expectedRevision` gives `ACCEPTANCE_REVISION_CONFLICT`.
- Found and fixed on the way: the HTML story review sent an extra `from` key, `verify-stories` sent `meta` and `prepare-fix` sent `proposal` inside commands (all were silently dropped before).
- Tests: Core `acceptance-edit.test.ts` (16), Runtime `acceptance-edit-tools.test.ts` (5, MCP), packaged-Runtime scenario S22 (31 criteria; the two requested edits; 29 untouched; page updated). Core, Runtime (21/21 scenarios, 399 checks), BA verify, Marketplace verify and install acceptance are green; story/generic quality acceptance scripts green.
- Independent Quality review found the `prepare-fix` regression, a `set-requirement-scope` no-op hole and blank-statement handling; all fixed. The final state was not reviewed a second time.

Open, by design: the user's confirmation of an agent-authored edit is the existing preview + `confirmation=YES` step; the Runtime does not open a dialog for `revise-acceptance` (an agent could reword an accepted criterion after its own preview; the criterion then returns to pending, the acceptance goes stale and the user re-accepts). MCP tool-level arguments (not command JSON) are still stripped by the tool schema layer, e.g. a misspelt `workitemId`.

## Round 3 after manual acceptance: real approval, strict tool arguments, stale review pages

- `revise-acceptance` is now a human act through the existing approval mechanism (client dialog showing every criterion before/after, the old remark and a WARNING for accepted ones). The agent's `confirmation=YES`, approval-shaped fields in the command, and undeclared arguments change nothing. No dialog (or Trusted Client) -> `APPROVAL_CLIENT_UI_REQUIRED`; Reject -> nothing written. An accepted criterion cannot be reworded or removed by an agent through `review-requirements`. No new service.
- Tool arguments are checked: an undeclared argument (`workitemId`) is `INVALID_INPUT` naming the accepted ones, before anything runs.
- Stale pages: a Save based on an out-of-date page no longer overwrites a changed remark, decision or wording (criteria, story marks, requirement remarks); the page shows "this page is out of date ... Reload the page".
- Tests: Core contracts 238, Runtime MCP 209 (10 in `acceptance-edit-tools.test.ts`), S11/S22 on the packaged Runtime, real-Chrome B01-B06. Full Core/Runtime/BA/Marketplace verify and install acceptance green.
- A first version of the story-review change put `fromComment` into the command; the strict check and the real-Chrome B05 caught it before it was committed as final; fixed with a unit test.

Not done / residual (stated plainly):
- Story-plan entries and requirement-level fields other than comment/scopeNote still have no stale-page check; a handed-over decisions file (`praxis_review_apply`) without `from`/`fromComment` skips the status/remark check (wording is still protected by revision).
- `PRAXIS_APPROVAL_MODE=host-permission` (opt-in) still lets the host's "always allow" stand for the dialog, as for `confirm-story`; Trusted Client mode is refused for this act.
- Command-parameter strictness does not walk `z.record`/intersection/non-discriminated-union nodes; `praxis_approval_plan` reads `workItemId` inside its target arguments without a key check.
- The last fixes (after the second independent review) were not reviewed independently a third time.

## Round 4: integrity of the user's decisions

- host-permission and Trusted Client never approve human-only acts (rewording a criterion, confirming a Story or decision, approving a service, recording review decisions, opening a classic item) or the Quality fix commit: no verifiable dialog -> `APPROVAL_CLIENT_UI_REQUIRED`, nothing changes. With a real dialog Trusted Client asks the person for those acts. No new service.
- Review pages (Requirements, Story Plan, Story Review) carry `baseStamp` and per-field base values; an out-of-date page cannot overwrite a newer mark, remark, scope, wording or plan line, and cannot accept-all/agree/accept; omitting base values (hand-made file, old page) is itself a conflict; the page says "this page is out of date ... Reload the page". A dialog that stays open while the work item moves ends with `REVIEW_CHANGED`, nothing recorded.
- Parameters are checked at every depth for commands and review files; tool arguments and approval-plan targets are checked; `verify-stories` and `prepare-fix` are checked.
- Tests added: Core `review-stale.test.ts`, `command-strict.test.ts`; Runtime `human-only-integrity.test.ts`; S22 host-permission refusal; B07 two tabs in real Chrome.
- Independent Quality, round 3: no way found for host-permission or Trusted Client to approve a human-only act. It found gaps in accept/agree controls, `verify-stories`/`prepare-fix` strictness, the Quality-fix approval in host-permission and Trusted Client ignoring a real dialog; all fixed and re-verified (see FINAL-MATRIX D6-D8).

Residual (stated plainly): `modeChange`/`waivers` in a handed-over file have no base (decisions needing the dialog, recomputed after it); non-decision edits in such a file apply outside the approved text; another process writing between plan and apply is not excluded; `hydrateWorkflowCommand` checks the implementation path prefix without `realpath`; unions: a key accepted by any matching option passes.
- Re-verification of those fixes (same independent reviewer): no way around the new accept guards, no regression in the legitimate flows it probed, one low defect (a dialog answer was labelled `trusted-client` instead of the dialog's own label), fixed with a test. The real-Chrome run was not part of the reviewer's probes; it passes in the final verify (7/7). A page that was not reloaded after its own Save now needs a reload before accept-all/agree (by design, the toast says so).

## Round 5: what is shown is what is applied; real paths

- `praxis_review_apply` now shows the whole plan and binds every command to the approval whenever the file holds anything that needs the person, including every story edit, exclusion and restore, contract removal, mode change, waiver and any change that reaches a story. Plan edits show old and new text and the plan as it will be agreed; nothing is cut; a plan too large for one dialog is refused (`APPROVAL_TOO_LARGE`). The details are recomputed after the dialog and any change ends `REVIEW_CHANGED`.
- `modeChange` and `waivers` need `baseState` of the current work item (from the render result or the page) and are not applied if the item changed; a waiver replay adds nothing.
- Agent-supplied paths are checked by their real location (links, dangling links, absolute, `..`, NUL, non-regular and oversized files), in the Runtime and in the isolated check runner; a Quality patch may touch only its approved file.
- Union edge: not exploitable today; the audit test now guards it.
- Residual: `praxis_frontend_discover` accepts an explicit path outside the repository by design (read-only style discovery of another checkout); the check-then-use race on a path swapped to a symlink between check and read (no `O_NOFOLLOW`) and hard links are not excluded; `workStateStamp` proves the state at render time, not what the person saw.
- Final state of round 5: the diff of a Quality patch is read by `git apply --numstat` itself (paths from the git toplevel, compared lexically with the approved file, links never count); verified against real git for subdirectory, nested, symlinked, submodule, worktree and non-git roots. The AGREE listing applies exclusions, restores and duplicate-entry edits; plan-line-only cascades are shown and gated.

## Round 6: interactive Prototype Review, visual polish of the reviews

**Cause.** The Viewer only knew static tables, buttons that jumped between prepared screens and a state switch. A filter, a side card, tabs, a click on a row and URL parameters had no place in the model, so the agent drew one static screen per situation (PROTO-1: 9 screens) and the review page showed a technical report (ids next to every element, a giant coverage table).

**Changes (no parallel prototype system; the same model and the same page).**
- Model (all optional, so PROTO-1 and any older prototype still open and keep their acceptance; empty new fields are ignored in the content fingerprint, proven by a test that fails without that rule): `filter` with `param` and `filters`, table `rowOpens`/`idField`/`emptyText`/`emptyAction`, `drawer` and `modal` (`param`, `detailFields`, `related`, `withinTable`, `onMissing`), `tabs`, `showWhen`, `required` fields with submit validation, `datasets`, `scenarios` with `expect`, `limitations`. New `update-prototype` operations. References are validated when the prototype is saved (dangling parameters, wrong element kinds in expectations, unreachable overlays).
- Viewer: a small engine that builds DOM from text only; query parameters live in the page `#hash` with a typed address bar, Back/Forward and deep links; Escape, focus into and back out of a card, modal Tab trap, arrow keys on tabs; Desktop and Mobile (container queries). Page layout: large prototype, side panel with Review / Inspector / Scenarios, collapsed Coverage grouped by requirement, a "what this prototype is, and is not" note; modes Preview, Inspect, Review (ids appear only in Inspect).
- Styles: tokens from `praxis_frontend_discover` (colours, font, radius, spacing) drive tables, forms, badges, cards; a token that could fetch a resource (`url()`) is refused. The page states plainly that the application's component library and exact layout are not reproduced.
- Requirements Review: progress bar and requirement chips, groups (needs a decision / accepted / out of scope), compact Accept / Reject / Undecided segments, readable auto-sized text, comments and Remove in line, "Before this revision" markers, dark theme and phone width; every `data-*` hook, stale-page protection and approval flow unchanged. Story Plan and Story Review take the same controls.
- Orders fixture (`praxis-runtime/tools/fixtures/orders-interactive-prototype.command.json`): filter + side card + `status`/`order` in the URL, 13 scenarios; copied to `<lab>/fixtures/` by `setup-lab.sh`. BA skill `prototype` teaches the agent to build behaviour, scenarios and limitations.

**Verification.** Core verify (306 contracts tests, 33 of them new: filtering by all five statuses, empty state and reset, open by click and keyboard, X / Escape / focus return, filter change with an order open, deep links, wrong order, unknown status, legacy order, datasets, Back, hostile markup, modes, comments, scenarios, tabs/forms/modal, legacy compatibility). Runtime verify: MCP 235, packaged-Runtime scenarios 21/21 (411 checks), real Chrome 8/8 (126 checks; new B08 drives the orders case with real clicks, keys, deep links, phone width, scenarios, Review comment + Save, and asserts no request leaves the page and the saved prototype is unchanged). `accept:workflow|stories|generic|claude-code-approval`, BA verify, Marketplace stage + verify, `accept:marketplace-install` pass. Lab update run on a copy of the real lab: Work Item (31 AC accepted), decisions and the global profile unchanged.

**Independent Quality review** (separate agent, real Chrome): 7 confirmed defects, all fixed with regression tests: selector injection through row ids (focus broke after Escape), arrow keys on tabs did not move focus, duplicate history entries, `url()` in a style token made a network request, legacy modal/tabs/filter elements without the new fields vanished, parameter names such as `constructor`, and validation holes (dangling `showWhen`, filter, scenario references and wrong element kinds). Checked clean: XSS paths, hash edge cases, no render loops, fingerprint compatibility, Requirements Review controls, phone width without horizontal overflow. The fixes were not reviewed a second time.

**Migration.** Nothing is migrated silently. PROTO-1 r1 (never accepted in the lab) still renders, in the new page. Making it interactive is a new revision the person previews, applies and accepts (scenario A3-б); the old revision stays in history. Applying the fixture to a copy of the real lab state: revision 2, 31 of 31 criteria still accepted, requirements acceptance intact.

**Residual (plain).** Not proven: how it looks and behaves inside Claude Desktop / Code (the page was exercised in Chrome only); Escape with a native select popup open and IME input in a search box bound to a URL parameter (headless cannot); the fixture covers the orders case, other applications need the agent to model their own behaviour; "faithful in tone" is not pixel-identical to the application; `aria-selected` on table rows and tab panels are approximations of full ARIA patterns; the background behind a modal is not inert (Tab is trapped); the mobile layout is a container-width simulation, not a device.

## Round 7: the manual E2E on orders-app (status was BLOCKED)

Source: `PRAXIS-ALPHA49-FIX-BACKLOG.md` and `MANUAL-E2E-ALPHA49.md` (S1-S20, RD1-RD7, D1, P/B items). Each item was confirmed (or not) before it was changed. The lab was read, never written.

### What stopped the E2E, and the root causes

1. **Quality could say PASS without proof (S17, S18, S19, S16).** A requirement's evidence check looked at its acceptance criteria only when it had no linked Story; a Story-level `verify-stories` wrote a feature verdict from the scenarios of that run alone while `feature-verdict` computed another; `record-verification` replaced the whole coverage; there was no way to give Quality a browser result except an agent's own JSON.
2. **Gates and approvals were not a chain (S8, S12, S11, S20, S13).** Reviewing a story and confirming it were separate but the gate ignored the second; a leftover `excludedReason` after restore changed the plan fingerprint and made an accepted plan stale without anything noticing; a decision confirmed by a person left no durable record (only `confirmedBehavior: true`); the session note said "client dialog" whatever the channel.
3. **Capability gaps from words (S1-S4).** Capabilities were guessed from English keywords anywhere in a requirement, its criteria and data values ("New" -> create, "Cancelled" -> delete), blocked agreement, and the only way out was a waiver nobody could give in the page.

### What changed (files and API)

**Core (`praxis-core/packages/contracts/src`)**
- `quality-model.ts` (new): `criterionStatus`, `requirementCoverage`, `storyCoverage`, `evaluateEvidence`. One computation of total / verified / passed / failed / blocked / missing / stale / attested per requirement and Story. PASS only when every current criterion has a current, independently executed PASS; a Story's own criteria count; results for a revised Story or criterion are stale; results without provenance are not independent proof.
- `workflow.ts`: `record-verification` merges by `scenarioId` (a scenario id never moves to another criterion), stamps the source itself (`executed` / `browser` from the Runtime via options, otherwise `agent`), `retire`, `replaceSource` (only the caller's own kind), `baseCoverageRevision` (`EVIDENCE_STALE`), idempotent repeats; `requirementEvidence` and `evaluateFeature` use the model (feature-verdict = evidence + readiness); `effectiveServices` (a service in a registered repository uses its location, S15); approval records `approvals[]` written by a wrapper around the contract (`approval-audit.ts`): action, subjects with revision and content fingerprint, time, channel, trust (`independent-human` / `review-page` / `host-attested` / `test-only`), work item revision; `record-decision` returns revision and `contentFingerprint`; `humanActRequest` refuses a wrong revision or fingerprint at preview and points at the read (`praxis_workflow_inspect` stories / decisions). `Requirement.retiredCriteria`: ids are never reused.
- `planning.ts`: gates (architecture, development, quality need every active story confirmed and no acceptance gone stale; delivery is judged on the evidence now: no attested-only criteria, no FAIL); restore clears excluded-only fields, the plan fingerprint ignores a leftover reason (old states heal); capabilities: required = what the requirement STATEMENT says a user can do (clause after can/may/must..., outside quotes, data values and parameter tokens) plus what the prototype elements and endpoints built for it do (element kind wins over a contradicting intent); wording in the criteria only SUGGESTS (non-blocking, with the phrase that fired); every gap names what asked for it; waivers carry channel, time and the gap they closed.
- `review-html.ts` / `review-submission.ts`: gaps panel with a waive control and required reason in Story Plan and Stories reviews; waivers applied before the agreement in one Save (S3); re-saving what is already saved is not a conflict (S7).
- `prototype-viewer.ts`: address follows normalization (B1), no-data vs filtered-empty texts and an empty state that keeps the controls (B2, RD5), room for the inspector tag (B3), "simulated address" (P2), self-check label (P5).

**Runtime (`praxis-runtime/packages/mcp/src`)**
- `browser-verification.ts` (new), `generic-verification.ts`, `story-engine.ts`, `tools.ts`, `workflow-store.ts`: browser checks are DATA in `checks.json` (`level: "browser"`, `browser.serve.root`, `steps`: goto/click/fill/select/press/back/forward/reload/viewport and expectUrl/Count/Visible/Hidden/Text/Value/Focus, validated before anything runs). A Praxis-owned driver in its own process group with a scrubbed environment serves the built bundle on loopback, drives a real Chromium (Playwright from the OPERATOR's `PRAXIS_PLAYWRIGHT_DIR`, never the project), allows no HTTP or WebSocket request outside the origin, and returns a result line carrying a per-run nonce. The entry records runner, bundle digest, screenshot digests; the screenshots are stored only on apply (a preview writes nothing). No browser / no bundle: `BLOCKED` with the reason. `verify-stories` marks its results executed/browser, refreshes its own earlier results in place and keeps agent attestations; service location comes from the repository registry (S15); adapters see effective services.
- `tools.ts`: `commandFile` (a file inside the repository, 4 MB, contained; W2) and a compact preview answer without the 80-140 KB briefing (`verbose: true` brings it back; S9/B4).
- `workflow-inspect.ts`: `view: approvals`, per-criterion counts in `quality`; `review-service.ts`: notes say what the channel proved (S20); a review address without its secret shows a page saying why and what to do (P4).
- Acceptance: `quality-browser-acceptance.mjs` (new) drives the developer's React orders-app (fixture `tools/fixtures/orders-react-app`): 31 criteria, 4 Stories, partial coverage, a seeded Escape bug, an agent that tries to launder it, the fix verified again, a reworded criterion going stale, no browser, hostile checks, an app that reaches outside (fetch and WebSocket); `ux-multirepo-e2e` and S09 now use Runtime-executed evidence and confirm stories.

### Defect registry

| ID | Verdict | Root cause / note | Tests |
|---|---|---|---|
| S1 false capability gaps | FIXED | keywords in data and descriptions; now statement operations + built elements, wording advisory with the phrase shown | `capabilities-waivers.test.ts`, `quality-review-fixes.test.ts` |
| S2 no waive in the page | FIXED | gaps panel with reason-required waive, stored with channel/time/gap | same + jsdom |
| S3 agree before waivers | FIXED | waivers first in the submission | same |
| S4 gaps appear later | FIXED | one computation for plan and stories | same |
| S5 plan example / capability enum | DEFERRED | low, docs only | - |
| S6 narrative regex message | DEFERRED | low | - |
| S7 comments resent | FIXED (partly reproduced: a replay reported a conflict for an identical value) | idempotent when the stored value equals the submitted one | `gates-consistency.test.ts` |
| S8 architecture without confirm | FIXED | gate needs every active story confirmed; also development and quality | `gates-consistency`, `quality-review-fixes` |
| S9 / B4 / RD6 80-140 KB preview | FIXED | compact default | `workflow-ergonomics.test.ts` |
| S10 / RD1 source `approved` | FIXED | approval records carry the channel and trust | `approval-audit.test.ts` |
| S11 no audit of human decisions | FIXED | `approvals[]` in state; legacy decisions are reported as unverified provenance | `approval-audit.test.ts`, inspect `approvals` |
| S12 stale plan after exclude/restore | FIXED | restore cleared only `scope:` reasons; fingerprint hashed the leftover; stale upstream now holds later gates | `gates-consistency.test.ts` |
| S13 fingerprint only from an error | FIXED (inspect already exposed it in alpha.49) | `record-decision` returns revision + fingerprint; a wrong value is refused at preview | `approval-audit.test.ts` |
| S14 architect/quality tools need a Jira epic | DEFERRED | local Work Items are served by `praxis_workflow_*` / `inspect`; architecture artifacts and Story-to-component trace are a feature, not a fix | - |
| S15 service ignores registry path | FIXED | `effectiveServices` | `quality-evidence-model.test.ts` |
| S16 no browser evidence | FIXED | see Runtime above | `quality-browser-acceptance` Q01-Q07, `browser-driver-hardening.test.ts` |
| S17 PASS with 3 of 7 criteria | FIXED | per-criterion model | `quality-coverage.test.ts` |
| S18 verify-stories vs feature-verdict | FIXED | same computation | `quality-coverage.test.ts`, Q03 |
| S19 record-verification replaces coverage | FIXED | merge, ids, stale writes, provenance | `quality-coverage.test.ts` |
| S20 "client dialog" without a dialog | FIXED | wording from the channel; the alpha.49 code already refuses personal acts without a real dialog | `approval-audit.test.ts` |
| RD2 approval_plan for review_apply | DEFERRED | | - |
| RD3 two confirmations | NOT A DEFECT | rewording and decisions are two decisions by design | - |
| RD4 viewer element kinds | FIXED (round 6) | | prototype tests |
| RD5 / B2 empty states | FIXED | | `prototype-viewer.test.ts` |
| RD7 reword resets to pending | NOT A DEFECT | by design; documented | - |
| D1 popstate (app) | NOT A PRAXIS DEFECT | the browser DSL has back/forward/reload; a seeded Escape bug is the demonstration | Q02 |
| HTML Save "not verified" | NOT REPRODUCED | verified in real Chrome B01-B08 | `ux-browser-acceptance` |
| P2 hash not query | FIXED (labelled) | | viewer test |
| P3 unknown status stays in URL | DEFERRED | by design (AC-05 only asks for "All") | - |
| P4 one-time link | FIXED (page explains) | the working link stays secret by design | `workflow-ergonomics.test.ts` |
| P5 "13 of 13" | FIXED (labelled self-check) | | viewer test |
| B1 / B3 | FIXED | | viewer test |
| W2 large payload | FIXED | `commandFile` | `workflow-ergonomics.test.ts` |

### Independent Quality review (another agent, source and probes)

Pass 1 found 12 defects: a Story-own criterion FAIL did not reach the feature verdict; an agent-only record opened the delivery gate; a removed criterion's id was reissued and revived an old PASS; a Playwright planted in the project produced a forged browser PASS; a `-CONFIRMATION` suffix hid a FAIL; recorded legacy verdicts kept delivery open; development/quality ignored unconfirmed stories; WebSocket egress was not blocked; a timeout left Chromium running and crashed the caller; the capability masking swallowed possessives and "e.g."; Chromium ran without its sandbox and screenshot names collided; duplicate waivers in one file and batch approval subjects. All were fixed with tests (see commits). Pass 2 re-verified the critical fixes: see the section below.

### Migration and risks

- Persisted state: new fields have defaults (`coverageRevision`, `approvals`, `Requirement.retiredCriteria`, entry fields); an old state parses. Coverage written before provenance has no source: it is read, shown as attested, and keeps requirements at PASS_WITH_RISKS until `verify-stories` runs again. On the real lab state (copy): evidence 0 of 31 independently proven (8 attested, 4 stale, 19 missing), approvals: 6 decisions without a record are reported as unverified provenance; the gate on stories passes (all 4 confirmed); the plan acceptance stays accepted.
- Stricter on purpose: a Story's criteria and requirement criteria must both be proven; a Story whose criteria carry their own ids (not the requirement's) needs results for those ids.
- Browser checks need the operator to provide Playwright (1.48+) and a browser; otherwise BLOCKED. Chromium runs sandboxed; `PRAXIS_BROWSER_NO_SANDBOX=1` is the operator's opt-out for containers.
- Not proven: Claude Desktop / Code UI; that a person answers the dialogs; the host-attested channels; a client that identifies the person (the `actor` field stays empty).
- Residual: the project under test can still be hostile in the page it serves (it is contained to loopback, no secrets, no files); the review link file in the temp directory is readable by a same-user process during its 15 seconds (earlier rounds, documented).

### Independent review, pass 2 (same reviewer, critical fixes)

Eleven of the twelve findings held; two gaps were found and fixed afterwards, each with a test: (1) Chromium has its own process group, so a timeout left browser processes alive (the run now sweeps everything that carries its private profile path, and the driver closes the browser on SIGTERM; test: no process with the run's profile survives a timeout); (2) a criterion id removed before `retiredCriteria` existed, and surviving only in coverage, could be reissued (ids found in coverage are now excluded too). Not re-probed by the reviewer: the waiver dedupe, the batch approval subjects and the friendly review page (covered by unit tests). The last fixes were not reviewed a third time. Also found by the final build: the committed Claude plugin bundle lagged the source (refreshed and re-staged); one jsdom test waited a fixed delay for history traversal (now waits for popstate).

Final numbers: Core contracts 355 tests, Runtime MCP 246, packaged scenarios 21/21 (413 checks), real Chrome 8/8 (126), Quality browser on the React orders-app 7/7 (53), multi-repo E2E 141 checks, BA / Architect / Developer / Quality verify, Marketplace stage + verify, install acceptance and `accept:mcpb-runtime` PASS. Architect/Developer verify need the sibling plugin roots in the environment (`PRAXIS_BA_ROOT`, `PRAXIS_DEVELOPER_ROOT`, `PRAXIS_ARCHITECT_ROOT`, `PRAXIS_QUALITY_ROOT`).

### Release readiness verdict (round 7)

**Ready for the short manual regression (MANUAL-ACCEPTANCE, scenario Z); not yet a release.** The defects that made the E2E BLOCKED are fixed and independently probed. Open on purpose: S14 (local-mode architect tools), S5/S6/RD2/P3 (low); not proven: Claude Desktop / Code UI, that a person answers the dialogs, and a full manual run on the user's lab. The lab Quality state will honestly read FAIL until `verify-stories` (and the browser checks) are run again: that is the intended result of the stricter model, not a regression.

---

# Round 8: independent check of the real E2E, release readiness (2026-10-29)

Input: the lab run 9 (`WI-FILTR-ZAKAZOV-PO-STATUSU-001`, 31/31 PASS, 35 records: 14 executed + 21 browser). Scope was limited to checking that result, closing the open audit items, and the release readiness report. Nothing was published, no version or manifest changed, no push, merge or deploy. The lab project and its Work Item were only read (copied into the session scratchpad for the review); `reset-lab.sh` was not run.

## 1. Independent review of the E2E (separate agent, on a read-only copy)

Reproduced: the bundle digest (`3084caa8…`, rebuilt from source in the lab layout), all 21 screenshot sha256 and byte counts (21 persisted, 21 on disk, no orphans), artifact times inside the run window, 14/14 unit checks on live source, 21/21 browser checks through the real Runtime driver in Chrome. The 31 criteria are all requirement ids (31 = 7+7+11+6, none unique to a Story); the model counts the Story criteria and finds nothing unproven.

What the review found about the CHECKS (the lab's `checks.json`, written by the same agent that built the stand; not changed, since the source Work Item must stay as it is):

| | |
|---|---|
| STRONG | 13 of 31 criteria |
| WEAK | 15 (value not bound to its label or position, unit-only without a UI path, literals copied from the data) |
| FORMAL | 3 (`REQ-ORD-002-AC-06`, `REQ-ORD-005-AC-05`: only the absence of the literal "History"; `REQ-ORD-002-AC-07`: the dash can come from the Items fallback) |
| MISSING | 0 |

34 mutations of a copy of the app were rebuilt and run through the real driver: 18 were killed by a check of their own criterion; 13 survived with no check of that criterion failing (swapped Customer/Status cells, swapped Created/Total or Qty/Price or email/phone, filter moved below the table, "справа"/highlight not asserted, an extra "Status log" section, a blanked dash, removing the reconcile on filter change, order param left in the URL after closing the drawer, URL cleanup via `replaceState`); 3 survived only their own check and were caught elsewhere. Details and the mutation list are in the review (scratchpad `mut/results.txt`).

Reading of the result: **31/31 is an honest independent execution (the Runtime ran its own browser, evidence is persisted and traceable), but it is not proof that every criterion is strongly tested.** A human should review the 18 weak/formal checks before the Work Item is called accepted. This is a property of the lab's checks, not a defect of the Runtime. Other limits stated by the review: the browser bundle removes ORD-2005 (the empty state is unreachable on real mock data); the entry point lives in `qa-stand` (orders-app has none); the digest depends on the build location (esbuild embeds relative paths); screenshots are final-state only (21 files, 7 distinct images); the driver does not fail a check on console errors; `expectHidden` passes when the selector matches nothing.

Defects of the PRODUCT found by this review, fixed:

| | Finding | Fix |
|---|---|---|
| E1 (blocking) | `subjectDigest` was stored but never compared: editing the served bundle left 31/31 PASS (demonstrated: digests zeroed, still PASS) | the Runtime marks browser evidence stale **in memory** when the bundle on disk differs from the one recorded (or is gone); every reader, gate and verdict sees it; the mark is stripped before any write and is not part of the preview token. Demonstrated on a copy of the lab Work Item: as is 31/31; after a 13-byte edit of `dist` 12/31 with 19 stale; restored, 31/31 again |
| E2 | persisted `runId` was `[redacted]` (matched the secret mask) and did not equal the artifact directory | run ids are not masked; the entry's run id is the artifacts directory name |
| E3 | the service verdict (`V-SERVICE-*`) counted a drifted PASS | drifted results are excluded from it |

Limit that remains by design: evidence binds to the **built bundle**. If `src/` changes and nobody rebuilds `dist`, the browser results still describe the old bundle (unit checks read live source). Rebuilding is the project's build step; the evidence goes stale as soon as the bundle changes.

## 2. Human approvals and HTML Save

Automated (already in the suite): `approvals[]` is written by the contract from verified approvals (revision, content fingerprint, time, channel, assurance, trust, work item revision); test-only, review-page, host-attested and independent-human are distinct; a legacy decision is never upgraded (inspect `approvals`: "unverified provenance"); a command cannot set a source or a trust; HTML Save, reopen and the stale page were checked in real Chrome (B01-B08, 126 checks).

Not possible without you: a real click in the client's dialog. Prepared: **scenario H** in MANUAL-ACCEPTANCE (10-15 minutes) on an isolated copy of the Work Item: `make-approval-copy.sh`, `approval-check.mjs` (prints `approvals[]`, lists decisions without a record, proves the source Work Item is unchanged by hash), `start-alpha49.sh approval`. The copy was created and its state checked here: `approvals[]: 0`, four legacy decisions reported as unverified provenance, source unchanged. **STATUS: NOT VERIFIED with a person for alpha.49.** (alpha.48 had one confirmed person approval in Claude Code CLI 2.1.304 on 2026-10-22, `release/alpha.48/CLIENT-APPROVAL-STATUS.md`.)

## 3. Open audit items and the browser runner

The two Round 7 fixes were re-reviewed by an independent agent that ran them: **cleanup of Chromium after a timeout** (timeout mid-run, infinite-loop app, driver killed mid-run, normal run: no process, temp dir removed) and **retired AC ids** (remove/add chains, remove-all-then-add, record on a retired id refused, re-add with old evidence shows `missing`, legacy state): no blocking defect. Findings of that review, all fixed with tests:

| | Finding | Fix |
|---|---|---|
| R1 | WebRTC (STUN) and `preconnect` reached a LAN listener; only HTTP and WebSocket were blocked | Chromium started with `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1` and the WebRTC non-proxied-UDP policy; test with real UDP and TCP listeners (nothing received) |
| R2 | `serve.root: "."` served `/.env`, `.git/`, `.praxis/` | a root equal to the service directory is refused; the page is served from a private copy that never contains dot-names or links |
| R3 | a killed Runtime left the driver and 7 Chromium processes alive and the temp dir | the driver stops itself (watchdog and parent-loss check), removes its directory; test kills the parent with SIGKILL |
| R4 | the served bytes were not the digested bytes | the bundle is copied once, digested and served from the copy |
| R5 | artifacts were written through a possible planted symlink | existing target removed, written with `wx` |
| R6 | unbounded viewport; criterion numbering poisoned by a huge id | viewport 200-3000; only 1-6 digit suffixes count |

A third pass over these fixes (separate agent, targeted tests) found 5 should-fix items and no blocker; all fixed: `comparable()` must not include the run id (every re-run would have bumped `coverageRevision`); the driver removes the bundle copy when it stops itself; the drift mark must not be in the preview token (a build touching `dist` between preview and apply would have refused the apply); no time-based digest cache; the service verdict ignores drifted results.

Verified by running: scrubbed environment (a sentinel variable and `NODE_PATH`/`NODE_OPTIONS` did not reach the driver); a planted `playwright-core` in the project is never loaded (unset or relative `PRAXIS_PLAYWRIGHT_DIR` fails closed); Chromium runs with its sandbox (no `--no-sandbox`; `PRAXIS_BROWSER_NO_SANDBOX` is read only from the operator's process environment, never from a project `.env`); `%2e%2e`, `..%2f`, symlinked file and directory, `//etc/passwd`, `%00` and non-GET were all refused by the static server; temp directories are 0700.

Residual security risks (not fixed, stated): project code (an `adapter.mjs`, check modules) runs as the same OS user with no OS sandbox before the browser run; if `PRAXIS_PLAYWRIGHT_DIR` is writable by that user, Playwright can be tampered with: keep it read-only (`setup-quality-browser.mjs` creates it under `~/.praxis`); memory and disk exhaustion by a hostile page is bounded only by the 240 s timeout; DNS exfiltration through the resolver was not tested (the rule maps every name but loopback to NOTFOUND, believed closed); Linux and Windows were not run; the cleanup sweep needs `ps`; the snapshot copy has a small lstat/copy window (same-uid attacker, egress is blocked).

## 4. Delivery and clients

- **Reproducible Playwright/Chromium for Quality:** `node praxis-runtime/tools/scripts/setup-quality-browser.mjs` (pinned `playwright-core 1.64.1` into `~/.praxis/quality-browser`, `--ignore-scripts`, finds Chrome/Chromium, proves a headless launch, prints the two variables `PRAXIS_PLAYWRIGHT_DIR` and `PRAXIS_BROWSER_EXECUTABLE` that the Runtime MCP process needs). Without them a browser check is BLOCKED with the reason.
- **Marketplace, clean test profile** (`accept:marketplace-install`, throwaway `CLAUDE_CONFIG_DIR`, Claude Code CLI 2.1.304): one Runtime MCP server; every role ships `local-workflow` and `present-plan`; 61 tools and `praxis_doctor` answer from the plugin cache; Approval Required refuses a protected write (`APPROVAL_CLIENT_UI_REQUIRED`); Trusted Client (explicit) writes and is labelled; single-role install pulls only the Runtime; update alpha.47 to alpha.48 in place; no developer path in the shipped files.
- **Versions:** all six repositories, plugin manifests, Marketplace and bundles are at `0.1.0-alpha.48` (`check-ecosystem-version`, `check-coordinated-release` PASS). Not changed; the bump belongs to the publication decision, and the in-place upgrade to alpha.49 cannot be tested before it.
- **Clients (see section "Clients and environments" in the verdict below).**
- **Trusted Client:** explicit opt-in only (`PRAXIS_APPROVAL_MODE=trusted-client`, not from a repository `.env`); excludes `confirm-story`, `confirm-decision`, `approve-service`; its records are `host-attested`, never "human". Proven by `accept:approval-ux` and the install acceptance; not proven in a real Desktop session.
- **BA Jira proposal (`resume-ba-work`):** BA verify passes; no Jira write was exercised in this round. **NOT VERIFIED against a live Jira.**
- **Hooks:** the plugins ship only `hooks/session-start.md` (documentation for the session-start skill); no executable hook, no `hooks.json`. The earlier approval hook was removed (iteration 11).
- **Licensing:** unchanged and open for the owner (`LICENSE-AUDIT.md`): Runtime, Quality, Core, Marketplace are UNLICENSED with no LICENSE file; BA, Architect, Developer declare Apache-2.0 but the repository roots carry no LICENSE text; the Quality and Runtime packages bundle third-party code without a NOTICE. **No licence was chosen.**

## 5. Verification (all local, final state)

| | Result |
|---|---|
| Core contracts | 357 tests; tools 64 tests |
| Runtime MCP | 253 tests (new: `browser-evidence-drift`, 5 hardening tests with real Chrome, UDP/TCP listeners, SIGKILLed parent) |
| Runtime `npm run verify` | EXIT 0: packaged scenarios, real-Chrome Review acceptance, Quality browser on the React orders-app (Q01-Q07 incl. the seeded Escape bug and hostile checks), multi-repo E2E, quality-review/apply, Git delivery |
| BA, Architect, Developer, Quality `npm run verify` | all exit 0 (with the four `PRAXIS_*_ROOT` variables pointing at the sibling repositories) |
| Marketplace | `stage` + `verify` exit 0; staged Runtime bundle byte-identical to the Runtime's; `accept:marketplace-install` exit 0 |
| Lab compatibility | the real Work Item (a copy) read with the final build: feature PASS, 31/31 verified, 0 stale, no drift; the source Work Item hash unchanged; `approvals[]` empty and the four legacy decisions still "unverified provenance" |
| Independent reviews | 3 passes (E2E checks; browser runner and the two open fixes; fixes of this round): every confirmed finding fixed except those listed as residual |

Local commits (branch `feature/ux-overhaul`, nothing pushed): Core `fdb3ca3` + the follow-up on top; Runtime `34a72b0`, `6d2d83b`, the review-pass-3 commit and the setup-script commit; Marketplace "Stage: round 8 bundle". The release folder is not a git repository.

# Release readiness (round 8)

**1. Confirmed PASS.** Quality evidence model with provenance (executed / browser / agent), single verdict model, AC completeness; independent browser execution reproduced three times, plus the seeded-bug control (30 PASS / 1 FAIL, then PASS); evidence goes stale when a criterion or Story revision changes **and now when the served bundle changes**; gates and stale upstream acceptance; capability detection and waivers; `approvals[]` for verified decisions, legacy decisions never upgraded; HTML Save, reopen and stale page in real Chrome; browser runner isolation (scrubbed env, no substituted Playwright, sandbox on, no HTTP/WebSocket/WebRTC/preconnect egress, contained serve root, cleanup on timeout and on parent loss); install from the Marketplace in a clean profile; version consistency (alpha.48 everywhere, untouched); lab state compatibility.

**2. Blocking problems.** No open product defect is known to me. Three things stand between this state and a publication, none of them a code change:
- a real click in the client dialog and in Chrome on the alpha.49 build (scenario H) has not been done by a person (`NOT VERIFIED`);
- the licence decision (owner): the public repositories have no licence text for Runtime, Quality, Core and Marketplace, and the role plugins declare Apache-2.0 without a root LICENSE (`LICENSE-AUDIT.md`);
- the version bump and the in-place upgrade test (alpha.48 to the new version), which needs the bump.

**3. Deferred, not blocking.** S5, S6, S14 (local architect tools without a Jira epic), RD2, P3 (from round 7); browser checks do not fail on console errors; screenshots are final-state only; `localhost` URLs are not reachable from a browser check (only the `127.0.0.1` origin is); dot-named files are not served to the app under test; the legacy single-file state layout is not drift-marked; an unreadable or removed `checks.json` makes browser evidence stale (conservative); `actor` in `approvals[]` stays empty because no client identifies the person; `doctor` still reports an unstarted Quality service as `healthy: false` without a next action (found in the Runtime diagnostics backlog, not touched).

**4. Security risks (residual).** Project code (adapter, check modules) runs as the same user with no OS sandbox; `PRAXIS_PLAYWRIGHT_DIR` must be read-only for that user; a hostile page is bounded only by the 240 s timeout (no memory/disk cap); DNS exfiltration and Linux/Windows were not tested; the review link file in `TMPDIR` is readable by a same-user process for about 15 s; Trusted Client and "Always allow" are standing permissions, recorded as `host-attested`, never as a person; the strength of the lab's 31/31 depends on checks that an independent review rates 13 strong, 15 weak, 3 formal.

**5. Clients and environments.**

| | Status |
|---|---|
| Claude Code CLI 2.1.304 (macOS) | install from the Marketplace: **PASS** (scripted client). Real person approval: confirmed for alpha.48 on 2026-10-22; **NOT VERIFIED for alpha.49** (scenario H) |
| Claude Code GUI / Desktop Code | **NOT VERIFIED.** For alpha.48 an apply was answered `decline` 9 ms after the form with no form shown (known client behaviour, anthropics/claude-code#89858, #96043). This session's own Desktop client, through the installed alpha.47 extension, declares no elicitation (`praxis_doctor`: `approval.mode: no-dialog`, `dialog: false`): protected actions are refused, previews work |
| Claude Desktop Chat | not applicable for plugins; needs `praxis-runtime.mcpb`; no dialog, refused by default, Trusted Client by explicit setting; **NOT VERIFIED** with the alpha.49 build |
| Claude Web Chat | skills only, no local Runtime |
| Operating systems | macOS arm64 (Node 24, Chrome 156, Playwright 1.64.1) only. Linux and Windows **NOT VERIFIED** |

**6. Installation requirements.** Node 20+ (verified on 24); Claude Code CLI 2.1.304 or newer; marketplace `dfg-inc/praxis-marketplace` then `praxis` (installs the Runtime and the four roles). Browser checks in Quality need an operator-installed Playwright 1.48+ and Chrome/Chromium: run `node praxis-runtime/tools/scripts/setup-quality-browser.mjs` and give `PRAXIS_PLAYWRIGHT_DIR` and `PRAXIS_BROWSER_EXECUTABLE` to the Runtime MCP process; without them browser checks are BLOCKED with a reason. A client with an approval dialog (elicitation) is needed for human acts; otherwise Trusted Client by explicit setting.

**7. Release readiness: NOT READY for publication, READY for the last manual gate.** The code and the local test and acceptance evidence are complete and no open blocking defect is known. It becomes READY when you (a) run scenario H (10-15 minutes) and its result is as described, (b) decide the licence, (c) decide the version bump and run the upgrade check. Publication stays your decision; nothing was published, versioned, pushed or merged.

---

# Round 9: scenario H result, final risks, release checklist (2026-10-29)

No code changed in this round. Only documentation.

## Scenario H (isolated copy `~/praxis-alpha49-approval-copy`; source Work Item untouched, hash checked)

| Step | Result |
|---|---|
| H1 copy, `approvals[]: 0`, 4 legacy decisions unverified | PASS |
| H2 update-story, then confirm-story US-ORD-004 through the client dialog | PASS (APR-0001: `client-elicitation`, `client-ui`, `independent-human`, r4 + contentFingerprint) |
| H3 agent must not confirm without a dialog | **PARTIAL / INCONCLUSIVE** (APR-0002, see below) |
| H4 HTML Save in real Chrome, reopen | PASS: decisions and comments are saved and survive reopening |
| H5 stale Review page | PASS: staleness is decided **per Review item**, not per page. The expectation in MANUAL-ACCEPTANCE (step 5) said "page is stale"; it now says what the product does |
| H6 final check | PASS with reservations (APR-0002; legacy decisions still without provenance) |

**APR-0002** is a `confirm-story` for US-ORD-001 r1 at 13:06:23Z, `client-elicitation` / `client-ui` / `independent-human`, about two minutes after APR-0001. H3 expected no record. What is known: the client returned Approve to the Runtime's dialog request. What is not known: whether a person pressed Approve (against the script's "Reject") or the dialog was answered by the client without a person. The client does not name the person (`actor` empty) and no client-side log of the dialog was examined. It is therefore **neither declared a confirmed human action nor a Praxis defect**. To close it: repeat H3 on a fresh copy, press Reject, and compare with the client's own record.

Observation, not a defect: the copy has no `review-page` record after H4/H5. By the code (`workflow.ts`, review apply) that record is written when the page applies a stage action; marks and comments alone create none. The page text and the check expectations now say so. I did not observe a stage action from the page in this run.

## Provenance limits and unconfirmed Desktop/GUI capabilities
- `independent-human` means "the client returned Approve to its own dialog". It is not an identified person; `actor` is empty by design.
- Legacy decisions (`requirements_review`, `prototype`, `story_plan`, `stories_review`) stay "unverified provenance" and are never upgraded.
- `host-attested` (Trusted Client) is a standing permission, not a human approval.
- Claude Code CLI: dialog works (confirmed for alpha.48; alpha.49 H2 here). **Desktop Code / GUI dialog: NOT VERIFIED** (alpha.48: an apply was answered `decline` with no form shown; this session's Desktop, through the installed alpha.47 extension, declares no elicitation). **Desktop Chat with the alpha.49 build: NOT VERIFIED.** Web Chat: skills only. Linux, Windows: NOT VERIFIED. Live Jira: NOT VERIFIED.

## Remaining risks and deferred (final list)

Security risks:
1. Adapter and check modules run as the same user, no OS sandbox.
2. `PRAXIS_PLAYWRIGHT_DIR` must be read-only for that user.
3. A hostile page is bounded only by the 240 s timeout; no memory or disk cap.
4. DNS exfiltration channel from the browser not tested.
5. The review link file in TMPDIR is readable by a same-user process for about 15 s.
6. Trusted Client is a standing permission.
7. `independent-human` is only as strong as the client's dialog (see APR-0002).

Quality-evidence limits: evidence binds to the built bundle, not `src/`; 13 of 31 lab checks STRONG, 15 WEAK, 3 FORMAL, 13 of 34 mutations survived (31/31 is honest execution, not proof of strong tests); console errors do not fail a check; screenshots are final-state only; `localhost` URLs and dot-files are not reachable from a browser check; the legacy layout is not drift-marked.

Deferred tasks: S5, S6, S14, RD2, P3; `doctor` reports an unstarted Quality service as `healthy: false` without a next action; tests hard-code `/Users/serg/...` and the macOS Chrome path; `actor` stays empty; two-click H3 retest; in-place upgrade test (needs the bump).

Owner decisions: licence (not chosen), version bump, publication.

## Repository state
`npm run verify` on the final commits (2026-10-29, the four sibling-root variables set): core, runtime, ba, architect, developer, quality, marketplace **all exit 0**. All seven repositories are on `feature/ux-overhaul` and clean after restoring the artifacts that the acceptance scripts regenerate (`claude-extensions/*`, `claude-plugins/*.zip`; content-equal, timestamp-only changes). Heads: core `6764f92`, runtime `fcccf8b`, ba `51b60e9`, architect `ffcf639`, developer `9f50809`, quality `9b60298`, marketplace `973f0b6`. Nothing pushed, tagged, merged or published.
Versions: every product package, plugin manifest, MCPB manifest and Marketplace entry is `0.1.0-alpha.48` (consistent, 70 manifests checked); the only others are outside this release (`praxis-docs` alpha.44 and the installed Desktop extension alpha.47, `vendor/0.1.0-alpha.44`). No version was changed. The release documents live outside the product repositories (`/Users/serg/work/praxis-split/release/`); the local commits are in the seven repos.

---

# Round 10: release candidate alpha.49 (2026-10-29)

Owner decisions applied: local bump alpha.48 to alpha.49 (allowed), licence **Apache-2.0** (decided), holder `Copyright 2026 dfuture-co`. No functionality was added. Nothing pushed, merged, tagged, released or published.

## What was done
1. **H3 retest: PENDING, needs the owner's click.** A fresh copy is prepared (`~/praxis-alpha49-h3-copy`, `manual-lab/h3-check.mjs` snapshots it). Expected: confirm-story on `US-ORD-004` is Rejected in the dialog; the Story stays `proposed`, no approval is recorded. APR-0002 therefore stays INCONCLUSIVE until that run. The retest should be run on the RC build (the lab uses the staged marketplace; restage is committed).
2. **Version bump** in all seven repositories with the repositories' own `set-ecosystem-version.mjs`, plus Core vendor refresh (Runtime: bundle rebuilt from Core `cab84df`; the four roles: vendored Core packages replaced by tarballs packed from the same Core commit, which moves them from the older baseline `a42b892`, integrity in the lockfiles rewritten). Marketplace restaged. Untouched: `praxis-docs`, `vendor/0.1.0-alpha.44`. Remaining `alpha.48` strings are deliberate baselines (migration tests, the tool-compatibility acceptance against the alpha.48 bundle, upgrade docs).
3. **Licensing.** Official Apache-2.0 text (sha256 `cfc7749b…`, 11358 bytes, from apache.org) and NOTICE in all seven repos and in every plugin and archive; all manifests, READMEs, catalog entries Apache-2.0; tests that required `UNLICENSED` for jira and quality-service now require Apache-2.0; the MCPB build copies LICENSE, NOTICE and THIRD-PARTY-NOTICES.md into the archive and the MCPB acceptance asserts them. Third-party notices generated by `tools/scripts/gen-third-party-notices.mjs` in Core from the licence files of the bundled packages (the five inlined by the MCP SDK build were fetched from the npm tarballs of the exact versions): MIT, ISC, BSD-3-Clause, and the MCP SDK's MIT/Apache transition text unchanged. `sql-wasm.wasm` embeds SQLite and an Emscripten runtime; their terms are flagged, not verified. No third-party code was relicensed. Open for the owner (cannot be checked from files): legal name of the holder; rights to the company handbook dataset and to unattributed prompts/skills; the `jetruby.com` commits. `LICENSE-AUDIT.md` has the resolution note.
4. **Install, upgrade, rollback** in a throwaway profile: PASS (see `COMPATIBILITY-MIGRATION.md`). Upgrade 0.1.0-alpha.48 to 0.1.0-alpha.49 in place; rollback by uninstall plus install from the previous marketplace revision.
5. **Quality runner security model** written: `QUALITY-RUNNER-SECURITY-MODEL.md` (no OS sandbox for adapters, trusted projects only, `PRAXIS_PLAYWRIGHT_DIR` read-only and operator-owned, network and resource limits, each line CONFIRMED / BY DESIGN / NOT TESTED).
6. **Quality backlog** written: `QUALITY-BACKLOG.md` (3 FORMAL, 15 WEAK, 13 surviving mutations, runner gaps). 31/31 is not presented as proof of all AC.
7. **Versioned documents:** the release documents are copied (history kept: the originals stay in place) to `praxis-core/docs/releases/0.1.0-alpha.49/` and committed locally. They contain local paths and internal references; review before any push of Core.
8. **Checklist** `RELEASE-CHECKLIST-alpha.49.md`: state, owner decisions, exact publication and rollback commands (not run).

## Verification
`npm run verify` exit 0 in all seven on the final state (numbers in the final answer). Marketplace install and upgrade acceptance PASS (11 checks). Working trees clean after restoring regenerated archives (the final archives are committed: they now carry the licence files).
