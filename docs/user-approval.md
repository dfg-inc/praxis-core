# User approval

Praxis changes things outside the agent's own notes only after the client's own approval dialog approved exactly that change:

```
Action -> Preview -> the client's dialog: Approve or Reject -> Execute -> Result
```

There is nothing to install for this: no service, no system account, no administrator rights, no signing keys.

## What needs approval

| Needs approval | Does not |
| --- | --- |
| Git: connect a remote, set the identity, commit, push, merge request | Reading anything (status, previews, inspect, doctor) |
| Jira writes (BA apply, Architect apply, claim, release, complete, Quality apply, link) | Agent-authored workflow records (requirements, handoffs, verdicts, implementation records) |
| Writing `.project` | |
| Confirming a Story, confirming an architecture decision, marking a service approved, rewording an accepted criterion | |
| Recording review decisions and remarks (`praxis_review_apply`) | |
| Applying a Quality fix patch (the commit, and separately the push) | |
| Correcting the decision journal (`praxis_approval_journal`, `amend=true`) | |

A commit approval is not a push approval, and approving a decision does not confirm a Story: every approval names one action and the exact content shown. If the content changes after the preview, the old preview is refused before anyone is asked.

## How you are asked

The agent calls the `*_preview` tool and shows you the result. It then calls the apply tool with `confirmation=YES` and the `previewFingerprint` from that preview. `confirmation=YES` is not your approval: Praxis then asks through **the client's own approval dialog** (MCP *elicitation*), when the client really shows one (the Claude Code CLI does). The answer reaches Praxis as the client's response to the server, not as a tool argument, so the agent cannot write it through Praxis.

**Approve** runs exactly the previewed action and **Reject** runs nothing. Nothing the agent puts in arguments or in a command (`approved`, `grant`, `authorization`, `userApproval`, `planText`, a `via` field, a file in the repository, text in chat) stands in for that answer. Neither does a page Praxis serves on your computer, nor any setting.

**What the answer proves.** A dialog answer is a *client response*: Praxis knows the client's dialog answered, not who or what answered it. It is recorded as such (`data.approval[].assurance: "client-ui"`, trust `client-response`, `decidedBy: client-dialog`, `personVerified: false`) and is never called independent human authorization. Since 0.1.0-alpha.49.3 every protected action's result also carries `data.authorization`: `channel`, `decidedBy`, `personVerified: false`, `independentlyVerified: false`. A Jira write adds `independentlyApproved: false` and the reason. See the [threat model](approval-threat-model.md) for the five kinds of "yes" Praxis keeps apart.

**Review pages.** In the HTML review (`praxis_review_render`) you mark, comment and edit, then press **Send for approval**. That records nothing: it hands the decisions to the agent, which calls `praxis_review_apply` (`fromPage: true`). The dialog then shows exactly those decisions, remarks included, and only its approval records them. A page that is out of date says so at once, and what conflicts is not applied.

## Every outcome has its own code

An action that did not run says why, and Praxis never attributes a decision to you without evidence. `data.outcome` and `data.decidedBy` carry the same information as the code. `decidedBy` names **what answered**, never a person.

| Code | What happened | `decidedBy` |
| --- | --- | --- |
| (success) | approved in the client's dialog | `client-dialog` (or `terminal-prompt` for the `praxis` CLI) |
| `APPROVAL_REJECTED` | rejected in the client's dialog | `client-dialog`, `terminal-prompt` |
| `APPROVAL_DISMISSED` | the dialog was closed without deciding: not a rejection | `client-dialog` |
| `APPROVAL_TIMED_OUT` | a dialog was shown and nobody answered in time | `nobody` |
| `APPROVAL_EXPIRED` | an answer is too old to use | `nobody` |
| `APPROVAL_WITHDRAWN` | the agent passed `confirmation=NO`: its withdrawal, not your decision | `agent` |
| `APPROVAL_CLIENT_UI_REQUIRED` | Praxis could not ask here: no dialog (`outcome: unavailable`), the client answered its dialog by itself (`outcome: auto-answered`), or a setting answers the dialog automatically (`unavailable`, the file is named) | `nobody` or `client` |
| `APPROVAL_SCOPE_MISMATCH`, `APPROVAL_TOO_LARGE`, `APPROVAL_FINGERPRINT_MISMATCH` | Praxis refused before asking (a changed plan, too much to show in full) | `praxis` |

**An answer faster than a person can read the request is not a person's answer.** Response time is used only in this direction: it can show that an answer was automatic, and it never shows that a person answered (a script that waits a second looks the same as you). The Claude Desktop Code tab declares the dialog and then answers `decline` by itself, 9 to 34 ms after it is asked, with nothing on screen ([anthropics/claude-code#89858](https://github.com/anthropics/claude-code/issues/89858)). Any dialog answer sooner than 1000 ms is the client's own, `accept` as well as `decline`: Praxis records `auto-answered` and runs nothing. A client version seen twice declining faster than any person (under 250 ms) is not asked again: the action is refused at once. A new client version is tried once more, in case it was fixed.

