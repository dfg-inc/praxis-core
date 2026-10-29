# Independent Quality verification: Praxis UX & workflow overhaul

You are Quality. You did not write this code. Do not trust the implementer's claims, reports or green tests as proof; verify.

## What was asked (owner's requirements, condensed)

Source remarks: `<praxis-split>/release/ux-overhaul/original-remarks.txt` (18 remarks from the owner's dogfooding, in Russian). The owner asked for an end-to-end flow:

Request -> Discovery -> Requirements -> HTML Review -> Prototype -> Story Plan -> User Stories Review -> Architecture -> Development -> Quality -> Delivery. Every stage must support viewing, point edits, confirm/reject, returning to an earlier stage, context preservation, continuation in a new session, and traceability.

Sections:
- **A** Deterministic Praxis skill loading by role/stage/task; explicit source and priority of instructions; separation of trusted workflow instructions from analysed repo content; protection against instructions embedded in analysed code/docs; diagnostics of active skills/context sources. (Praxis must NOT try to bypass Claude's system instructions.)
- **B** Persistence of requirements+AC, stories+revisions, decisions/assumptions, questions/risks/constraints, code-analysis results, prototypes and links, current stage and next action, handoff context, repository links. "Continue this task" in a new chat must find the current Work Item, load state, propose the next step, ask to choose when several candidates, and never promise full chat history.
- **C** Standard reproducible HTML requirements review: per-AC control, accept/reject/edit/comment, bulk accept, edit REQ by id, add/remove AC, exclude REQ from scope, deferred requirements, saved decisions/revisions, recompute dependents. JSON stays internal. Renderer + data contract + tests + reliable save-back to canonical state. HTML is not a source of truth.
- **D** Interactive HTML prototype with mock data before detailed stories: inspect the existing frontend, reuse real styles/tokens, multi-screen navigation, view/edit data, loading/empty/error/success/denied states, iterative refinement via dialogue, persisted across sessions, elements linked to REQ/AC; backend-only work gets a technical/API-contract prototype with request/response examples and no fake UI; no real external requests or production data.
- **E** Short Story Plan before detailed stories (ID, title, what is implemented, what the user gets, data, prototype parts, REQ/AC, repos/services, dependencies). No dozens of detailed stories before the plan is agreed.
- **F** Full story management: create, edit by ID, change individual AC, add/exclude/restore, split/merge, scope changes, revisions/history, dependency recompute, invalidate stale confirmations and Quality evidence, HTML Story Review with per-item checkboxes, better decomposition, automatic coverage check so view/search/permissions/UI states are not missing.
- **G** Change requests (new feature in existing app, change, extension, fix, multi-service technical change): investigate the existing implementation, impact analysis, regression tests; never assume an empty project.
- **H** One Work Item across any number of repositories: explicit registration, REQ/Story <-> repo links, ownership, implementation units per service, cross-service contracts, dependencies/order, context handoff to Developer/Quality per repository, per-service and whole-feature verification, no fake completion marks for repositories never entered. Do not confuse several Work Items in one repository with one Work Item across repositories.
- **I** Local-first, explain local vs Jira (mapping, sync, external writes, re-sync, conflicts/errors). Jira is not mandatory. External writes only via the existing protected preview/apply with user approval.
- **J** Real mechanisms and tests for durable state, structured requirements, coverage control, artifact versioning, traceability, inter-role handoffs, multi-repo coordination, verifiable Quality results, controlled stage transitions.

Constraints that must hold: extend existing Core/Runtime/workflow contracts (no parallel state system); compatibility with working alpha.48; stable REQ/Story/Work Item ids; current approval and security model unchanged; ONE Praxis Runtime MCP server; Marketplace installability; local mode without external services; roles BA/Architect/Developer/Quality; several independent tasks; no Approval Broker, native privileged services, system accounts or separate approval services.

## Where the work is (local branches `feature/ux-overhaul`, nothing published)

| Repo | Path | What changed |
| --- | --- | --- |
| Core | `<praxis-split>/praxis-core` | contracts: `packages/contracts/src/{planning-schemas,planning,review-html,review-submission,context-trust,briefing,ids,errors}.ts`, changes in `workflow.ts`, `story.ts`; docs `docs/workflow-stages.md`, `docs/jira-vs-local.md` |
| Runtime | `<praxis-split>/praxis-runtime` | `packages/mcp/src/{review-service,frontend-discover,repository-tools,context-tool,session-start,workflow-store,tools,catalog}.ts`; tests `planning-tools.test.ts`; `tools/scripts/ux-overhaul-acceptance.mjs` |
| BA / Architect / Developer / Quality | `<praxis-split>/praxis-{ba,architect,developer,quality}` | new BA skills `requirements-review, prototype, story-plan, stories-review, change-request, resume-work`; updated local-workflow / present-plan / session-start |
| Marketplace | `<praxis-split>/praxis-marketplace` | restaged plugins |

Use `git log master..HEAD` (marketplace: `github/master..HEAD`) in each repo to see the commits. Example pages: `<praxis-split>/release/ux-overhaul/examples/*.html`.

## Rules for you

- READ-ONLY on the six repositories and the marketplace: do not edit, commit, install, or change branches there. Run builds/tests only if they do not modify tracked files; copy a repository to a temp directory first if you need to build (use `cp -R` or `git worktree add` into a temp directory).
- Do NOT publish anything, push, tag, merge, deploy, write to Jira or any real external system, or touch `~/.claude` or the user's Claude config. Work in temp directories.
- Do not claim Claude Desktop/Claude UI behaviour: you can only exercise code, scripts, the MCP protocol and a browser on local files. State what you could not verify.
- You may run: unit tests (`npx vitest run` in `praxis-core/packages/contracts`, `praxis-runtime/packages/mcp`), the acceptance script `node tools/scripts/ux-overhaul-acceptance.mjs` in a temp copy of the Runtime, and your own scripts against the Runtime's built tools (`packages/mcp/dist/tools.js` `callTool`) in temp project directories.

## What to deliver

For every one of the 18 remarks AND for sections A-J: a verdict PASS / FAIL / PARTIAL with the evidence you collected yourself (command, observed output). A partial result is not a PASS. Then:

1. Happy paths of the whole flow.
2. Negatives and permissions: try hard to make an agent-side call record the user's acceptance, to forge `via`, to replay or tamper with the review page token/host/origin, to use stale pages, to inject instructions through repository files (CLAUDE.md, AGENTS.md, SKILL.md, README, code comments) and see whether anything leaks into state or tool results, to path-traverse through `file`/`path` arguments, to corrupt state with odd inputs (huge, unicode, HTML in statements, ids with `../`).
3. Data integrity and idempotency: repeated saves, concurrent saves from two pages, killed writes, migration from 1.0.0 (read, first write, backup), secret-redaction round trips of every new field (look for field names matching /token|secret|password|authorization|api[_-]?key|private[_-]?key/ in persisted state).
4. Context resilience: new session, several work items, selection.
5. Cross-repository dependencies, ordering, and "never entered = never done".
6. Regressions against alpha.48 behaviour (existing tests, existing acceptance scripts you can run safely, tool behaviour for old work items).
7. Whether the operations actually work, not just whether text says they do: for example, do the new skills reference tools and commands that exist and behave as the skill says? Check each skill file in `praxis-ba/plugins/ba/skills/{requirements-review,prototype,story-plan,stories-review,change-request,resume-work}` and the added sections of the other roles' `local-workflow` against the real tool catalog and command schemas.
8. Honesty of the docs (`praxis-core/docs/workflow-stages.md`, `jira-vs-local.md`): list any sentence that is not true of the implementation.

Report defects as: id, severity (blocker/major/minor), what you did, expected, observed, file/line if you know it, and a minimal reproduction. Return findings only; do not fix.
