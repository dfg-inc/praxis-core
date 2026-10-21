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

The result of every protected call says how the approval was obtained (`data.approval`): `assurance: "client-ui"` when you answered the dialog.

## A client that cannot show the dialog

Not every MCP client supports elicitation (and a connection on the 2026-07-28 protocol revision, which replaces it, is treated the same way until Praxis implements that mechanism). Praxis does not pretend otherwise:

- `praxis_doctor` reports `approval.mode: "unverified-fallback"` and says what that means.
- The agent must ask you **in chat** and call the apply tool with `confirmation=YES` only after you said yes. If you said no it calls it with `confirmation=NO`, which records the rejection and runs nothing.
- Praxis cannot tell whether a person was asked. The approval is recorded as `assurance: "unverified"`, the result carries a warning saying so, and the decision log says so.
- Many clients also show their own permission prompt for each tool call; Praxis marks previews and status as read-only and applies as destructive so that prompt can appear, but it cannot see whether you saw it.

**`PRAXIS_APPROVAL_STRICT=1`** (extension setting *Require approval in the client dialog*) refuses every approval that was not given in the client's dialog. Use it when your client supports the dialog and you want a guarantee that an agent cannot proceed on its own word.

## The decision log

Every decision is appended to `.praxis/approvals/decisions.jsonl` in the repository (git-ignored): when, what, the digest of the exact content, approved / rejected / dismissed / refused, the channel and the assurance. It is there for your later review; it is never read back as an authorization.

## What this is not

- It is **not** a security boundary against a malicious program running as you. An agent with a shell can edit repository files, run Git itself, or call Jira with your credentials without going through Praxis. User approval is a workflow and consent mechanism: it makes sure that when the agent uses Praxis to change something, you were shown it and said yes, and that Praxis tells the truth about how it knows.
- It does not verify who is at the keyboard (no biometric, no hardware key).
- Git hooks, CI and the repository host are not changed by it.

If you need an approval an agent cannot influence even with a shell, that needs a separate trust domain (a different OS account or a hosted approval service). Praxis had a native approval service for that and removed it: see `docs/cleanup-native-approval-service.md` if you installed any part of it.

## For developers

- Core: `packages/contracts/src/user-approval.ts` (the approval, `obtainUserApproval`, the lease writers require), `human-acts.ts` (confirm-story, confirm-decision, approve-service), `workflow.ts` (`applyWorkflowCommand(state, command, { userApproval })`, never part of the command), `packages/cli/src/operations.ts` (`guardWrite`: preview freshness, ask, run inside the lease).
- Runtime: `packages/mcp/src/approval-channel.ts` (the elicitation dialog), `server.ts` (per-call channel, tool annotations), `tools.ts` (`confirmation=YES/NO`, the result note), `human-approval.ts`, `workflow-store.ts`.
- Tests: `user-approval.test.ts`, `approval-enforcement.test.ts` (core); `user-approval-flow.test.ts` (runtime); `npm run accept:approval-ux` drives the packaged `.mcpb` with the official MCP client playing a host with a dialog (answers are scripted: it does not prove a person answered).
- Library writers (`requireMutationLease`) refuse to run outside an approved action. Tests use `runApprovedForTest` / `approvalFor`, which need `PRAXIS_TEST_APPROVALS=1`; a repository `.env` can never set `PRAXIS_APPROVAL_*` or `PRAXIS_TEST_*`.
