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

A commit approval is not a push approval, and approving a decision does not confirm a Story: every approval names one action and the exact content you were shown. If the content changes after the preview, the old preview is refused before you are asked anything.

## How you are asked

The agent calls the `*_preview` tool and shows you the result. It then calls the apply tool with `confirmation=YES` and the `previewFingerprint` from that preview. Praxis then asks **you**, in the MCP client's own approval dialog (MCP *elicitation*):

- **Approve** runs exactly the previewed action.
- **Reject** (or dismissing the dialog) runs nothing; the tool returns `APPROVAL_REJECTED`.
- Your answer reaches Praxis as the client's response to the server, not as a tool argument, so the agent cannot write it. Nothing the agent puts in arguments or in a command (`approved`, `grant`, `authorization`, `userApproval`, a file in the repository) stands in for it.

The result of every protected call says how the approval was obtained (`data.approval`, always `assurance: "client-ui"`).

## Which clients show the dialog (evidence, not assumption)

MCP defines elicitation; whether a particular host implements it is only known from what it declares. `praxis_doctor` → `approval.client` shows what YOUR client declared (`name`, `version`, `protocolVersion`, `elicitation`), whether Praxis can show a dialog (`dialog`), which protocol flow is used (`flow`) and, when not, why (`reason`).

| Client | Form-mode dialog | Evidence |
| --- | --- | --- |
| Claude Code CLI 2.1.304 | **VERIFIED**, both protocol eras | declares `elicitation: {form, url}` (read from the binary and by `praxis_doctor`); driven end to end against the packed Runtime: Approve ran the action, Reject, Decline and Cancel ran nothing (the user's answer was played by an `Elicitation` hook, so it proves the protocol and the client, not that a person answered) |
| Official MCP SDK 2.0 client | **VERIFIED**, both protocol eras | `npm run accept:approval-ux` |
| Claude Desktop 3.1623.1, Chat | **NO DIALOG** (real Chat test, client `claude-ai`, protocol 2026-07-28) | `praxis_doctor` reported `elicitation.declared: null`, `dialog: false`. A protected apply was not answered by Praxis at all: Desktop's own log shows `tool_approval_gate … approvalRequired:true` for it and the Praxis server never received the call (its log has only the four earlier calls). The call waited at Desktop's tool-permission prompt, not in Praxis |
| Other MCP clients | UNTESTED | `praxis_doctor` tells you |

## A client that cannot show the dialog: nothing protected runs

There is **no fallback by default**: an agent saying "the user said yes", `confirmation=YES`, or text you type in chat is not an approval, because Praxis cannot tell it from the agent's own words.

- The protected tool answers `APPROVAL_CLIENT_UI_REQUIRED`: the action was **not executed**, the message says why, and `data.preview` carries the preview so the agent can show it to you.
- Read-only tools, previews, the doctor and the agent's own workflow records keep working.
- `praxis_doctor` reports `approval.mode: "no-dialog"` and the reason.
- `confirmation=NO` is the one thing text can still do: it records that you declined and runs nothing (text can only make Praxis do less).
- The `praxis` CLI has its own dialog: in an interactive terminal it prints the action and asks you to type `approve`. With no terminal it refuses.

Praxis answers such a call at once: no wait, no round trip, no unsupported request to the client. If a Chat seems to hang on an apply, the call is held by the host before it reaches Praxis: look for the host's permission prompt. `~/.praxis/diagnostics/mcp.jsonl` (path in `praxis_doctor` → `approval.diagnosticsLog`) records `tool_enter`, `tool_finished` (with `ms` and the result `code`) and `input_required` per call, with names, durations and the client's declared capability keys, never arguments or plan text; a call that is missing there never reached Praxis.

A dialog that is declared but never answered ends with `APPROVAL_TIMED_OUT` (nothing executed; ask again). That is neither a rejection nor an approval.

### Opt-in: `PRAXIS_APPROVAL_MODE=host-permission`

For a host that has no dialog but does ask before running an MCP tool, you can switch on a weaker mode (extension setting *Approval without a client dialog*, never settable from a repository). The agent calls `praxis_approval_plan` (read-only; returns the exact plan Praxis computed from the live state), shows it to you, then calls the apply tool with that exact text as `planText`. Praxis recomputes the plan and refuses unless the text matches, so the host's permission prompt shows what will really run and a changed plan needs a new text and a new prompt.

What it cannot do, stated plainly: Praxis cannot see whether the host's prompt was shown. If you chose "always allow" for the tool, there is no prompt and the agent has approved itself. The result is labelled `assurance: "host-prompt"` (never `client-ui`), and quality fixes (commit then push, two approvals) still need a dialog. Leave it off if your client has the dialog.

### Opt-in: `PRAXIS_APPROVAL_MODE=trusted-client` (Trusted Client)

The owner's explicit decision to trust a client with protected actions without a separate confirmation of each one, for example Claude Desktop with "Always allow". Extension setting *Approval mode*, or the environment variable for a client that starts the Runtime itself (Claude Code, Cowork). It is never the default and a repository `.env` cannot set it.

When the agent applies a previewed action with `confirmation=YES` and the matching `previewFingerprint`, Praxis runs it. Results carry `approval[].channel/assurance = "trusted-client"` and the journal records `trusted-client`. It is **not** the user's confirmation of that action and Praxis never says it is. Unchanged: the preview and its fingerprint (a stale plan is refused), argument checks, `confirmation=NO` as a recorded refusal, the journal. Confirming a Story or decision is still the user's act: do it only for the revision they named.

## The decision journal

Every decision is appended to a journal in your own Praxis home, **outside the repository**: `~/.praxis/decisions/<repository id>.jsonl` (`PRAXIS_STATE_HOME` moves it; `praxis_doctor` → `approval.decisionLog` shows the exact path). It records when, what, the digest of the exact content, approved / rejected / dismissed / refused, and the channel. It cannot be committed with the project, and it is never read back as an authorization.

## What this is not

- It is **not** a security boundary against a malicious program running as you. An agent with a shell can edit repository files, run Git itself, or call Jira with your credentials without going through Praxis. User approval is a workflow and consent mechanism: it makes sure that when the agent uses Praxis to change something, you were shown it and said yes, and that Praxis tells the truth about how it knows.
- It does not verify who is at the keyboard (no biometric, no hardware key): whoever answers the client's dialog is "the user".
- Git hooks, CI and the repository host are not changed by it.

If you need an approval an agent cannot influence even with a shell, that needs a separate trust domain (a different OS account or a hosted approval service). Praxis had a native approval service for that and removed it: see `docs/cleanup-native-approval-service.md` if you installed any part of it.

## For developers

- Core: `packages/contracts/src/user-approval.ts` (the approval, `obtainUserApproval`, the lease writers require), `human-acts.ts` (confirm-story, confirm-decision, approve-service), `workflow.ts` (`applyWorkflowCommand(state, command, { userApproval })`, never part of the command), `packages/cli/src/operations.ts` (`guardWrite`: preview freshness, ask, run inside the lease).
- Runtime: `packages/mcp/src/approval-channel.ts` (the elicitation dialog), `server.ts` (per-call channel, tool annotations), `tools.ts` (`confirmation=YES/NO`, the result note), `human-approval.ts`, `workflow-store.ts`.
- Tests: `user-approval.test.ts`, `approval-enforcement.test.ts` (core); `user-approval-flow.test.ts` (runtime); `npm run accept:approval-ux` drives the packaged `.mcpb` with the official MCP client playing a host with a dialog, and one without (the answers are scripted: it does not prove a person answered).
- Library writers (`requireMutationLease`) refuse to run outside an approved action. Tests use `runApprovedForTest` / `approvalFor`, which need `PRAXIS_TEST_APPROVALS=1`; a repository `.env` can never set `PRAXIS_APPROVAL_*` or `PRAXIS_TEST_*`.
