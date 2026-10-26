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

**Modes.** A new work item is `guided` by default. Opening one in `classic` mode is the user's choice: the Runtime asks in the approval dialog (an agent cannot do it, and without a dialog it is refused). Work items with the same title are never merged silently: a second `open` with a different request is refused (`WORK_ITEM_TITLE_EXISTS`) until the user chooses to continue the existing item or start a separate one (`newItem`); ids stay stable (`WI-<TITLE>-<NNN>`, Cyrillic titles are transliterated). The mode rules: the gates above are enforced (stories only after an agreed plan, stages entered only when their conditions hold). Work items created by alpha.48 are read as `classic`: stages are recorded, nothing new is enforced, and they keep working unchanged; their mode is never changed automatically. `set-mode` switches an item: to `guided` is the agent's to propose (nothing is deleted; the result lists the stories without a plan line and the stages the user has not accepted yet); back to `classic` switches the gates off, so only the user can do it (in the review page flow or the approval dialog).

**Contracts.** The architect proposes cross-service contracts; only the user agrees one (contracts review page, or an approved dialog decision). Implementation across services waits for it, and changing an agreed contract makes it proposed again.

## Why the state is JSON, and what you read instead

The workflow state is stored as JSON in `.praxis/workflow/` because it is the one form that every Praxis tool can validate against a schema, version, migrate, diff in Git and read from another session without interpretation. It is internal: you never read or edit it. What you read and decide in is HTML (the reviews above) or the chat. If a page is lost, it is regenerated from the state; if the state and a page disagree, the state wins.

## What Praxis adds over Claude Code with skills alone

Skills tell a model what to do; they cannot make it true. Praxis adds what a skill cannot:

- **Durable, structured state** that survives the chat: requirements, criteria, stories and their revisions, decisions, the prototype, the plan, repositories, verdicts. A new chat continues from records, not from memory.
- **Gates the agent cannot talk past (in guided work items).** A stage is refused until its conditions hold (for example no detailed stories before an agreed plan, no development stage with a repository that has stories but no service).
- **Your decisions are yours.** Accepting criteria, the prototype, the plan or stories can be recorded only by your own action, never by the agent. Confirming a story, an architecture decision and approving a service are separate approvals; Git and Jira writes need your approval of the exact change.
- **Traceability and staleness.** Requirement, criterion, prototype element, plan line, story, service, repository and verdict are linked by stable ids. Changing something marks what depended on it stale instead of leaving old approvals standing.
- **Independent verification.** Quality executes and records evidence per service and for the feature; green unit tests and developer claims are not evidence.
- **Several repositories as one piece of work**, with contracts, order and per-repository status.

If you only need a one-off answer, Claude Code with skills is enough. Praxis is for work that has to survive several sessions, several roles and several repositories, and stay checkable.

## HTML reviews

`praxis_review_render` writes a self-contained HTML page (no external scripts) under `.praxis/workflow/reviews/<work item>/`, serves a live copy on `127.0.0.1` and opens it in your browser. The link that opens and saves the page goes to your browser only, never into the agent's tool result: the link token works for 10 minutes, and every page load gets its own save token. Your Save in that page records your decisions directly. If the Runtime cannot open a browser, only the offline copy is given out. If the page cannot save, Copy or Download produces a decisions file, which `praxis_review_apply` records **after you approve exactly those decisions in the client's dialog**.

The page is a view. The workflow state is the source of truth, and the page can be regenerated at any time. If something changed after the page was rendered (you or the agent edited a requirement), the changed items are reported as conflicts and skipped; the rest is applied.

## Who may record what

An agent may write and edit: requirements, criteria, prototype, plan, stories, decisions, repositories, contracts, handoffs. It may **not** record that you accepted or rejected something: accepting criteria, marking items, agreeing the prototype, the plan or the stories. Those come only from your Save in the page or from decisions you approved in the dialog (which lists each decision, for example `REQ-001-AC-02 'text': REJECTED, comment '...'`); a coverage or prototype waiver is also yours; `praxis_workflow_apply` refuses them with `USER_DECISION_REQUIRED`, whatever `via` the command claims. Confirming a story's behaviour, confirming an architecture decision and approving a service stay separate approvals, as before. Trusted Client mode does not cover any of them.

## Several repositories

