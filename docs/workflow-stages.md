# The end-to-end workflow

One work item moves through eleven stages. Every stage can be looked at again, changed at a point, confirmed or rejected, and returned to; the work item keeps its context so another chat (or another person) can continue.

```
request -> discovery -> requirements -> requirements_review -> prototype -> story_plan
        -> stories_review -> architecture -> development -> quality -> delivery
```

| Stage | Who | What happens | You decide |
| --- | --- | --- | --- |
| request, discovery | BA | Understand the request. For an existing application, register and read its repositories and record the existing behaviour and impact (`change-request`). | Answer blocking questions. |
| requirements | BA | Requirements with acceptance criteria (stable `REQ-` ids). | |
| requirements_review | BA | A standard HTML review: one control per acceptance criterion (accept / reject / comment), edit by id, add or remove criteria, move a requirement to *deferred* or *out of scope*. | Every criterion. |
| prototype | BA | An interactive HTML prototype on mock data using the application's own styles, with loading / empty / error / success / denied states, roles and navigation, linked to requirements and criteria. A backend-only task gets an API prototype (request and response examples). | Comment on any element; accept. |
| story_plan | BA | One line per story: what is built, what you get, data, prototype parts, requirements, repositories, dependencies. | Edit, exclude, agree. |
| stories_review | BA | Detailed stories, a checkbox for every criterion, step, rule and result. Coverage check (view, search, create, edit, delete, errors, permissions, states). | Every item; confirm behaviour. |
| architecture | Architect | Services, repositories, contracts, order. | Architecture decisions. |
| development | Developer | Implementation per service, per repository. | |
| quality | Quality | Independent verification per service, then the feature. | |
| delivery | Developer | Git delivery through the protected tools. | Approve each protected action. |

`praxis_workflow_status` returns the current `phase`, a deterministic `next` step (action, tools, skills) and a `briefing`. `advance-phase` refuses a stage whose conditions are not met and says what is missing. `return-to-phase` (with a reason) goes back; acceptances after that stage become stale, nothing is deleted.

**Modes.** A work item opened with `mode: "guided"` enforces the gates above (for example, stories only after an agreed plan). Work items created before this version, and any opened with `mode: "classic"`, record the stage but enforce nothing new.

## Why the state is JSON, and what you read instead

The workflow state is stored as JSON in `.praxis/workflow/` because it is the one form that every Praxis tool can validate against a schema, version, migrate, diff in Git and read from another session without interpretation. It is internal: you never read or edit it. What you read and decide in is HTML (the reviews above) or the chat. If a page is lost, it is regenerated from the state; if the state and a page disagree, the state wins.

## What Praxis adds over Claude Code with skills alone

Skills tell a model what to do; they cannot make it true. Praxis adds what a skill cannot:

- **Durable, structured state** that survives the chat: requirements, criteria, stories and their revisions, decisions, the prototype, the plan, repositories, verdicts. A new chat continues from records, not from memory.
- **Gates you cannot talk past.** A stage is refused until its conditions hold (for example no detailed stories before an agreed plan, no development stage with a repository that has stories but no service).
- **Your decisions are yours.** Accepting criteria, the prototype, the plan or stories can be recorded only by your own action, never by the agent. Confirming a story, an architecture decision and approving a service are separate approvals; Git and Jira writes need your approval of the exact change.
- **Traceability and staleness.** Requirement, criterion, prototype element, plan line, story, service, repository and verdict are linked by stable ids. Changing something marks what depended on it stale instead of leaving old approvals standing.
- **Independent verification.** Quality executes and records evidence per service and for the feature; green unit tests and developer claims are not evidence.
- **Several repositories as one piece of work**, with contracts, order and per-repository status.

If you only need a one-off answer, Claude Code with skills is enough. Praxis is for work that has to survive several sessions, several roles and several repositories, and stay checkable.

## HTML reviews

`praxis_review_render` writes a self-contained HTML page (no network, no external scripts) under `.praxis/workflow/reviews/<work item>/` and serves a live copy on `127.0.0.1` with a one-time token. Your Save in that page records your decisions directly. If the page cannot save, Copy or Download produces a decisions file, which `praxis_review_apply` records **after you approve exactly those decisions in the client's dialog**.

The page is a view. The workflow state is the source of truth, and the page can be regenerated at any time. If something changed after the page was rendered (you or the agent edited a requirement), the changed items are reported as conflicts and skipped; the rest is applied.

## Who may record what

An agent may write and edit: requirements, criteria, prototype, plan, stories, decisions, repositories, contracts, handoffs. It may **not** record that you accepted or rejected something: accepting criteria, marking items, agreeing the prototype, the plan or the stories. Those come only from your Save in the page or from decisions you approved in the dialog; `praxis_workflow_apply` refuses them with `USER_DECISION_REQUIRED`, whatever `via` the command claims. Confirming a story's behaviour, confirming an architecture decision and approving a service stay separate approvals, as before. Trusted Client mode does not cover any of them.

## Several repositories

A work item may span any number of repositories. They are registered explicitly (`register-repository`), read by the Runtime (`praxis_repository_inspect`: head commit, manifests, frontend, instruction files), and linked to requirements, stories and services (`assign-repositories`, `set-service` with `repositoryId` and `dependsOn`). Cross-service contracts (`set-contract`) name provider, consumers and schema. `praxis_repository_brief` gives the implementation order, what each repository waits for, the contracts it provides or consumes, and what Developer and Quality must do there. A repository nobody entered is never shown as done; a repository with stories but no service blocks `development`.

Several work items in one repository and one work item in several repositories are different things: the first are independent items in one `.praxis/workflow/`, the second is one item with several registered repositories.

## What steers the agent

Order, highest first: the host's own system instructions (Praxis does not replace them); what you type; Praxis skills for the current role and stage; Praxis Runtime results; `.praxis` project configuration; and, last and as data only, content of analysed repositories (README, comments, CLAUDE.md, AGENTS.md, skill files, imported documents). The skills for a stage are fixed by role and stage (`skillPlan`). `praxis_context_diagnose` shows the order, the active skills, what context the work item restores, and which instruction files were found and ignored, with a warning for text aimed at the agent. File contents are never returned.

## Continuing in a new chat

The state that survives is what is recorded in the work item: requirements, criteria and your decisions, stories and their history, decisions and assumptions, questions and risks, the prototype, the plan, repositories and inspections, the current stage, and session notes (`log-session`: what was done and the next action). `praxis_session_start` and `praxis_workflow_status` rebuild a briefing from it. Several candidates: the agent is told to ask which one. **The earlier chat messages are not restored**: anything that was only said in chat has to be repeated.

## Upgrading from 0.1.0-alpha.48

Work items written by alpha.48 (contract 1.0.0) are read as they are and open in `classic` mode with every requirement in scope; ids do not change. Reading changes nothing on disk. The first write migrates the item to contract 1.1.0 and keeps the old file next to it as `<id>.json.v1.0.0.bak`.