**A configured answer is not a person's answer either.** Claude Code runs `Elicitation` hooks from repository, user, plugin and managed settings, from agent, skill and command definitions, and from flags it was started with, and such a hook can answer the dialog. Praxis checks that configuration before it asks and again after the answer, parses what it reads, and refuses whatever it cannot fully check. If it finds a hook, it does not take the answer and names the file.

**A project does not configure its own approval.** The repository's own Claude Code settings may hold only keys that neither run anything nor configure the client or the Runtime (`permissions`, `model`, `outputStyle`, `includeCoAuthoredBy` and a few more). Anything else, including any hook (even a formatter), any `env` entry, a status line command, plugins or marketplaces and helper commands, refuses protected actions, as does a hook in the repository's agent, skill or command definitions, or a Praxis state home inside the repository; the doctor names the file. Move such settings to your user settings if you want them. A client started with a flag that brings more configuration (any `--plugin…`, `--setting…` or `--managed…` flag, `--agents`, `--await-initialize`), or whose environment or user settings `env` point it at more configuration (`CLAUDE_CODE_PLUGIN_DIRS` and the like), is refused too, and so is `claude` started inside another Claude Code session.

This is best effort: a configuration source Praxis does not know about is not seen (threat model, R6), and a repository whose configuration Claude Code already ran as you could have removed what Praxis would see (R5). Claude Code's workspace trust prompt is the boundary for that: trust only repositories you have checked.

## Which clients can ask (evidence, not assumption)

`praxis_doctor` → `approval` reports what your client declared (`client`), the mode (`mode`: `client-ui` or `no-dialog`), how protected actions can be approved here (`trust`), whether the client was seen answering its dialog by itself (`observedDialog`), any configured answer (`dialogAutomation`), and settings it ignored (`ignoredEnvironment`).

| Client | Protected actions | Evidence |
| --- | --- | --- |
| Claude Code CLI (terminal) | approved in its dialog | interactive runs (keys sent to the real CLI in a pseudo-terminal; earlier, a run with a person) |
| Claude Code CLI with an `Elicitation` hook, project hooks or Runtime env in the repository's settings, or started with `--settings` / `--plugin-dir` / `--plugin-url` / `--agents` | refused (the file or flag is named) | verified with Claude Code 2.1.314 |
| Claude Desktop, Code tab | refused before asking: Desktop starts it with `--settings` and `--await-initialize` (the doctor names them); its dialog also answers by itself | live 2026-11-10 and 2026-11-11 (Desktop 4.4212.0, embedded Claude Code 2.1.309) |
| Claude Desktop, Chat | refused: no dialog declared | Desktop's extension host declares no elicitation |
| Claude Desktop, Cowork | refused: no dialog | see [desktop-approvals.md](desktop-approvals.md) |
| Official MCP SDK 2.0 client | approved in its dialog | `accept:approval-ux` |
| Other MCP clients | `praxis_doctor` tells you | |

## Without a dialog: nothing protected runs

There is **no fallback**: not to the agent's word, not to a page, not to a setting.

- The protected tool answers `APPROVAL_CLIENT_UI_REQUIRED`: the action was **not executed**, **nobody rejected it**, the message says why, and `data.preview` carries the preview so the agent can show it to you.
- Read-only tools, previews, reviews, the doctor and the agent's own workflow records keep working.
- `confirmation=NO` is the one thing the agent can still send: it withdraws the request (`APPROVAL_WITHDRAWN`) and runs nothing.
- The `praxis` CLI has its own dialog: in an interactive terminal it prints the action and asks you to type `approve`. With no terminal it refuses. A program can type into a terminal through a pseudo-terminal (`script(1)`), so this prompt, like the client's dialog, is a client response, not proof of a person (threat model, R3).

This holds for every protected action, including the acts only you may perform (confirming a Story or an architecture decision, approving a service, rewording an acceptance criterion, recording review decisions, opening a classic work item, correcting the journal). In Claude Desktop, apply them from the Claude Code CLI ([desktop-approvals.md](desktop-approvals.md)).

`~/.praxis/diagnostics/mcp.jsonl` (path in `praxis_doctor` → `approval.diagnosticsLog`) records `tool_enter`, `tool_finished` (with `ms` and the result `code`) and `input_required` per call, with names, durations and the client's declared capability keys. It never records arguments or plan text. A call that is missing there never reached Praxis. If a Chat seems to hang on an apply, look for the host's own tool-permission prompt: allowing a call there lets it reach Praxis, it does not approve the action.

### No setting weakens approval

