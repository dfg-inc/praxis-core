# Approval threat model

This page says what Praxis's approvals protect, against whom, and where the protection ends. It covers the client's approval dialog, the Praxis approval page (new for Claude Desktop), and the opt-in modes. The rule behind every line: **Praxis does not claim more than the architecture enforces.**

## What is protected

1. **The person's decision.** A protected action runs only after the person approved exactly that action.
2. **What runs is what was shown.** An approval binds one action and the digest of its exact content.
3. **The record is honest.** The journal and every result say who decided, through which channel, and on what evidence. Nothing is attributed to the person without evidence.

## Who is involved

| Party | Trusted for approvals? | Notes |
| --- | --- | --- |
| The person | yes: the only source of a decision | Praxis cannot tell who is at the keyboard |
| The MCP client (Claude Desktop, Claude Code) | trusted to show its dialog truthfully, when it shows one | the Desktop Code tab answers its dialog by itself, so its answers are not taken as the person's |
| The agent (the model) | **no** | may be mistaken, over-eager or prompt-injected; its tools differ per client (below) |
| The Praxis Runtime | yes | a local process running as the person |
| The browser that shows the approval page | trusted to show the page to the person | see T5: it may be operated by an automation tool |
| Other local programs and web pages | no | |

What the agent can reach, per client:

| | Desktop Chat | Desktop Code tab | Cowork | Claude Code CLI |
| --- | --- | --- | --- | --- |
| Shell on the person's account | no, unless an installed extension gives one, **or the agent can write repository files that Praxis runs** (see T17) | **yes** | a shell in the Cowork sandbox; your folders are mounted into it, so it can write repository files Praxis runs (T17) | **yes** |
| Browser automation | only with Claude in Chrome connected (it operates the person's real Chrome) | built-in browser pane (a separate browser), and Claude in Chrome if connected | Claude in Chrome if connected | only if configured |
| How Praxis asks | approval page | approval page (its dialog answers by itself) | approval page if the Runtime runs on the person's computer; otherwise nothing runs | the CLI's approval dialog |

## What Praxis enforces

| # | Guarantee | How |
| --- | --- | --- |
| G1 | The agent cannot approve through Praxis's approval interface | An approval is created only from a channel's answer: the client's protocol response, a click in the page, or the CLI's terminal prompt. Tool arguments, command fields, files and chat text never become one. Approvals are objects only `user-approval.ts` issues (a `WeakSet`), so parsed JSON cannot pass for one. This does not cover code that Praxis runs on the agent's behalf (T17). |
| G2 | An approval binds one action and its exact content | The subject digest is computed from the live state when the action runs. A changed plan has a different digest: the old approval does not verify and the person is asked again. The preview fingerprint is checked before anyone is asked. A page decision also binds the digest of the exact text the person read; different text for the same subject is another request. A Quality fix binds the patch itself (not only its file names), and the person is shown the whole patch. |
| G3 | Fresh and used once | An answer is usable for 10 minutes from the moment the person gave it (for the page: from the click). A page decision is taken once: when several calls wait on the same page, the first takes the click and every other call asks anew. Two tabs posting at once record one decision. An undecided page request expires after 10 minutes and is journaled as `expired`. |
| G4 | Instant answers are not the person's | A dialog answer that arrives faster than `PRAXIS_APPROVAL_MIN_ANSWER_MS` (1000 ms) is not taken as the person's either way, `accept` included. It is journaled as `auto-answered`, and the page asks again with clear evidence, so a person who really pressed Reject that fast only rejects once more. An answer for a dialog this Runtime never asked for is ignored. |
| G5 | Honest labels | `assurance` is `client-ui`, `approval-page`, `host-prompt` or `trusted-client`. `decidedBy` names what answered: `client-dialog`, `approval-page`, `terminal-prompt` (the user's own channels, always with `personVerified: false`), or `client`, `agent`, `praxis`, `trusted-client`, `host-prompt`, `nobody`. No label claims a verified person. `confirmation=NO` is the agent's withdrawal, never the person's rejection. |
| G6 | Auditable, append-only corrections | Every request outcome is journaled outside the repository. Old misattributions are corrected by appended amendments that name the line and its hash. The person approves the amendments. No line is rewritten. |
| G7 | No retrying a known failure | A client version seen at least twice declining its dialog faster than any person (under 250 ms) is sent to the page directly. One fast answer never changes how a client is asked. At most 6 new approval pages open per minute, and an open request for the same action and text is reused. |

## Threats, mitigations, and what remains

| # | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| T1 | The agent says the user approved (`confirmation=YES`, approval-looking arguments, chat text) | G1: refused; undeclared arguments are refused outright | none through Praxis |
| T2 | An approval reused for different content, or replayed | G2, G3 | none known through Praxis. The binding is only as complete as each action's subject: every protected action's subject is built from the live state, and the Quality fix subject now includes the patch. |
| T3 | The client answers its own dialog: the Desktop Code tab's `decline` in milliseconds, or an `Elicitation` hook that auto-accepts | G4: recorded as `auto-answered` by the client; the page asks instead | a client that fakes a slow answer (a hook that sleeps, a malicious host) is believed: Praxis has to trust the client to show its own dialog |
| T4 | The agent opens or clicks the approval page through Praxis | The secret link goes from the Runtime to the browser through a short-lived file only the person's account can read. Results carry only the request id. The skills forbid opening it. | none through the approval tools; but see T17: Praxis runs repository code, which can read that file |
| T5 | **An agent operates the browser that shows the page** (Claude in Chrome controls the person's real Chrome: it can see the tab and click Approve) | Praxis cannot detect browser automation. Set *Browser for approval pages* (`PRAXIS_APPROVAL_BROWSER`) to a browser no agent controls (for example Safari when Claude in Chrome runs in Chrome). The page strips its secret from the address bar on load. The skills forbid it. | **real**: with automation connected to that browser, the page is consent only for an agent that follows its instructions. The Desktop Code tab's built-in browser pane is a separate browser and cannot reach the page without the link. |
| T6 | **An agent with a shell on the person's account** (Desktop Code tab, CLI) | none that holds against a determined agent | **real, and not specific to the page**: such an agent can read the short-lived link file or the browser's history, request the page with a forged `Origin` header (that check stops browsers, not `curl`), edit Praxis's state or code, or skip Praxis and run `git` or Jira itself. The client dialog does not stop this either. Praxis approval is a consent and workflow mechanism, not a security boundary against a program running as the person. |
| T7 | Another web page or local program posts a decision (CSRF, DNS rebinding) | `Host` must be `127.0.0.1:<port>` or `localhost:<port>`; `Origin` must be the page's own; a per-load token in a custom header (which forces a CORS preflight the server never grants); JSON only; a separate port from the review pages | a local program with the token: see T6 |
| T8 | Clickjacking: the page framed under something else | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | none known |
| T9 | Plan text that injects markup or script into the page | everything is escaped server-side; a CSP with a per-page script nonce; no inline handlers; no images or remote resources | none known |
| T10 | The secret leaks (now with tombstones: a used request stays until it expires, so a late browser sees "already approved there"; once the link has been used twice only Reject is taken; no decision is taken within 3 s of the first load, in time for the person's own browser load to reveal a racing opener; the decision must carry the binding cookie) | not in the process list (a file, not an argument), not in tool results or diagnostics; `Referrer-Policy: no-referrer`; stripped from the address bar after load. **The link is single-use**: its first load binds the page to that browser with an HttpOnly, `SameSite=Strict` cookie for that request (a reload uses it), so a copy from the browser's history or the hand-over file opens nothing later; the file is deleted after 15 s | an agent with a shell that reads the hand-over file and loads the link **before** the browser does holds the page. That race is not prevented, but it is detected: the person's tab says the page was "already opened somewhere else", the agent's result reports `linkUsedAgain`, and the decision's evidence says so (see T6) |
| T11 | An agent floods the person with pages (a retry loop, or calls in parallel) | G7: 6 new pages per minute; an open request for the same action is reused, including by calls that start at the same moment | the person may still be asked more than they like; the skills tell the agent not to loop |
| T12 | A misleading request (the content was written by the agent: a commit message, a story's text, a patch) | the page and the dialog show the action Praxis computed from the live state, never a summary written by the agent: the story or decision text, the patch of a Quality fix, the files and their hashes for a commit; anything too long to show in full is refused | a commit is identified by file names and content hashes, not shown as a diff; the person has to read what is shown |
| T13 | A look-alike page made by the agent | clicking it changes nothing in Praxis (it has no token); results come only from Praxis | the person may be misled about whether something ran; Praxis's result says what really happened |
| T14 | Earlier journal entries that blame the person | G6 amendments; v2 entries carry `decidedBy` and evidence | entries without timing are listed `unverified` and left as written |
| T15 | Someone edits the journal or the observations file | the journal is never read back as an authorization, and a reader applies an amendment only when its rule allows exactly that correction (a rejection can never be amended into an approval); the observations file can only switch a client between its dialog and the page | editing the observations file can move a client from its dialog to the page, which is the weaker channel when an agent controls the browser (T5); the journal is a record for an honest system, not tamper-proof storage (see T6) |
| T16 | Cowork runs the agent in a sandbox | a Runtime inside the sandbox cannot open a page in the person's browser: it answers `APPROVAL_CLIENT_UI_REQUIRED` (nothing runs, nobody rejected) | see [desktop-approvals.md](desktop-approvals.md) for which Cowork setup works |

| T17 | **Repository code that Praxis runs on the agent's behalf.** Quality checks and `.praxis/quality/adapter.mjs` run as the person, unsandboxed, during verification and some previews (`docs/workflow-stages.md`: "not a security boundary"). An agent that can only write files (Cowork's mounted folders, Chat with a file-writing extension) can write such code and have Praxis run it | the earliest-decision time and the single-use link below narrow the page race; nothing else in this design | **real, found by the second independent review and reproduced**: that code has a shell's power (T6). It can read the hand-over file, load the page first, and post Approve. In Chat and Cowork, "no shell" therefore holds only while the agent cannot write repository files that Praxis runs. Closing it needs project code run in an OS sandbox that cannot reach the page or the hand-over file, or user verification on the page (below). |
| T18 | **A repository sets the approval settings** through Claude Code: Claude Code applies the `env` block of a repository's `.claude/settings.json` to the MCP servers it starts. A repository could have switched on Trusted Client (`PRAXIS_APPROVAL_MODE=trusted-client`), sent the page to its own program (`PRAXIS_APPROVAL_BROWSER`), or set the answer-time rule to 0 | verified with Claude Code 2.1.314, then fixed: for a Runtime started by Claude Code (the Code tab, Cowork, the CLI), settings that weaken approval come only from `~/.praxis/approval-settings.json` in the account's real home (not `$HOME`; owned by the person; not group- or world-writable). Environment values of those names are ignored, and the doctor lists them. The Desktop extension takes them from its own settings, which a repository cannot reach. Settings that make approval stricter are taken from anywhere | **this affects the released alpha.48 to alpha.49.1**: a repository the person trusts could switch on Trusted Client there. `PRAXIS_STATE_HOME` can still be moved by a repository; it moves the journal (an audit record, never an authorization) |

## Comparing the channels honestly

| Channel | The agent cannot approve through Praxis | Holds against browser automation in the shown browser | Holds against a shell on the account | Label |
| --- | --- | --- | --- | --- |
| CLI approval dialog | yes | yes (it is not in a browser) | no | `client-ui` |
| Praxis approval page | yes | **no** (see T5) | no | `approval-page` |
| Review page Save | yes | no | no | trust `review-page` |
| Host permission prompt (opt-in) | no, if "always allow" is set | not applicable | no | `host-prompt` |
| Trusted Client (opt-in) | no: a standing permission | not applicable | no | `trusted-client` |

In the work item's approval records, an approval-page approval has the same trust class as a review-page Save (`review-page`): a person's click in a page the Runtime served on loopback and opened itself. It is never counted as `independent-human`, which is reserved for a client's own dialog.

## Review

An independent review of this design found that one click could approve two parallel calls, and that a page decision could be reused for a different text or a different Quality fix patch with the same subject. It also found that a mixed call could mislabel a host-prompt approval as a page approval, and that one fast answer from a person could change how their client is asked from then on. All of these are fixed and covered by `desktop-approval.test.ts`; G2, G3, G4 and G7 above describe the behaviour as fixed.

A second independent review re-checked those fixes (all fixed or, for the amendment reader, completed afterwards) and found T17 and T18, the earlier claim that Chat cannot reach the page, and smaller issues: a browser name that cannot be honoured outside macOS, an amendment applied to the wrong kind of entry, a page decision with no minimum time, two Jira writes approved by fingerprint only, and wording that still named a person. All are fixed or stated here.

## What would be stronger (not implemented here)

- **User verification on the page** (WebAuthn with a platform authenticator: Touch ID, Windows Hello). Browser automation cannot pass it, which closes T5. It does not close T6, because an agent with a shell can still change Praxis or bypass it. Praxis removed a WebAuthn-based approval service earlier, and adding this back is a product decision.
- **Project code in an OS sandbox** (Seatbelt on macOS, namespaces on Linux) with no access to the hand-over file or loopback, killed with its whole process tree. This closes T17 for the page.
- **A separate trust domain**: a different OS account, or a hosted approval service the agent's account cannot reach. Only this closes T6.