A work item may span any number of repositories. They are registered explicitly (`register-repository`), read by the Runtime (`praxis_repository_inspect`: head commit, manifests, frontend, instruction files), and linked to requirements, stories and services (`assign-repositories`, `set-service` with `repositoryId` and `dependsOn`). Cross-service contracts (`set-contract`) name provider, consumers and schema. `praxis_repository_brief` gives the implementation order, what each repository waits for, the contracts it provides or consumes, and what Developer and Quality must do there. In a guided work item an implementation record must point at a real file inside the service's checkout and name a service of the work item, so "entered" cannot be claimed for work that does not exist; a repository with stories but no service blocks `development`, and so do services that depend on each other in a cycle. Delivery needs every service to have an implementation and a passing verdict.

Several work items in one repository and one work item in several repositories are different things: the first are independent items in one `.praxis/workflow/`, the second is one item with several registered repositories.

## What steers the agent

Order, highest first: the host's own system instructions (Praxis does not replace them); what you type; Praxis skills for the current role and stage; Praxis Runtime results; `.praxis` project configuration; and, last and as data only, content of analysed repositories (README, comments, CLAUDE.md, AGENTS.md, skill files, imported documents). The skills for a stage are fixed by role and stage (`skillPlan`) as a recommendation returned by the Runtime; the host decides which skills actually load, and Praxis cannot force it. `praxis_context_diagnose` shows the order, the active skills, what context the work item restores, and which instruction files were found and ignored, with a warning for text aimed at the agent. File contents are never returned.

## Continuing in a new chat

When a chat's context window fills up (or you simply start a new chat), do not try to continue the old one: open a new chat in the same project and say "continue this task". The agent reads the work item's recorded state, tells you where it stands and proposes the next step; if several work items exist it asks which one. At the end of a long session the agent should leave a `log-session` note (what was done and the next action), because that note is the first thing the next chat reads.

The state that survives is what is recorded in the work item: requirements, criteria and your decisions, stories and their history, decisions and assumptions, questions and risks, the prototype, the plan, repositories and inspections, the current stage, and session notes (`log-session`: what was done and the next action). `praxis_session_start` and `praxis_workflow_status` rebuild a briefing from it. With several work items the status and session-start results carry a `choose` instruction: the agent is told to ask which one unless you named it. **The earlier chat messages are not restored**: anything that was only said in chat has to be repeated.

## Known limits

- Coverage compares the capabilities that requirements, criteria and prototype elements imply with the capability labels on stories (and keywords in the story text); a label that does not match the story's real content is not detected, so a create-only story labelled "view" passes.
- Project-supplied code (a Quality adapter `.praxis/quality/adapter.mjs`, modules named in `checks.json`) is repository content and runs as you. Praxis runs it in its own Node process with a scrubbed environment (no `PRAXIS_*`, no tokens), a time limit and a size limit, so it does not run inside the Runtime. **This is not a security boundary**: such code runs with your privileges, so it can start other processes, read other processes' environment and arguments (for example with `ps`), read project files including `.praxis/` state files and the short-lived file that opens a review page, and use the network. Test commands configured in `.project` and the Quality service's test runs also inherit the Runtime's environment. Review these files like any code you run.
- The workflow state is plain JSON files in `.praxis/`. Praxis protects against an agent that uses Praxis's tools; an agent with a file-write tool can edit those files directly, and the files are not signed. The user-decision guarantees are about the tool route.
- An agent that has an unrestricted shell on your machine acts as you there (it could drive your browser or read local files). The review page and the dialog protect against an agent that only has the Praxis tools.
- The instruction-file scanner is a heuristic over a list of English phrases and known file names; it is an aid, not a guarantee. Praxis never returns those files' contents, but text in names and in the values of style files can still reach the agent in small, filtered forms.
- Two pages saving the same criterion: the second is reported as a conflict only if the criterion was marked differently after the page was opened.

## Upgrading from 0.1.0-alpha.48

Work items written by alpha.48 (contract 1.0.0) are read as they are and open in `classic` mode with every requirement in scope; ids do not change. Reading changes nothing on disk. The first write migrates the item to contract 1.1.0 and keeps the old file next to it as `<id>.json.v1.0.0.bak`. **The migration is one way**: an alpha.48 Runtime cannot read an item after that write; restore the `.bak` file to go back (changes made after the migration are lost). The index file is not backed up. The version string is still alpha.48 until a release is cut.