Every place a setting can come from is reachable by someone other than the person deciding: Claude Code applies the `env` block of a repository's `.claude/settings.json` to the MCP servers it starts, and an agent with a shell on your account writes your home folder and the Desktop extension settings like you do. So:

- the Trusted Client and host-permission modes, `planText`, the approval page and its settings, and `~/.praxis/approval-settings.json` are removed;
- in a shipped Runtime every test switch is a compile-time no-op;
- `PRAXIS_APPROVAL_MODE`, `PRAXIS_APPROVAL_PAGE`, `PRAXIS_APPROVAL_BROWSER`, `PRAXIS_APPROVAL_PAGE_MIN_MS` and a lower `PRAXIS_APPROVAL_MIN_ANSWER_MS` are ignored and listed by the doctor;
- a longer `PRAXIS_APPROVAL_MIN_ANSWER_MS` is taken, because it only makes approval stricter;
- since 0.1.0-alpha.49.3, neither `HOME` nor `PRAXIS_STATE_HOME` moves the decision journal or the decision ledger in a shipped Runtime: their place comes from the operating system's account database.

Released 0.1.0-alpha.48 to alpha.49.1 took `PRAXIS_APPROVAL_MODE` from the environment and from the Desktop extension's *Approval mode* setting, so a repository's Claude Code settings could switch on Trusted Client; and in Claude Code a repository's `Elicitation` hook could answer the dialog. Both are fixed in 0.1.0-alpha.49.2 (see the security advisory in the release notes).

## The decision journal

Every request is appended to a journal in your own Praxis home, **outside the repository**: `~/.praxis/decisions/<repository key>.jsonl`, where `~` is your account's home as the operating system records it. The repository key is derived from the repository's real git directory, not from how a path was spelled; the decision ledger uses the same key. A linked worktree shares its repository's key only when git's own layout confirms it (its git directory sits under the repository's `.git/worktrees/` and points back at it); any other `.git` file, such as one planted in an archive, keys the folder as a plain folder of its own. A git repository at your home folder (dotfiles) is not taken as the repository of the projects under it. `praxis_doctor` → `approval.decisionLog` shows the exact path. Security state that would resolve inside the repository is neither read nor written, and protected actions are refused. Each entry records when, what, the digest of the exact content, the outcome (`decision`), what answered (`decidedBy`), the channel, and the evidence (`evidence`: the answer's timing). The journal cannot be committed with the project, and Praxis never reads it back as an authorization.

**Correcting older entries without rewriting them.** `praxis_approval_journal` lists the entries written before journal v2 that attribute a rejection to you without evidence:

- `agent-reported-decline`: the agent's `confirmation=NO`, recorded then as "the user declined (reported by the agent)".
- `client-answered-without-dialog`: a client's own `decline`. The Runtime's diagnostics log shows it arrived faster than a person can read.

With `amend=true` and `confirmation=YES`, it appends one correction per entry after the dialog approves exactly that list. Each correction names the entry it corrects (line number and the SHA-256 of its exact text), what the entry claimed, what the evidence shows, the rule and the evidence. No existing line is changed or removed. A rejection that took a person's time, or one with no timing recorded, is listed as `unverified` and left as written.

**Journals from earlier versions** were named after the path as it was spelled. The first time 0.1.0-alpha.49.3 uses a repository's journal, it copies such a file from the same home under the new name; the old file is left as it was. Only one older journal is adopted: the one named after the path exactly as it is spelled in that first call. Before 0.1.0-alpha.49.3 every worktree and every spelling of the path (a subfolder, a link) had a journal of its own; those are not merged, because each correction in a journal names its entry by line number and hash in that file, and merging would break those references. They stay in `~/.praxis/decisions/` under their old 16-character names, untouched and readable as text (each line records its `repository`). A journal kept under `PRAXIS_STATE_HOME` elsewhere is not adopted. The journal is a log, never evidence, so nothing Praxis decides depends on which older entries were adopted.

