# Approval threat model

This page says what Praxis's approvals protect, against whom, and where the protection ends. The rule behind every line: **Praxis does not claim more than the architecture enforces, and where it cannot enforce a boundary, the protected action stays blocked.**

## Five kinds of "yes", kept apart

| Class | What it is | Taken for a protected action? | Recorded as |
| --- | --- | --- | --- |
| Agent assertion | `confirmation=YES`, approval-looking arguments, a command's `via` field, chat text, a file the agent wrote | **never** | `APPROVAL_CLIENT_UI_REQUIRED` (nothing ran) or `APPROVAL_WITHDRAWN` for `confirmation=NO` |
| Convenience confirmation (a standing permission) | Trusted Client, host-permission and `planText`, an approval page Praxis served on this computer, review-page Save, any setting in a repository, the environment or the account's files | **never** (removed in 0.1.0-alpha.49.2) | earlier records keep their labels: `trusted-client`, `host-prompt`, `review-page` |
| Automation | a client that answers its own dialog (the Desktop Code tab), a configured answer (a Claude Code `Elicitation` hook in any scope), the test harness | **never**: refused where Praxis can see it (G4, G5) | `auto-answered` / `unavailable`, `decidedBy: client` or `nobody` |
| Client-origin response | the connected client's own dialog answered, at a person's pace, with nothing configured to answer it | **yes**: the only channel | `assurance: client-ui`, trust `client-response`, `decidedBy: client-dialog` or `terminal-prompt`, `personVerified: false` |
| Independently authenticated human authorization | a decision bound to a person by an authority the agent's account cannot reach | **not available in this version** | (none) |

A client-origin response is the strongest thing Praxis can obtain on the person's own computer. It is **not** proof that a person answered: Praxis knows that the client's dialog answered, not who or what answered it (see R1 and R3). Earlier versions labelled it `independent-human`; such records read as `client-response`, and `approvalSummary` reports `independentHuman: 0`.

## What is protected

1. **The person's decision, as far as the client's dialog carries it.** A protected action runs only after the connected client's dialog approved exactly that action, and only when nothing Praxis can see is configured to answer that dialog.
2. **What runs is what was shown.** An approval binds one action and the digest of its exact content.
3. **The record is honest.** The journal and every result say which channel answered and on what evidence. Nothing is attributed to the person without evidence, and nothing is called a verified person.

## Who is involved

| Party | Trusted for approvals? | Notes |
| --- | --- | --- |
| The person | yes: the only source of a decision | Praxis cannot tell who is at the keyboard |
| The MCP client (Claude Code, Claude Desktop) | trusted to show its own dialog when it shows one, unless it is seen or configured to answer it by itself | the Desktop Code tab answers its dialog by itself; Claude Code runs `Elicitation` hooks from repository, user, plugin and managed settings |
| The agent (the model) | **no** | may be mistaken, over-eager or prompt-injected; may write repository files and, with a shell, any file of the account |
| The repository | **no** | its `.claude/settings.json` sets environment variables and hooks for the MCP servers Claude Code starts; its code may run during verification (T17) |
| The account's own files (home folder, Desktop extension settings, `~/.praxis`) | **no** when the agent has a shell on that account | a shell writes them like the person does |
| The Praxis Runtime | yes, as shipped | a local process running as the person; what a program running as the person can do to it is R2 |

What the agent can reach, per client:

| | Desktop Chat | Desktop Code tab | Cowork | Claude Code CLI |
| --- | --- | --- | --- | --- |
| Shell on the person's account | no, unless an extension gives one, or the agent can write repository code Praxis runs (T17) | **yes** | a shell in the Cowork sandbox, with your folders mounted (T17) | **yes** |
| How a protected action is approved | **not at all**: no dialog, refused | **not at all**: the client answers its dialog by itself, refused | **not at all**: no dialog, refused | the CLI's own dialog |

## What Praxis enforces

