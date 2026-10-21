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

## A client that cannot show the dialog: nothing protected runs

Not every MCP client supports elicitation (and a connection on the 2026-07-28 protocol revision, which replaces it, is treated the same way until Praxis implements that mechanism). There is **no fallback**: an agent saying "the user said yes", `confirmation=YES`, or text you type in chat is not an approval, because Praxis cannot tell it from the agent's own words.

- The protected tool answers `APPROVAL_CLIENT_UI_REQUIRED`: the action was **not executed**, the message says why, and `data.details.preview` carries the preview so the agent can show it to you.
- Read-only tools, previews, the doctor and the agent's own workflow records keep working.
- `praxis_doctor` reports `approval.mode: "no-dialog"` and what that means.
- `confirmation=NO` is the one thing text can still do: it records that you declined and runs nothing (text can only make Praxis do less).
- The `praxis` CLI has its own dialog: in an interactive terminal it prints the action and asks you to type `approve`. With no terminal (a pipe, CI) it refuses, like a client without a dialog.

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