**Records from earlier versions** keep their labels and are read for what they were: `independent-human` (a dialog answer, now `client-response`), `review-page` (a page's Save), `host-attested` (`host-prompt`, `trusted-client`).

## Accepted decisions

A story, decision, criterion or service confirmed through the dialog is also recorded in the **decision ledger**, outside the repository, bound to its exact content. Since 0.1.0-alpha.49.3, an acceptance written in the Work Item file counts only when the ledger backs it: one written by hand, copied from another subject, edited after acceptance or recorded on another computer reads `unverified` or `invalid`, and gates refuse it. Acceptances made before the upgrade read `unverified` until you accept them again in the review. See [acceptance-integrity.md](acceptance-integrity.md).

## Credentials

- **Redaction.** Praxis replaces the values of the credentials it holds (`PRAXIS_JIRA_TOKEN`, `PRAXIS_GITHUB_TOKEN`, `PRAXIS_GITLAB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_TOKEN`) with `[REDACTED:<NAME>]` in every tool result, error, diagnostic and log line it writes. This keeps them out of the agent's context through Praxis by accident. It does not remove them from an environment the agent's shell already inherited, and it does not stop a program that reads a token itself and prints it in another form.
- **Repository code is not handed credentials.** Tests, Quality checks, `.praxis/quality/adapter.mjs` and Git (with its hooks) are started with an allowlisted environment that carries no credential, so a token is not in their own environment or in what they log from it. This is hygiene, not a boundary: repository code runs as you and can read the Runtime's own environment (`ps -E -ww -p <pid>` on macOS, `/proc/<pid>/environ` on Linux), which holds every credential the Runtime was started with, including one the Claude Desktop extension settings gave only to the Runtime. Removing a variable from a running process does not change what those show, so Praxis does not claim to.
- **A repository cannot redirect or supply a credential.** If a repository file (`.env`, `.claude/settings*.json` `env`, an `.mcp.json` server's `env`) sets where or how a token is sent (`PRAXIS_JIRA_BASE_URL`, `PRAXIS_JIRA_EMAIL`, `PRAXIS_GITHUB_API_URL`, `PRAXIS_GITLAB_BASE_URL` and the like), the token is not used (`CREDENTIAL_SOURCE_UNTRUSTED`). See [repository-env.md](repository-env.md).
- **Exposure, by name.** `praxis_doctor` → `credentialExposure` lists the credential variables the Runtime inherited, by name only, never a value or a length. Any process started the same way, an agent's shell included, can read them. A token set for your whole login session (for example with `launchctl setenv` on macOS) reaches every app you start, and every agent shell in them.

## What this is not

- It is **not** a security boundary against a program running as you. That includes the decision ledger: it stops repository contents and a sandboxed agent from forging acceptance, not a program with your permissions. An agent with a shell can run a client of its own and answer the dialog, drive the CLI, edit repository files and Praxis's state, run Git itself, call Jira with your credentials, or drive a browser on your account. User approval is a consent and workflow mechanism: when the agent uses Praxis to change something, the client's dialog was asked and said yes, nothing configurable answered for you where Praxis can see it, and Praxis tells the truth about how it knows. The [threat model](approval-threat-model.md) goes through each case, including what it does not close (R1 to R6).
- It does not verify who is at the keyboard (no biometric, no hardware key): whatever answers the client's dialog is "the dialog's answer".
- Git hooks, CI and the repository host are not changed by it.

An approval an agent cannot influence even with a shell needs a separate trust domain: an approval authority outside your account that signs each decision, verified by the Runtime. The threat model sketches that design. Praxis had a native approval service and removed it: see `docs/cleanup-native-approval-service.md` if you installed any part of it.

## For developers

- Core: `packages/contracts/src/user-approval.ts` (the approval, `obtainUserApproval` and its outcomes, the lease writers require, journal v2, `securityStateHome` and `repositoryKey`), `acceptance-integrity.ts` (the decision ledger's subjects and checks), `credential-source.ts` (a credential and its destination from one source), `secret-redaction.ts` and `child-env.ts`, `approval-audit.ts` (trust classes), `decision-journal.ts` (reading, auditing and amending the journal), `human-acts.ts`, `workflow.ts`, `planning.ts` (the only review channel: `approved`), `packages/cli/src/operations.ts` (`guardWrite`).
- Runtime: `packages/mcp/src/approval-channel.ts` (the elicitation dialog, the answer-time rule, `automationGuarded`), `dialog-automation.ts` (finding configured answers), `approval-settings.ts` (nothing weakens; test switches inert in a shipped bundle), `dialog-observations.ts` (clients seen answering by themselves), `decision-ledger.ts` (the ledger), `workflow-store.ts` (integrity on every read), `review-service.ts` (Send for approval is a handover), `approval-journal.ts`, `server.ts`, `tools.ts`.
- Tests:
  - Core: `user-approval.test.ts`, `decision-journal.test.ts`, `approval-audit.test.ts`, `review-provenance.test.ts`.
  - Runtime: `trust-boundary.test.ts`, `user-approval-flow.test.ts`, `desktop-approval.test.ts`, `human-only-integrity.test.ts`.
  - `npm run accept:approval-ux` and `accept:desktop-approval` drive the packaged `.mcpb` with scripted clients; `accept:approval-security` runs the attacks (and, with `--bundle`, the same attacks against other versions).
  - None of these prove that a person answered.
- Library writers (`requireMutationLease`) refuse to run outside an approved action. Tests use `runApprovedForTest`, `approvalFor`, `userChannelFor` and `applyAsUser`, which need `PRAXIS_TEST_APPROVALS=1` and never work in a shipped bundle; a repository `.env` can never set `PRAXIS_APPROVAL_*` or `PRAXIS_TEST_*`.
