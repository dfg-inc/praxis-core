# User approval

Praxis changes things outside the agent's own notes only after **you** approve exactly that change:

```
Action -> Preview -> you Approve or Reject -> Execute -> Result
```

There is nothing to install for this: no service, no system account, no administrator rights, no signing keys.

## What needs your approval

| Needs your approval | Does not |
| --- | --- |
| Git: connect a remote, set the identity, commit, push, merge request | Reading anything (status, previews, inspect, doctor) |
| Jira writes (BA apply, Architect apply, claim, release, complete, Quality apply, link) | Agent-authored workflow records (requirements, handoffs, verdicts, implementation records) |
| Writing `.project` | |
| Confirming a Story, confirming an architecture decision, marking a service approved | |
| Applying a Quality fix patch (the commit, and separately the push) | |
| Correcting the decision journal (`praxis_approval_journal`, `amend=true`) | |

A commit approval is not a push approval, and approving a decision does not confirm a Story: every approval names one action and the exact content you were shown. If the content changes after the preview, the old preview is refused before you are asked anything.

## How you are asked

The agent calls the `*_preview` tool and shows you the result. It then calls the apply tool with `confirmation=YES` and the `previewFingerprint` from that preview. `confirmation=YES` is not your approval: Praxis then asks **you** itself, in one of two places.

1. **The client's own approval dialog** (MCP *elicitation*), when your client really shows it (the Claude Code CLI does). Your answer reaches Praxis as the client's response to the server, not as a tool argument, so the agent cannot write it.
2. **The Praxis approval page**, when the client cannot show that dialog (Claude Desktop Chat) or answers it by itself (the Claude Desktop Code tab). The Runtime opens a page in your browser that shows the same text the dialog would. You choose **Approve** or **Reject** there. The page's link is secret and goes from the Runtime straight to your browser. The agent never receives it, so it cannot open or click the page through Praxis. See [Claude Desktop approvals](desktop-approvals.md) for the workflow and [the threat model](approval-threat-model.md) for what this does and does not protect against.

In either place, **Approve** runs exactly the previewed action and **Reject** runs nothing. Nothing the agent puts in arguments or in a command (`approved`, `grant`, `authorization`, `userApproval`, a file in the repository, text in chat) stands in for your answer.

The result of every protected call says how the approval was obtained. `data.approval[].assurance` is `client-ui` for a dialog, `approval-page` for the page, and `host-prompt` or `trusted-client` for the opt-in modes.

## Every outcome has its own code

An action that did not run says why, and Praxis never attributes a decision to you without evidence. `data.outcome` and `data.decidedBy` carry the same information as the code.

| Code | What happened | `decidedBy` |
| --- | --- | --- |
| (success) | you approved | `user` |
| `APPROVAL_REJECTED` | you rejected it, in the dialog or the page | `user` |
| `APPROVAL_DISMISSED` | you closed the dialog without deciding: not a rejection | `user` |
| `APPROVAL_PENDING` | the approval page is open and nobody has decided yet; the agent calls the same tool again after you decide | `nobody` |
| `APPROVAL_TIMED_OUT` | a dialog was shown and nobody answered in time | `nobody` |
| `APPROVAL_EXPIRED` | an answer or a page request is too old to use | `nobody` |
| `APPROVAL_WITHDRAWN` | the agent passed `confirmation=NO`: its withdrawal, not your decision | `agent` |
| `APPROVAL_CLIENT_UI_REQUIRED` | Praxis could not ask you here: no dialog and no page (`outcome: unavailable`), or the client answered its dialog by itself (`outcome: auto-answered`) | `nobody` or `client` |
| `APPROVAL_SCOPE_MISMATCH`, `APPROVAL_TOO_LARGE`, `APPROVAL_FINGERPRINT_MISMATCH` | Praxis refused before asking (a changed plan, too much to show in full) | `praxis` |

**An answer faster than a person can read the request is not a person's answer.** The Claude Desktop Code tab declares the dialog and then answers `decline` by itself, 9 to 34 ms after it is asked, with nothing on screen ([anthropics/claude-code#89858](https://github.com/anthropics/claude-code/issues/89858)). Praxis treats any dialog answer that arrives sooner than `PRAXIS_APPROVAL_MIN_ANSWER_MS` (default 1000 ms) as the client's own. That covers `accept` as well as `decline`. It records `auto-answered`, notes that client version, and asks in the approval page instead. Later calls from that client version go to the page directly, so Praxis does not retry a dialog that is known to fail. A new client version is tried once more, in case it was fixed.

