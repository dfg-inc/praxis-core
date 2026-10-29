# Praxis UX & workflow overhaul: final report

Local branches `feature/ux-overhaul` in core, runtime, ba, architect, developer, quality, marketplace. Nothing was published, tagged, merged, deployed or written to an external system. Version strings are still 0.1.0-alpha.48.

## 1. The owner's remarks

Status uses the independent Quality verdicts (QUALITY-REPORT-1, QUALITY-REPORT-2) plus the fixes made after round 2. PARTIAL means a named residual remains.

| # | Remark | Implemented | Tests | Status |
|---|---|---|---|---|
| 1 | Skills/instructions from analysed repos hijack the agent | Instruction precedence and skill plan as code (`context-trust.ts`); instruction files listed, never returned or followed; scanner; `praxis_context_diagnose`; repo `.env` cannot set review/approval keys | `context-trust.test.ts`, S19, planning-tools tests | PARTIAL: scanner is an English heuristic; file names pass through; the host decides which skills load |
| 2 | Why JSON | JSON is internal; humans get HTML; explained in `docs/workflow-stages.md` | docs | PASS |
| 3 | Where context and session log live; continuing after the window ends | Session log, briefing, `next`, `resume`, `resume-work` skill; says the chat is not restored | `briefing.test.ts`, S12 | PASS |
| 4 | User stories unusable, too much text | Short Story Plan first (what is built, what the user gets, data, prototype parts, REQ/AC); stories only after the agreed plan in guided items | `planning.test.ts`, S05 | PARTIAL: gates apply only to guided items (skills open guided; default stays classic for alpha.48) |
| 5 | HTML acceptance tool was invented ad hoc; JSON had to be read | Standard renderers + submission contract + save-back (`review-html.ts`, `review-submission.ts`, `review-service.ts`) | jsdom tests, S03/S14 | PASS |
| 6 | Stories only for creation, none for viewing | Coverage analysis (view/search/filter/create/edit/delete/validation/error/permissions/states) blocks `architecture` | `planning.test.ts`, S07 | PARTIAL: label-based (a mislabelled story passes); documented |
| 7 | Cannot edit or remove stories or take requirements out of scope | `update-story` by id, exclude/restore/split/merge, history, scope with cascade and stale marking | S05, S06 | PASS |
| 8 | HTML + mock prototype before stories | Prototype state, viewer with states/roles/navigation/mock data, API prototype, links to REQ/AC | S04, jsdom | PASS |
| 10 | (praise to keep) | kept | | PASS |
| 11 | REQ in HTML, not JSON | Requirements review page | S03 | PASS |
| 12 | Each AC its own checkbox | Per-criterion accept/reject/comment/edit/remove/add | jsdom, S03 | PASS |
| 13 | Prototype session refinement | `update-prototype`, feedback, revisions, persisted | S04 | PASS |
| 14 | Prototype reads app code for styles | `praxis_frontend_discover` (CSS custom properties, Tailwind/MUI theme objects), sources listed | planning-tools tests, S04 | PARTIAL: other styling systems are missed |
| 15 | Plan: which story covers which prototype part and REQ | Story Plan with `screenRefs`, `requirementIds`, `acIds` | S05 | PASS |
| 16 | Story generation | `add-story`, inherits plan line | S05 | PASS |
| 17 | HTML review of stories, checkbox per item | Stories review page | jsdom, S05 | PASS |
| 18 | What does Praxis add over Claude Code + skills | Section in docs: durable state, gates, user-only decisions, traceability, independent verification, multi-repo | docs | PASS |
| 19 | Change requests | `change-request` skill, `record-impact`, work item kinds, prototype gate needs impact | S02 | PASS |
| 20 | Local vs Jira/Epic | `docs/jira-vs-local.md` (states that nothing syncs local work to Jira automatically) | docs | PASS |
| 21 | Multi-repository stories | Repository registry, inspect, assign, contracts, order, per-repo brief/progress, gates | S08, `briefing.test.ts` | PARTIAL: an agent can still mark a contract `agreed`; "entered" needs an existing file, not proof of work |

Line 9 of the source is a heading.

## 2. Sections A-J

A trust/skills: PARTIAL (see 1). B persistence/resume: PASS. C requirements review: PASS. D prototype: PASS. E story plan: PASS. F story management: PARTIAL (coverage by labels). G change requests: PASS. H multi-repo: PARTIAL. I local/Jira: PASS. J mechanisms and tests: PASS.

Cross-cutting property "an agent cannot record the user's acceptance": round 1 FAIL (review link in the tool result). Fixed in code (link opened by the Runtime, per-load save token, Origin required, test hook moved under a forbidden prefix) after round 2 found the `.env` bypass. Not independently re-verified after the last fix: the quality agent's reproduction was re-run by the implementer only as a code-level check.

## 3. Change list

| Repo | Base -> HEAD | What |
|---|---|---|
| praxis-core | 0f71e38 -> 15a5c5a | contracts 1.1.0: planning schemas and reducers, gates, coverage, review renderers and submission, context trust, briefing, command catalog, migration; docs; `PRAXIS_REVIEW_` dotenv prefix |
| praxis-runtime | d55ed5b -> latest | review service (loopback), frontend discovery, repository inspect/brief, context diagnose, command catalog tool, migration on read with backup, session/status briefings, acceptance script `accept:ux-overhaul`, vendored Core |
| praxis-ba | dc03b66 | six new skills, updated local-workflow/present-plan/session-start |
| praxis-architect / developer / quality | | multi-repository and context sections in local-workflow |
| praxis-marketplace | 3c0ab03 (github/master) | restaged plugins; branch cut from the merged master |

## 4. Results

