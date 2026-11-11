# Approvals in Claude Desktop

Praxis asks you before it commits, pushes, writes to Jira, writes `.project`, or records a decision that only you may make (confirming a Story, an architecture decision, a review). It asks in **the client's own approval dialog**, and nowhere else.

**Claude Desktop cannot show that dialog** (Chat and Cowork do not offer one; the Code tab answers it by itself without showing it). So in Claude Desktop:

- everything that reads, previews, plans or reviews works as before: requirements, prototypes, story plans, stories, reviews in the browser, architecture, implementation records, Quality checks, Git and Jira previews;
- protected actions are **not executed**. Claude shows you the exact preview and says that it was not applied. Nothing runs, and nobody is said to have rejected it;
- you apply them from the **Claude Code CLI** in a terminal, in the same repository: the CLI shows the dialog, and your answer there is what Praxis takes.

Earlier versions offered an approval page in your browser and an opt-in *Approval mode* for Desktop. Both are removed in 0.1.0-alpha.49.2: anything an agent with a shell on your account can operate or write (a page served on your computer, a setting, a file in your home folder) cannot stand in for your approval. The [threat model](approval-threat-model.md) explains why.

## A typical Desktop session

1. In Desktop, Claude does the work: it writes requirements, opens the review page, builds the prototype, plans and writes stories, previews a commit.
2. When you review in the browser, press **Send for approval**. The page records nothing: it hands your decisions to Claude. In Desktop, Claude then says they could not be recorded here (`APPROVAL_CLIENT_UI_REQUIRED`).
3. Open a terminal in the repository and start `claude`. Ask it to apply the pending review, or to apply the previewed commit. The CLI shows the dialog with exactly what will be recorded or run; approve it there.

Work items, previews and handed-over files are stored in the repository and in your Praxis state, so the CLI picks up where Desktop stopped (`praxis-ba:resume-work`). A review handed over in Desktop's page lives only as long as that Runtime process: if the CLI does not find it, render the review again in the CLI and send it from there.

## Install or update

| Where you use Praxis | What to install |
| --- | --- |
| Desktop **Chat** | The *Praxis Runtime* extension (`praxis-runtime.mcpb` from the release): Settings → Extensions → Install Extension. |
| Desktop **Code** tab, **Cowork**, Claude Code CLI | The marketplace plugins: Customize → Plugins → Add marketplace → `dfg-inc/praxis-marketplace` → Praxis. After an update, update `praxis-runtime` and each role plugin as well (`claude plugin update praxis-runtime@praxis`, and the same for `praxis-ba`, `praxis-architect`, `praxis-developer` and `praxis-quality`). Updating the `praxis` plugin alone does not update them. |

Check what you have: ask Claude to run `praxis_doctor`. In its `approval` section:
- `mode` is `no-dialog` in Desktop and `client-ui` in the CLI;
- `trust` says how protected actions can be approved here, and that independently authenticated human approval is not available;
- `observedDialog` appears once Praxis has seen a client answer its own dialog;
- `dialogAutomation` lists any setting that answers the dialog automatically (then nothing protected runs, even in the CLI);
- `ignoredEnvironment` lists retired or test settings found and ignored.

## Settings

There are no approval settings any more. The Desktop extension's *Approval mode*, *Approval page in your browser* and *Browser for approval pages* settings, `~/.praxis/approval-settings.json`, and the `PRAXIS_APPROVAL_MODE`, `PRAXIS_APPROVAL_PAGE` and `PRAXIS_APPROVAL_BROWSER` variables are all ignored. Only a longer minimum answer time (`PRAXIS_APPROVAL_MIN_ANSWER_MS` above 1000) is taken, because it can only make approval stricter.

## What Claude tells you, and what it means

| Claude reports | Meaning |
| --- | --- |
| it ran, approved in the client's dialog | the CLI's dialog was answered Approve (Praxis records which channel answered, not who) |
| `APPROVAL_REJECTED` | Reject was chosen in the dialog |
| `APPROVAL_DISMISSED` | the dialog was closed without deciding: not a rejection |
| `APPROVAL_EXPIRED` / `APPROVAL_TIMED_OUT` | nobody decided in time: not a rejection |
| `APPROVAL_CLIENT_UI_REQUIRED` | Praxis could not ask you here: no dialog (Desktop), the client answered it by itself (the Code tab), or a setting answers it automatically. Nothing ran, and you did not reject anything. |
| `APPROVAL_WITHDRAWN` | Claude withdrew the request itself: not your decision |

## Why the Code tab does not use its dialog

The Code tab declares that it can show approval dialogs. When Praxis asks, it answers "decline" by itself about 10 to 40 milliseconds later and shows nothing ([anthropics/claude-code#89858](https://github.com/anthropics/claude-code/issues/89858)). Earlier Praxis versions recorded that as *your* rejection. Praxis now records it as the client's own answer, runs nothing, and, once it has seen this twice from the same client version, stops asking that client. When a new Claude Code version arrives, Praxis tries its dialog once more.

## A dialog that is answered automatically

Claude Code can answer an MCP dialog by itself through an `Elicitation` hook, including one in a repository's own `.claude/settings.json`. Praxis does not take such an answer. Before it asks, and again after the answer, it checks the repository and the folders above it, your user settings, installed plugins, managed settings, agent, skill and command definitions, and the flags the client was started with; anything it cannot fully check refuses. A repository whose own Claude Code settings hold anything but plain preferences (any hook, any `env` entry, a status line, plugins) is refused too: a project does not configure its own approval. `praxis_doctor` names the file. This is best effort (see the threat model, R5 and R6): trust only repositories you have checked when Claude Code asks.

Claude Desktop starts its Code tab with settings on the command line, so the Code tab is refused before its dialog is even tried.

## Correcting earlier records

Older Praxis versions wrote two kinds of entries into your decision journal (`~/.praxis/decisions/`) that blame you for something you did not do:
- the Code tab's own decline, recorded as your rejection;
- the agent's `confirmation=NO`, recorded as "the user declined (reported by the agent)".

Ask Claude to run `praxis_approval_journal` for the repository. It lists those entries with the evidence. To correct them, run it with `amend=true` from the CLI, and approve the list in the CLI's dialog. Praxis then appends one correction per entry. It never changes or deletes an existing line.

## Compatibility (0.1.0-alpha.49.2)

| Client | Protected actions | Reviews, previews, read-only tools |
| --- | --- | --- |
| Claude Desktop 4.4212.0, Code tab (embedded Claude Code 2.1.309) | not executed: the dialog answers itself (`auto-answered`) | work |
| Claude Desktop, Chat | not executed: no dialog (`unavailable`) | work |
| Claude Desktop, Cowork | not executed: no dialog | work (the review page opens only when the Runtime runs on your computer, not inside the Cowork sandbox) |
| Claude Code CLI 2.1.314 | approved in its dialog | work |
| Claude Code CLI with an `Elicitation` hook configured | not executed (`unavailable`, the hook is named) | work |
