# Architecture and data flow

## Principle

Nothing new owns state. The workflow state (`praxis.workflow.state`, now contract 1.1.0) is extended in place; every new capability is a command of the existing reducer (`applyWorkflowCommand`), persisted by the existing store, exposed through the existing Runtime tools. HTML pages, prototypes and briefings are *views* of that state.

```
                       user                                   agent (Claude + role skills)
                        |                                          |
        review page (HTML, 127.0.0.1)                  MCP tools (ONE Praxis Runtime server)
        Save = the user's own decision                  praxis_workflow_preview / apply
                        |                               praxis_review_render / apply
                        v                               praxis_frontend_discover, repository_inspect / brief
            review-service (Runtime)  -----------------  praxis_context_diagnose, session_start, workflow_status
                        |                                          |
      submissionToCommands (Core)                                  |
                        |            applyWorkflowCommand(state, command, {channel})           
                        +---------------------------+--------------+
                                                    v
                                     Core reducer (packages/contracts)
                          planning.ts: scope, review marks, prototype, story plan,
                          story editing, repositories, contracts, impact, gates, coverage,
                          next step, migration 1.0.0 -> 1.1.0
                                                    |
                                       workflow store (Runtime)
                          .praxis/workflow/index.json, items/<WI>.json (+ .v1.0.0.bak)
                          .praxis/workflow/reviews/<WI>/<view>.html  (offline copies)
```

## Who may write what

| Writer | May | May not |
| --- | --- | --- |
| Agent via `praxis_workflow_apply` | requirements, criteria, prototype, plan, stories, decisions, repositories, contracts, impact, handoffs, implementation, verdicts, session notes, phase moves (gated) | accept/mark/agree anything (`USER_DECISION_REQUIRED`); write a repository inspection (`record-repository-inspection` is refused) |
| The user in the review page (link token, per-load save token, Host and Origin checked; the link never goes through the agent) | criterion and item marks (the review is accepted when every criterion is marked accepted), edits, scope, plan lines, prototype comments and acceptance, bulk accept, waivers | |
| The user approving a handed-over decisions file in the client's dialog | the same decisions, bound to the exact commands approved | anything when the client has no dialog; Trusted Client and host-permission modes do not apply |
| Runtime itself | repository inspections (head commit, manifests, frontend, instruction files), session notes on saves | |

The recorded `via` of a decision is not read from the command: Core replaces it with what the Runtime verified (`html-review` or `approved`).

## Stages and gates

`request, discovery, requirements, requirements_review, prototype, story_plan, stories_review, architecture, development, quality, delivery`.

`phaseGates(state, to)` evaluates conditions (accepted and unchanged requirements, accepted prototype or a waiver, agreed plan, detailed stories, coverage, services with repositories, implementation records, a feature verdict). `advance-phase` enforces them in `guided` mode and records the stage only in `classic` mode (all pre-1.1.0 work items). `return-to-phase` needs a reason, invalidates later acceptances, keeps all content.

Acceptance is bound to a content fingerprint (`requirementsFingerprint`, `prototypeFingerprint`, `storyPlanFingerprint`, `storiesFingerprint`): changing the artifact makes the acceptance `stale`, so an old approval never covers new content.

## Review page round trip

1. `praxis_review_render {view}` builds the page from state, writes the offline copy, starts (or reuses) a loopback server and opens the page in the user's browser with a link token (valid 10 minutes). The agent's result carries only the tokenless address; every page load gets its own save token, and a save also needs the page's Origin.
2. The page embeds its data as JSON and a small script. It builds a `praxis.review.submission`: per item, the revision the user looked at, plus the user's decision.
3. `submissionToCommands(state, submission)` turns that into commands. An item whose revision moved since the page was rendered becomes a *conflict* and is skipped; the rest is applied. "Accept all" and plan or story acceptance are skipped when the artifact changed after rendering.
4. The server applies each command under the workflow lock with `channel: {via: "html-review"}`. The reply lists `applied`, `conflicts`, the new progress and the next step; a session note is appended.
5. If the page cannot reach the server (it ended, or the page was opened from the file), the user copies or downloads the decisions. `praxis_review_apply` recomputes the commands, shows the user exactly those decisions in the client's dialog, and records them with `channel: {via: "approved", approval, batch}`; Core verifies the approval against the canonical text of the batch and that each command is a member.

## Prototype

`Prototype` is part of the state: `ui` (screens, elements, mock collections, roles, states, navigation, links to REQ/AC, styles read from the application) or `api` (endpoints with request and response examples). It has revisions and history, feedback with resolution, and an acceptance bound to its fingerprint. The viewer in the review page runs entirely in the browser on a copy of the mock data (add/delete rows, search, state and role switches); it performs no network requests (the page's CSP allows only the loopback save address).

## Story plan, stories, coverage

`StoryPlan` lines are the short list the owner writes by hand. `add-story` in guided mode needs an agreed plan and a plan line; the detailed story inherits the line's title, capabilities, screens, repositories and services. `update-story`, `exclude-story`, `restore-story`, `split-story`, `merge-stories` keep `storyHistory` snapshots and make dependent confirmations and Quality evidence stale. `analyzeStoryCoverage` compares the capabilities implied by requirements, criteria, prototype elements and screen states (view, search, filter, create, edit, delete, validation, error, permissions, states) with those the stories cover; gaps block `architecture` unless waived with a reason.

## Repositories

`Repository` records (id, role, local path / remote) are registered explicitly. `assign-repositories` links requirements, stories and services; `set-service` carries `repositoryId` and `dependsOn`; `ServiceContract` records provider, consumers and schema reference; `Impact` records existing behaviour, affected areas and regression checks for changes. `implementationOrder`, `buildRepositoryBrief` and `repositoryProgress` (Core, pure) feed `praxis_repository_brief`. A repository counts as *entered* only when a current implementation record exists for one of its services.

## Context and trust

`INSTRUCTION_PRECEDENCE` (host system instructions, user, Praxis skills, Praxis Runtime results, project config, analysed content as data) and `skillPlan(phase)` are code, not prose. `scanUntrustedInstructions`, `quoteUntrusted` and `isAgentInstructionFile` classify text from analysed repositories; the Runtime lists instruction files and never returns their contents. `praxis_context_diagnose` reports all of it. `buildResumeBriefing` and the `next` step are rebuilt from the state for a new chat; `notRestored` states that the earlier messages are not restored.

## Compatibility

Contract 1.1.0 accepts 1.0.0 states (`SUPPORTED_WORKFLOW_VERSIONS`); `migrateWorkflowState` fills defaults (mode `classic`, scope `in`, criteria marks pending/accepted from earlier approval) on read; the store keeps the original file as `<id>.json.v1.0.0.bak` on the first write. All 52 alpha.48 tools keep their names and behaviour; seven tools are added (59): `praxis_workflow_commands`, `praxis_review_render`, `praxis_review_apply`, `praxis_frontend_discover`, `praxis_repository_inspect`, `praxis_repository_brief`, `praxis_context_diagnose`.

## Persisted-field naming

The store redacts any key matching `token|secret|password|authorization|api[_-]?key|private[_-]?key` before writing. New fields avoid those substrings (`styles`, `hasStyles`); `persistence.test.ts` round-trips every planning artifact through the redaction.