- Core `npm run verify`: pass (contracts 179 tests).
- Runtime `npm run verify`: pass, including 157 unit tests, seven earlier acceptance scripts and `accept:ux-overhaul` (18 scenarios, 317 checks, 2 Jira GETs, 0 writes).
- BA, Architect, Developer, Quality `npm run verify`: pass (Architect and Developer need `PRAXIS_{BA,ARCHITECT,DEVELOPER}_ROOT` set to the repo roots: pre-existing requirement).
- Marketplace `verify` and clean-clone install acceptance (Claude Code CLI 2.1.304): pass, 59 tools. In-place upgrade not run (versions equal).
- Independent Quality: round 1 found 27 defects (1 blocker); round 2 found 16 fixed, 9 partial, 1 not fixed, plus 7 new (1 blocker, N1, since fixed). A third round was not run.

## 5. Defects found and fixed

Persisted-state redaction of `tokens`; `add-story` dropping fields; review link in the agent's tool result; `.env` enabling the link file; stale pages agreeing the plan; marks not completing the review; agent-made waivers; implementation records for non-existent work; delivery gate ignoring unfinished services; prototype data corrupted by redaction; work-item choice never asked; command discoverability; search box losing focus; symlinked paths; decisions-file symlink escape; and the minor items listed in QUALITY-REPORT-1/2.

## 6. Remaining limits

D04 (guided is opt-in by the skill), D07 (any existing file), D13 (replay within 10 minutes), D15/N6 (history bounded by count not size), D16 (labels), D17 (names, English scanner), D19 (agent can mark a contract agreed), D20 (one-way migration, version string), D22 (error code on corrupt state), N2 (secret heuristic), N3 (`openedInBrowser` can be true when the opener failed; each render opens a tab), N4 (dialog omits requirement-level notes). An agent with an unrestricted local shell acts as the user on that machine.

## 7. Examples

`examples/1..5-*.html` (requirements fresh and in progress, prototype, story plan, stories), generated by the same renderers. Architecture: ARCHITECTURE.md. Compatibility: COMPATIBILITY-MIGRATION.md. Needs you: USER-CHECKS.md.

## 8. Recommendation

Ready for a release-candidate branch **after** a short third Quality round on N1 and the open majors (D04, D07, D19) and a version bump; do not merge or tag before you have done checks 1-5 in USER-CHECKS.md in your own Claude. Not recommended to treat the model-following behaviour of the skills as proven.

---

# Iteration 2 (owner's follow-up): completion, real browser, multi-repository, Dustin's items

## Added
- **Real-browser acceptance** (`praxis-runtime/tools/scripts/ux-browser-acceptance.mjs`, Chrome via Playwright, AUTOMATED, not manual): B01-B05 (64 checks). It found two real defects that jsdom did not: the prototype search box lost focus after one character, and the page promised that editing a story resets all its marks (it resets only changed items). Both fixed.
- **Multi-repository E2E** (`ux-multirepo-e2e.mjs`): one work item, three git repositories (backend, web, mobile), real code, tests and commits per repository, an executed cross-repository contract check that catches a real mobile defect, return to Development, fix only in the mobile repository, independent re-verification, story confirmation through the dialog, task switching, return to BA after a requirement change, new-session restore (130 checks).
- **Tool compatibility** (`tool-compat-acceptance.mjs`): 52 alpha.48 tools unchanged (schemas backward compatible), 7 added = 59 (the request said 58), role-scoped servers, minimal-call envelopes.
- **Dustin's items:** full BA Desktop Chat ZIP now carries the CLI under `tools/` (top-level `bin/` is refused by the upload rules) and its skills point there (`full-zip-acceptance.mjs`); the seven canon skills verified in the installed Marketplace plugin and the full ZIP; light ZIP carries the new review skills; plugin READMEs now carry the Marketplace install line and no stale "Jira required" text; `claude plugin validate` passes on every packed plugin directory (acceptance script in each role repo; only the missing listing-icon warning remains); BA README rewritten with a skill table generated from the files and built archives (`skill-list.mjs --check`); website BA page and CLI page updated on local branch `docs/ux-overhaul` (hidden token prompt replaced by `stty -echo` + `read`, which works in zsh and bash; installing needs no Jira token), not deployed; license audit in `LICENSE-AUDIT.md` (no license chosen).
- **Quality round 3** (QUALITY-REPORT-3): N8 (a repository `.env` could still set BROWSER/NODE_OPTIONS/LD_PRELOAD/GIT_*) fixed by allowing only `PRAXIS_` keys, with a behavioural test; N9/N10 stale BA text fixed; test weaknesses T1/T2 fixed; matrix rows 3, 14, 19 backed by added checks.

## Final verification (local)
Core, Runtime, BA, Architect, Developer, Quality: `npm run verify` pass in the working trees AND in fresh clones with `npm ci` (clean checkout, no sibling-directory dependencies except the documented `PRAXIS_*_ROOT` variables for Architect and Developer). Marketplace `verify`, `claude plugin validate` on all six plugins, clean-clone install acceptance (10 checks): pass. Website `pnpm check`: pass. alpha.48 migration (S16, rt tests), approvals (reject, confirm, stale preview, no dialog: `approval-ux`, `user-approval-flow`, S14, M): pass.

## Not re-verified independently
The fixes made after Quality round 3 (N8, N9, N10, T1/T2 and the matrix additions) were verified by the implementer's tests only; a round 4 was not run.

## Still open (see QUALITY-REPORT-3)
D04 (guided is opt-in via the skills), D07 (any existing file passes), D19 (an agent can mark a contract agreed), D16 (labels), N2/N11 heuristics, review link visible in process arguments for the moment the opener runs.
