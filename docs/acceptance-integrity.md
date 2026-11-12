# Acceptance integrity

A Work Item lives in your repository, in `.praxis/workflow/items/<id>.json`. Since 0.1.0-alpha.49.3, an acceptance written in that file does not count by itself: Praxis counts it only when its own record outside the repository backs it.

This covers:
- an accepted criterion;
- a phase acceptance;
- a confirmed story or decision;
- an approved service;
- an agreed contract;
- a waiver;
- classic mode;
- an approval record.

## Why

The file is plain JSON. Before 0.1.0-alpha.49.3, anyone who could write the repository could write `"accepted"` and open the gates. That includes:
- an agent with file tools;
- a cloned repository;
- a merged pull request.

Praxis then reported a criterion accepted, a story confirmed or a service approved that nobody had decided.

## How it works

1. Accepting something still goes through the client's approval dialog (see [user-approval.md](user-approval.md)).
2. When the dialog approves, the Runtime appends one record per accepted subject to the **decision ledger**: `~/.praxis/ledger/<repository key>/<work item>.jsonl`. Each record holds:
   - the subject (`criterion`, `phase`, `story`, `decision`, `service`, `contract`, `waiver` or `mode`, plus its id);
   - the digest of its exact content;
   - the decision (`accept`, `reject`, `revoke`, `supersede`);
   - a random action id;
   - how the approval was given (`channel`, `decidedBy`, `personVerified: false`).

   Records are hash-chained. The Work Item file stores each claim's action id. A batch review records one entry per criterion, not one for the batch.
3. Every time a Work Item is read, the Runtime compares each claim in the file with the ledger. Gates, readiness, verdicts, status and guidance count a claim only when the ledger backs it.

| Status | Meaning |
| --- | --- |
| `accepted` | A ledger record accepts this subject with exactly this content, and no later decision of the person took this content back |
| `unverified` | The file claims it, and nothing on this computer backs it: accepted before 0.1.0-alpha.49.3, on another clone or computer, or written into the file |
| `invalid` | The ledger contradicts the file: the content changed after acceptance outside Praxis, the person later rejected or took back this content, the record belongs to another subject, or the subject's id appears twice in the work item |
| `stale` | Accepted for an earlier revision that Praxis recorded |
| `independently-verified` | Reserved. No approval authority exists in this release, so nothing has this status. Anything that would need it is refused with `INDEPENDENT_AUTHORITY_UNAVAILABLE` |

`praxis_workflow_status` and `praxis_workflow_inspect` show each subject's `integrity` and a summary: `integrity: { accepted, unverified, invalid, stale }` and `independentVerification: "unavailable"`. A gate that refuses an unverified or invalid claim names the subject, with `ACCEPTANCE_UNVERIFIED` or `ACCEPTANCE_INVALID`. The file's own claims are never erased.

**What the dialog showed is what is recorded.** The approval of a story, decision or service, and of a reworded criterion, binds the same content digest the ledger records, not only a fingerprint. A review batch binds the stored state the dialog was built from: the Runtime applies it only to exactly that state, read once under the workflow lock. If the file changed while the dialog was open, nothing is recorded and you are asked again.

**Duplicate ids.** The file format allows two criteria, decisions or waivers with one id. Since a forged copy could borrow the record of the genuine one, no copy of a duplicated id counts (`invalid`, reason "duplicate id") until the duplicates are removed, and no decision is recorded for it.

**Where the ledger lives.**
- The home folder comes from the operating system's account database, not from `HOME` or `PRAXIS_STATE_HOME`: a repository's Claude Code settings can set those for the Runtime.
- The repository key is derived from the repository's real git directory, so every worktree of one clone shares it (when git's own layout confirms it: the worktree's git directory sits under the clone's `.git/worktrees/` and points back at it), and a copy elsewhere does not. A `.git` file that does not pass that check makes the folder count as a folder of its own, and a git repository in your home folder is never treated as the repository of the projects under it.
- A ledger that would resolve inside the repository is refused (`DECISION_LEDGER_UNAVAILABLE`). Praxis then records nothing and changes nothing: the dialog's approval is not taken without its record.

