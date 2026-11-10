# Approvals in Claude Desktop

Praxis asks you before it commits, pushes, writes to Jira, writes `.project`, or records a decision that only you may make (confirming a Story, an architecture decision, a review). In the Claude Code CLI it asks in the CLI's own approval dialog. Claude Desktop cannot show that dialog, so Praxis opens its own **approval page** in your browser. Nothing has to change in how you work with Claude, and you do not have to move to the CLI.

## What you see

1. You ask Claude for something that changes a repository or Jira. Claude shows you a preview first.
2. Claude applies it. Desktop may ask whether Claude may use the Praxis tool: that prompt is Desktop's, not an approval of the action.
3. A browser tab titled **Praxis approval** opens. It shows exactly what will run (the same text a dialog would show), the repository, and a digest of that text.
4. Read it and choose **Approve and run exactly this** or **Reject**. You may add a reason.
5. Claude continues. If you decided within about 45 seconds, the action has already run (or was stopped). Otherwise Claude says the approval is pending. Decide in the tab, then tell Claude you did, and it applies again.

Nothing runs until you approve in that tab. Claude never receives the page's link, so it cannot open or click it through Praxis. If the plan changes after you approved, for example because the files changed, Praxis asks again for the new plan.

If the tab did not open, the time ran out (10 minutes), or you closed it: ask Claude to apply the action again, and a new page opens. A link copied out of the address bar does not open anywhere else.

## Install or update

| Where you use Praxis | What to install |
| --- | --- |
| Desktop **Chat** | The *Praxis Runtime* extension (`praxis-runtime.mcpb` from the release): Settings → Extensions → Install Extension. |
| Desktop **Code** tab, **Cowork**, Claude Code CLI | The marketplace plugins: Customize → Plugins → Add marketplace → `dfg-inc/praxis-marketplace` → Praxis. After an update, update `praxis-runtime` and each role plugin as well (`claude plugin update praxis-runtime@praxis`, and the same for `praxis-ba`, `praxis-architect`, `praxis-developer` and `praxis-quality`). Updating the `praxis` plugin alone does not update them. |

Check what you have: ask Claude to run `praxis_doctor`. In its `approval` section:
- `mode` is `approval-page` in Desktop and `client-ui` in the CLI;
- `client` is what your client declared;
- `observedDialog` appears once Praxis has seen a client answer its own dialog;
- `page` shows your page settings.

## Settings

| Setting (Chat extension) | Code tab, Cowork, CLI: `~/.praxis/approval-settings.json` | Default | What it does |
| --- | --- | --- | --- |
| Approval page in your browser | `"page": false` (or `PRAXIS_APPROVAL_PAGE=off`) | on | Off: without a working client dialog, protected actions are not executed at all. |
| Browser for approval pages | `"browser"` | your default browser | A browser app name (macOS only, for example `Safari`) or the full path of a browser program. A name Praxis cannot honour (outside macOS) means the page is not opened at all, rather than in another browser. See "Keep the page to yourself". |
| — | `PRAXIS_APPROVAL_PAGE_WAIT_MS` | 45000 | How long an apply waits for your click before Claude reports it as pending. |
| — | `"minAnswerMs"` | 1000 | A dialog answer faster than this is the client's own, not yours (see below). |
| — | `"pageMinMs"` | 3000 | The page takes no decision sooner than this after it first loads. |
| Approval mode | `"mode"` | blank | The opt-in `trusted-client` and `host-permission` modes (see [user-approval.md](user-approval.md)). Neither replaces the page for acts only you may perform. |

For the Code tab, Cowork and the CLI, these settings are read from that file and not from environment variables, because a repository's `.claude/settings.json` can set environment variables for Claude Code. A repository's `.env` cannot set any of them either.

## Keep the page to yourself

The page is safe from Claude's Praxis tools: they never see its link. It is **not** safe from tools that operate your browser or your computer:

- **Claude in Chrome** (or any browser-automation extension) can see and click tabs in the browser it controls. If you use it, set *Browser for approval pages* to a browser it does not control, for example Safari.
- **A shell** (the Desktop Code tab and the CLI give Claude one), or **repository code Praxis runs** (Quality checks, a project adapter; an agent that can write files in your repository can supply that code), can read the page's short-lived link file, load the page before your browser does, or change Praxis itself. The link works once, the page waits 3 seconds before it takes a decision, and if something else opened it first your tab says "already opened somewhere else" and only Reject is accepted, but this narrows the race, it does not close it. Praxis cannot prevent that, and no local approval can. The same agent could also run `git` directly, without Praxis. Praxis approvals make sure that what Claude does *through Praxis* was shown to you and approved by you. They are not a lock against a program running as you.

The details are in the [threat model](approval-threat-model.md).

## What Claude tells you, and what it means

| Claude reports | Meaning |
| --- | --- |
| it ran, approved in the approval page | Approve was clicked in the page (Praxis cannot tell who or what clicked) |
| `APPROVAL_PENDING` | the page is open and nobody has decided yet |
| `APPROVAL_REJECTED` | Reject was chosen in the page or a dialog |
| `APPROVAL_DISMISSED` | you closed a dialog without deciding: not a rejection |
| `APPROVAL_EXPIRED` / `APPROVAL_TIMED_OUT` | nobody decided in time: not a rejection |
| `APPROVAL_CLIENT_UI_REQUIRED` | Praxis could not ask you here (no dialog and no page). Nothing ran, and you did not reject anything. |
| `APPROVAL_WITHDRAWN` | Claude withdrew the request itself: not your decision |

## Why the Code tab does not use its dialog

The Code tab declares that it can show approval dialogs. When Praxis asks, it answers "decline" by itself about 10 to 40 milliseconds later and shows nothing ([anthropics/claude-code#89858](https://github.com/anthropics/claude-code/issues/89858)). Earlier Praxis versions recorded that as *your* rejection. Praxis now treats any dialog answer faster than a person can read as the client's own answer. It records it as such and asks in the approval page in the same step. Once it has seen this twice from the same client version, it goes to the page directly. When a new Claude Code version arrives, Praxis tries its dialog again.

## Correcting earlier records

Older Praxis versions wrote two kinds of entries into your decision journal (`~/.praxis/decisions/`) that blame you for something you did not do:
- the Code tab's own decline, recorded as your rejection;
- the agent's `confirmation=NO`, recorded as "the user declined (reported by the agent)".

Ask Claude to run `praxis_approval_journal` for the repository. It lists those entries with the evidence. If you agree, Claude runs it again with `amend=true`, and you approve the list in the approval page. Praxis then appends one correction per entry. It never changes or deletes an existing line.

## Compatibility

| Client | How Praxis asks | Verified |
| --- | --- | --- |
| Claude Desktop 4.4212.0, Code tab (embedded Claude Code 2.1.309) | approval page; its own dialog answers by itself | live, 2026-11-10: the dialog was answered `decline` 34 ms after it was asked, with nothing shown |
| Claude Desktop, Chat | approval page (no dialog declared) | see the release's test report |
| Claude Desktop, Cowork | approval page when the Runtime runs on your computer; otherwise nothing protected runs | see the release's test report |
| Claude Code CLI | its approval dialog | interactive run with a person; automated with a scripted answer at a person's pace |