| # | Guarantee | How |
| --- | --- | --- |
| G1 | The agent cannot approve through Praxis | An approval is created only from the client's protocol response (or the `praxis` CLI's terminal prompt). Tool arguments, command fields, files, chat text and the journal never become one. Approvals are objects only `user-approval.ts` issues (a `WeakSet`), so parsed JSON cannot pass for one. |
| G2 | Nothing configurable weakens approval | No mode, page, file or environment variable stands in for the dialog. A shipped Runtime is built with `PRAXIS_BUNDLE_KIND="production"` as a compile-time constant, and every test switch (`PRAXIS_TEST_APPROVALS`, the test page, a lower answer time, the test browser, `PRAXIS_TEST_REVIEW_NO_BROWSER`) is inert in it. The doctor names any such variable it ignored. Settings that only make approval stricter (a longer minimum answer time) are taken from anywhere. |
| G3 | An approval binds one action and its exact content | The subject digest is computed from the live state when the action runs. A changed plan has a different digest, so the old approval does not verify and the person is asked again. The preview fingerprint is checked before anyone is asked. A Quality fix binds the patch itself. |
| G4 | Instant answers are not the person's | A dialog answer faster than 1000 ms is the client's own either way, `accept` included. It is journaled as `auto-answered`, and nothing runs. Timing works in this one direction only: it never shows that a person answered. |
| G5 | A configured answer is not the person's | Before asking, and again after the answer, the Runtime looks for an `Elicitation` (or `ElicitationResult`) hook in every scope it can read: `.claude/settings.json` and `settings.local.json` of the working folder, the repository and every folder above them; the user's settings (the account's real home and `CLAUDE_CONFIG_DIR`); installed plugins' hook files; managed settings; agent and skill definitions; and a `--settings` file on the client's command line. If it finds one, the dialog is not asked (or its answer is discarded) and the action is refused, naming the file. Over-detection refuses; it never approves. |
| G6 | Fresh and used once | An answer is usable for 10 minutes from the moment it was given, for one execution of one action. |
| G7 | Honest labels, auditable, append-only corrections | `decidedBy` names what answered; `personVerified` is always `false`. Every outcome is journaled outside the repository. Old misattributions are corrected by appended amendments that name the line and its hash, after the person approves them. No line is rewritten. |
| G8 | No retrying a known failure | A client version seen at least twice declining its dialog faster than any person is not asked again: the action is refused at once. Forgetting that note only makes Praxis ask again, which gets the same automatic answer. |
| G9 | Review decisions follow the same rule | A review page's Send for approval records nothing: it hands the decisions over. `praxis_review_apply` shows exactly those decisions (and any remark the page carries) in the client's dialog, and only its approval records them. A page served on loopback is never a channel. |

## Threats, mitigations, and what remains

| # | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| T1 | The agent says the user approved (`confirmation=YES`, approval-looking arguments, chat text, a forged `via`) | G1: refused; undeclared arguments are refused outright | none through Praxis |
| T2 | An approval reused for different content, or replayed | G3, G6 | none known through Praxis |
| T3 | The client answers its own dialog: the Desktop Code tab's `decline` in milliseconds | G4, G8: recorded as the client's; nothing runs; nobody is said to have rejected it | none: the action stays blocked in that client |
| T6 | **A program running as the person** (an agent with a shell, repository code Praxis runs) | none that holds against a determined program | **real**: see R1 to R4. Praxis approval is a consent mechanism for what goes through Praxis, plus refusal of every configuration-based self-approval Praxis can see. It is not a security boundary against a program running as the person. |
| T12 | A misleading request (content the agent wrote: a commit message, a story, a patch) | the dialog shows the action Praxis computed from the live state, never an agent's summary; anything too long to show in full is refused | a commit is identified by file names and content hashes, not shown as a diff; the person has to read what is shown |
| T14 | Earlier journal entries that blame the person | G7 amendments; v2 entries carry `decidedBy` and evidence | entries without timing are listed `unverified` and left as written |
| T15 | Someone edits the journal or the observations file | the journal is never read back as an authorization; an amendment is applied only when its rule allows exactly that correction; the observations file can only make Praxis refuse sooner or ask again | the journal is a record for an honest system, not tamper-proof storage (R2) |
| T17 | Repository code that Praxis runs (Quality checks, `.praxis/quality/adapter.mjs`) | unsandboxed by design (`docs/workflow-stages.md`) | that code has a shell's power (T6) |
| T18 | **A repository sets the approval mode.** Claude Code applies the `env` block of a repository's `.claude/settings.json` to the MCP servers it starts; `PRAXIS_APPROVAL_MODE=trusted-client` (or `host-permission` with the plan text the agent obtained) let a protected action run on the agent's `confirmation=YES` | fixed in 0.1.0-alpha.49.2: both modes are removed and the variable is read by nothing | none through settings. **Affects released 0.1.0-alpha.48 to alpha.49.1.** |
| T18b | **The account's settings set it**: the Desktop extension's *Approval mode* setting (released 0.1.0-alpha.48 to alpha.49.1), or the `~/.praxis/approval-settings.json` file of the unreleased Desktop candidate. A shell on the account writes both | fixed in 0.1.0-alpha.49.2: the setting and the file are gone; no account file is read for approval | none through settings. Affects released 0.1.0-alpha.48 to alpha.49.1 (the extension setting). |
| T18c | **A repository makes the review page's secret link readable**: a test variable made the Runtime write the link into the repository, where the agent could read it and post the user's review decisions | fixed in 0.1.0-alpha.49.2: the shipped Runtime never writes the link anywhere, and a page's Save records nothing anyway (G9) | none. Affects released 0.1.0-alpha.48 to alpha.49.1. |
| T19 | **A page served on this computer is operated by the agent** (a browser it controls, its own "browser" program, a shell with the link) | the approval page and review-page Save are no longer channels in a shipped Runtime (G9) | none through pages. Affected only the unreleased Desktop candidate. |
| T20 | **A configured answer to the dialog**: an `Elicitation` hook in repository, user, plugin or managed settings, or an agent definition, answers the dialog; a hook that waits a second defeats the answer-time rule | G5 | a hook Praxis cannot see (a scope it does not read, a client launched by the agent): R1. **Affects released 0.1.0-alpha.48 to alpha.49.1** in Claude Code. |
| T21 | Test switches in the environment (test approvals, a lower answer time, the test page) | G2 | none in a shipped Runtime |

### What remains: the boundary this version does not provide

| # | Path | Why Praxis cannot close it on the person's computer |
| --- | --- | --- |
| R1 | The agent starts the Runtime under an MCP client of its own and answers the dialog itself, at a person's pace | the client is a program running as the person; Praxis cannot tell it from the person's client |
| R2 | The agent edits Praxis's state (work item files, the journal) or its code, or skips Praxis and runs `git` or Jira itself | Praxis reads its state from files the agent can write, and the agent can use the same credentials |
| R3 | The agent drives the genuine CLI in a pseudo-terminal, or injects keystrokes into the person's terminal with accessibility rights | the dialog is genuine; the input is not the person's |
| R4 | Repository code Praxis runs (T17) | it runs as the person |

Each needs an authority outside the account: see the end of this page. Until one exists, Praxis states these limits instead of claiming a guarantee, and in every client where it has no dialog to ask, protected actions, the acts only a person may perform included, are refused.

## Comparing the channels honestly

| Channel | Taken in 0.1.0-alpha.49.2? | The agent cannot approve through Praxis | Holds against a configured answer | Holds against a program running as the person | Label |
| --- | --- | --- | --- | --- | --- |
| The client's own dialog (Claude Code CLI) | **yes** | yes | yes where Praxis can see the configuration (G5) | no (R1, R3) | `client-ui`, trust `client-response` |
| The Desktop Code tab's dialog | no: it answers by itself | | | | `auto-answered` |
| Approval page, review-page Save | **no** | | | no | earlier records: `approval-page`, `review-page` |
| Host permission prompt (`planText`) | **no** | no | | no | earlier records: `host-prompt` |
| Trusted Client | **no** | no: a standing permission | | no | earlier records: `trusted-client` |

## Review

Two independent reviews of the earlier Desktop candidate found, among others, that repository settings could switch on Trusted Client (T18). The fix of that candidate moved the setting into the account's home and the Desktop extension settings; a third review of the trust boundary rejected that, because an agent with a shell writes those files too. It also showed that a repository's `Elicitation` hook answers the dialog (T20), that the review page's link could be made readable (T18c), and that a page served on loopback cannot carry a decision against such an agent (T19). 0.1.0-alpha.49.2 is the result: one channel, every configurable weakening removed, configured answers refused, and the limits above stated.

## What would be stronger (not implemented here)

Independently authenticated human authorization needs an authority the agent's account cannot reach. A design that would provide it:

- An **approval authority outside the account**: a different OS account, a hosted service, or a phone app paired once by the person. It shows the action and its digest, and signs `(action, subject digest, nonce, expiry)` with a key the agent's account never holds.
- A **user-verifying authenticator** at that authority (a passkey with user verification: Touch ID, Windows Hello, a hardware key), so a decision needs the person's presence, not a click.
- A **Runtime that verifies the signature** before it runs the action, with the verifying key pinned at install time by the person, outside the reach of the agent's account.

This closes R1 and R3 for actions taken through Praxis. R2 (bypassing Praxis with the same credentials) needs the credentials themselves held by that authority (for example a Git host that requires the signed approval). Praxis removed a native approval service earlier; bringing such an authority back is a product decision, and until then protected actions stay blocked wherever the client's dialog is not available.