Before this rule, Praxis recorded the Code tab's own decline as "rejected by the user", and recorded the agent's `confirmation=NO` as the user's rejection. The [decision journal](#the-decision-journal) section shows how those entries are corrected.

## Which clients can ask you (evidence, not assumption)

`praxis_doctor` → `approval` reports what your client declared (`client`), the mode Praxis will use (`mode`: `client-ui`, `approval-page`, `no-dialog`, `trusted-client`, `host-permission`), whether this client was seen answering its dialog by itself (`observedDialog`), and the page settings (`page`).

| Client | How you are asked | Evidence |
| --- | --- | --- |
| Claude Code CLI (terminal) | its approval dialog | real interactive run with a person (2.1.304, 402.5 s to Approve); `accept:claude-code-approval` (an `Elicitation` hook answering at a person's pace) |
| Claude Desktop, Code tab | approval page (its dialog answers by itself) | live 2026-11-10 (Desktop 4.4212.0, embedded Claude Code 2.1.309): `decline` 34 ms after `input_required`, no dialog shown; `accept:desktop-approval` replays it |
| Claude Desktop, Chat | approval page (no dialog declared) | client `claude-ai`, no `elicitation` (Desktop 3.1623.1); see [desktop-approvals.md](desktop-approvals.md) for the current matrix |
| Claude Desktop, Cowork | see [desktop-approvals.md](desktop-approvals.md) | the page needs a Runtime that runs on your computer, not inside the Cowork sandbox |
| Official MCP SDK 2.0 client | its approval dialog | `accept:approval-ux` |
| Other MCP clients | `praxis_doctor` tells you | |

## Without a dialog and without the page: nothing protected runs

There is **no fallback to the agent's word**: an agent saying "the user said yes", `confirmation=YES`, or text you type in chat is not an approval, because Praxis cannot tell it from the agent's own words.

- The protected tool answers `APPROVAL_CLIENT_UI_REQUIRED`: the action was **not executed**, **nobody rejected it**, the message says why, and `data.preview` carries the preview so the agent can show it to you.
- Read-only tools, previews, the doctor and the agent's own workflow records keep working.
- `confirmation=NO` is the one thing the agent can still send: it withdraws the request (`APPROVAL_WITHDRAWN`) and runs nothing.
- The `praxis` CLI has its own dialog: in an interactive terminal it prints the action and asks you to type `approve`. With no terminal it refuses.

The approval page is switched off with `PRAXIS_APPROVAL_PAGE=off` (extension setting *Approval page in your browser*). It is unavailable when the Runtime cannot open a browser on the computer you use, for example when it runs inside a sandbox, on a remote host, or with no display.

`~/.praxis/diagnostics/mcp.jsonl` (path in `praxis_doctor` → `approval.diagnosticsLog`) records `tool_enter`, `tool_finished` (with `ms` and the result `code`) and `input_required` per call, with names, durations and the client's declared capability keys. It never records arguments or plan text. A call that is missing there never reached Praxis. If a Chat seems to hang on an apply, look for the host's own tool-permission prompt.

### Opt-in: `PRAXIS_APPROVAL_MODE=host-permission`

This mode is for a host that has no dialog but does ask before running an MCP tool. You switch it on with the extension setting *Approval mode*; a repository can never set it. The agent calls `praxis_approval_plan` (read-only), which returns the exact plan Praxis computed from the live state. The agent shows it to you, then calls the apply tool with that exact text as `planText`. Praxis recomputes the plan and refuses unless the text matches, so the host's permission prompt shows what will really run, and a changed plan needs a new text and a new prompt.

What it cannot do, stated plainly: Praxis cannot see whether the host's prompt was shown. If you chose "always allow" for the tool, there is no prompt and the agent has approved itself. The result is labelled `assurance: "host-prompt"`, never `client-ui`.

### Opt-in: `PRAXIS_APPROVAL_MODE=trusted-client` (Trusted Client)

This mode is the owner's explicit decision to trust a client with protected actions without a separate confirmation of each one. You switch it on with the extension setting *Approval mode*, or with the environment variable for a client that starts the Runtime itself. It is never the default and a repository `.env` cannot set it. Praxis runs a previewed action on `confirmation=YES` with the matching `previewFingerprint`, and labels it `trusted-client`. That label is never your confirmation of that action.

**Neither opt-in mode covers acts only a person may perform**: confirming a Story or an architecture decision, approving a service, rewording an acceptance criterion (`revise-acceptance`), recording review decisions (`praxis_review_apply`), opening a classic work item, and correcting the decision journal. For those, Praxis asks you in the approval page or the client's dialog. If it can do neither, it refuses with `APPROVAL_CLIENT_UI_REQUIRED`, whatever `planText` says.

## The decision journal

Every request is appended to a journal in your own Praxis home, **outside the repository**: `~/.praxis/decisions/<repository id>.jsonl`. `PRAXIS_STATE_HOME` moves it, and `praxis_doctor` → `approval.decisionLog` shows the exact path. Each entry records when, what, the digest of the exact content, the outcome (`decision`), who made it (`decidedBy`), the channel, and the evidence (`evidence`: the answer's timing, the page request id). The journal cannot be committed with the project, and Praxis never reads it back as an authorization.

**Correcting older entries without rewriting them.** `praxis_approval_journal` lists the entries written before journal v2 that attribute a rejection to you without evidence:

- `agent-reported-decline`: the agent's `confirmation=NO`, recorded then as "the user declined (reported by the agent)".
- `client-answered-without-dialog`: a client's own `decline`. The Runtime's diagnostics log shows it arrived faster than a person can read.

With `amend=true` and `confirmation=YES`, it appends one correction per entry after you approve exactly that list. Each correction names the entry it corrects (line number and the SHA-256 of its exact text), what the entry claimed, what the evidence shows, the rule and the evidence. No existing line is changed or removed. A rejection that took a person's time, or one with no timing recorded, is listed as `unverified` and left as written.

## What this is not

- It is **not** a security boundary against a program running as you. An agent with a shell can edit repository files, run Git itself, call Jira with your credentials, read Praxis's own files, or drive a browser on your account without going through Praxis. User approval is a workflow and consent mechanism: it makes sure that when the agent uses Praxis to change something, you were shown it and said yes, and that Praxis tells the truth about how it knows. The [threat model](approval-threat-model.md) goes through each case.
- It does not verify who is at the keyboard (no biometric, no hardware key): whoever answers the dialog or clicks in the page is "the user".
- Git hooks, CI and the repository host are not changed by it.

If you need an approval an agent cannot influence even with a shell, that needs a separate trust domain (a different OS account or a hosted approval service). Praxis had a native approval service for that and removed it: see `docs/cleanup-native-approval-service.md` if you installed any part of it.

## For developers

- Core: `packages/contracts/src/user-approval.ts` (the approval, `obtainUserApproval` and its outcomes, the lease writers require, journal v2), `decision-journal.ts` (reading, auditing and amending the journal), `human-acts.ts`, `workflow.ts`, `packages/cli/src/operations.ts` (`guardWrite`).
- Runtime: `packages/mcp/src/approval-channel.ts` (the elicitation dialog, the answer-time rule, the page fallback, the opt-in modes), `approval-page.ts` (the approval page), `dialog-observations.ts` (clients seen answering by themselves), `approval-journal.ts` (the audit against the diagnostics log), `server.ts`, `tools.ts`.
- Tests:
  - Core: `user-approval.test.ts`, `decision-journal.test.ts`, `approval-enforcement.test.ts`.
  - Runtime: `user-approval-flow.test.ts`, `desktop-approval.test.ts`.
  - `npm run accept:approval-ux` drives the packaged `.mcpb` with scripted dialogs.
  - `npm run accept:desktop-approval` drives it as the Desktop Code tab and Chat, with a real Chrome on the approval page.
  - None of these prove that a person answered.
- Library writers (`requireMutationLease`) refuse to run outside an approved action. Tests use `runApprovedForTest` / `approvalFor`, which need `PRAXIS_TEST_APPROVALS=1`; a repository `.env` can never set `PRAXIS_APPROVAL_*` or `PRAXIS_TEST_*`.
