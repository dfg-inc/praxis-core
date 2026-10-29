# Original remarks -> implementation -> confirming test

Source: `original-remarks.txt` (21 lines; line 9 is a heading, line 10 praise). Tests: unit = `praxis-core/packages/contracts/src/*.test.ts`, rt = `praxis-runtime/packages/mcp/src/*.test.ts`, S01-S19 = `tools/scripts/ux-overhaul-acceptance.mjs` (protocol, scripted dialog and Save), B01-B05 = `tools/scripts/ux-browser-acceptance.mjs` (real Chrome, automated), M = `tools/scripts/ux-multirepo-e2e.mjs` (3 git repositories, all roles), T = `tools/scripts/tool-compat-acceptance.mjs`.

| # | Remark (short) | Implementation | Confirming tests | Verdict |
|---|---|---|---|---|
| 1 | Skills/instructions from analysed repos hijack the agent | `context-trust.ts` (precedence, skill plan, scanner, quoting); instruction files listed not returned (`frontend-discover.ts`, `repository-tools.ts`); `praxis_context_diagnose`; `PRAXIS_REVIEW_`/`PRAXIS_TEST_` unsettable from a repo `.env` | unit `context-trust.test.ts`; rt `planning-tools.test.ts` (D17, N1); S19 | PARTIAL: heuristic scanner; the host decides which skills load |
| 2 | Why JSON | `docs/workflow-stages.md` "Why the state is JSON": internal; humans read HTML | documentation only, no automated test | PASS (docs) |
| 3 | Where context/log live; new chat | `briefing.ts`, session notes, `next`, `resume`, `resume-work` skill, `praxis_session_start` | unit `briefing.test.ts`; rt `planning-tools.test.ts`; S12; M step 6 | PASS |
| 4 | User stories unusable, too much text | Story Plan first (`StoryPlan`, gates), stories inherit the line | unit `planning.test.ts`; S05; B04 | PASS for guided items; classic items (default for alpha.48 compatibility) do not enforce it |
| 5 | HTML tool invented ad hoc; JSON read by hand | `review-html.ts`, `review-submission.ts`, `review-service.ts` | unit `review-html.test.ts`; S03, S14; B01-B05 | PASS |
| 6 | No stories for viewing | `analyzeStoryCoverage` (view, search, filter, create, edit, delete, validation, error, permissions, states) gates `architecture` | unit `planning.test.ts`, `qa-fixes.test.ts`; S07 | PARTIAL: label-based, a mislabelled story passes (documented) |
| 7 | Cannot edit/remove stories, take REQ out of scope | `update-story`, `exclude/restore/split/merge`, scope cascade, history | unit `planning.test.ts`; S05, S06; B01, B05 | PASS |
| 8 | HTML+mock prototype before stories | `Prototype` state, viewer, API prototype, gates | unit `review-html.test.ts`; S04; B03 | PASS |
| 10 | (praise: input, search, clarification) | unchanged | existing alpha.48 suites | PASS |
| 11 | REQ viewed in HTML not JSON | requirements review page | S03; B01 | PASS |
| 12 | Each AC its own checkbox | per-criterion accept/reject/comment/edit/remove/add | unit `review-html.test.ts`; B01 | PASS |
| 13 | Prototype refined in session | `update-prototype`, feedback, revisions, persisted | S04; B03 | PASS |
| 14 | Prototype reads app code for styles | `praxis_frontend_discover` (CSS custom properties, Tailwind/MUI theme objects) | rt `planning-tools.test.ts`; S04; M step 1 (repositories) | PARTIAL: other styling systems missed |
| 15 | Plan: which part of the prototype and which REQ each story covers | `StoryPlanEntry` (`screenRefs`, `requirementIds`, `acIds`, repositories) | S05; B04 (ids resolved against state) | PASS |
| 16 | Story generation | `add-story` inherits from the plan line | unit `planning.test.ts`; S05; M | PASS |
| 17 | HTML review of stories, checkbox per item | stories review page | unit; B05 | PASS |
| 18 | What does Praxis add over Claude Code + skills | docs section | documentation only | PASS (docs) |
| 19 | Change requests | `change-request` skill, `record-impact`, kinds, prototype gate | unit `planning.test.ts`; S02 | PASS |
| 20 | Local vs Jira/Epic | `docs/jira-vs-local.md` (nothing syncs local work to Jira automatically) | documentation only | PASS (docs) |
| 21 | Many repositories, which story goes where | registry, inspect, assign, services, contracts, brief, order, gates | unit `briefing.test.ts`; S08; M (3 git repositories) | PASS |

Tool surface: 52 alpha.48 tools unchanged + 7 added = 59 (the request said 58; six were counted before `praxis_workflow_commands` was added). T proves the compatibility.