## Branches and worktrees

Every branch and worktree of one clone shares one ledger. A decision about a subject is about its content, so:
- An acceptance stays `accepted` on every branch whose file still has exactly the accepted content, whatever happened to that subject on another branch.
- A revision an agent records on one branch (a reworded requirement that makes a story stale, a phase reopened, a status changed) is noted in the ledger as `supersede`. It does not count against other copies of the accepted content: switching back to a branch, reverting a commit or abandoning a branch keeps that branch's acceptances.
- Only the person takes content back: rejecting it, or approving a rewording, rejection or withdrawal of it, records `reject` or `revoke` for that exact content. Then every copy of that content reads `invalid`, on every branch, with the reason "a later decision on this computer, on any branch or worktree, took this content back". Accept it again if it still applies.
- A claim on content that changed reads `stale` when Praxis recorded the change (accept the new revision), and `invalid` when it did not (the content changed outside Praxis).

A waiver recorded before 0.1.0-alpha.49.3 stays in the file and reads `unverified`. Once you waive the same gap again and that waiver is accepted, the old one no longer blocks.

## After upgrading

Acceptances recorded before 0.1.0-alpha.49.3 have no ledger record, so they read `unverified`. Praxis cannot tell them apart from acceptances written into the file. **Accept them again in the normal review**, where the content is shown in the dialog. Nothing else changes: the file keeps its history, and work that needs no acceptance continues.

The same applies to a repository you clone, or to state merged from someone else's branch: their acceptances were recorded on their computer.

## What this protects, and what it does not

| Who changes the state | Result |
| --- | --- |
| Repository contents: a cloned repository, a merged pull request, repository settings, `.praxis/*` | **Stopped.** Acceptance written into the file reads `unverified` or `invalid`. The repository cannot move the ledger. |
| An agent that can write only inside its workspace (a sandboxed agent, for example a Claude Code sandbox that allows writes to the project and temporary folders only) | **Stopped**, as long as `~/.praxis` is outside what it may write. A Praxis Runtime it starts inside its own sandbox cannot append to the ledger, so an acceptance it approves through its own client fails with `DECISION_LEDGER_UNAVAILABLE`. |
| A program running with your full operating-system permissions (an agent with an unsandboxed shell, such as the Claude Desktop Code tab today) | **Not stopped.** It can append to the ledger (the hash chain only catches careless edits), or start its own MCP client and approve in it ([user-approval.md](user-approval.md), R1). |

So `accepted` means **recorded by Praxis on this computer after the client's dialog answered for exactly this content**. It is not proof that a person decided. The protections that hold against a program running as you are outside Praxis: see [approval-threat-model.md](approval-threat-model.md).

## For developers

- **Core:** `packages/contracts/src/acceptance-integrity.ts`: subjects, canonical content, `evaluateIntegrity`, accessors, `planLedgerEntries`, and what each write must append. `planning.ts`, `workflow.ts`, `approval-audit.ts` and `briefing.ts` read acceptance only through those accessors.
- **Runtime:** `packages/mcp/src/decision-ledger.ts` (location, repository key, chain, lock); `workflow-store.ts` (annotation on read; the ledger appended under the workflow lock before the item is written); `workflow-inspect.ts` and `review-service.ts`.
- **Rule:** a state without the annotation is a trusted in-memory state, as built by reducers in tests. Only the workflow store reads item files, and it always annotates.
- **Tests:**
  - core `acceptance-integrity.test.ts`;
  - runtime `decision-ledger.test.ts` and the integrity tests in `planning-tools.test.ts`;
  - `tools/scripts/r1r2-regression.mjs`, which runs the same forgeries against a released bundle and against the candidate.
