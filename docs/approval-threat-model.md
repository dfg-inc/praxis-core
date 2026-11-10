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
| Shell on the person's account | no, unless an installed extension gives one | **yes** | a shell in the Cowork sandbox; your folders are mounted into it | **yes** |
| Browser automation | only with Claude in Chrome connected (it operates the person's real Chrome) | built-in browser pane (a separate browser), and Claude in Chrome if connected | Claude in Chrome if connected | only if configured |
| How Praxis asks | approval page | approval page (its dialog answers by itself) | approval page if the Runtime runs on the person's computer; otherwise nothing runs | the CLI's approval dialog |

## What Praxis enforces

| # | Guarantee | How |
| --- | --- | --- |
| G1 | The agent cannot approve through Praxis's interface | An approval is created only from a channel's answer: the client's protocol response, a click in the page, or the CLI's terminal prompt. Tool arguments, command fields, files and chat text never become one. Approvals are objects only `user-approval.ts` issues (a `WeakSet`), so parsed JSON cannot pass for one. |
| G2 | An approval binds one action and its exact content | The subject digest is computed from the live state when the action runs. A changed plan has a different digest: the old approval does not verify and the person is asked again. The preview fingerprint is checked before anyone is asked. |
| G3 | Fresh and used once | An answer is usable for 10 minutes. A page decision is used once. An undecided page request expires after 10 minutes and is journaled as `expired`. |
| G4 | Instant answers are not the person's | A dialog answer that arrives faster than `PRAXIS_APPROVAL_MIN_ANSWER_MS` (1000 ms) is the client's own, `accept` included. An answer for a dialog this Runtime never asked for is ignored. |
| G5 | Honest labels | `assurance` is `client-ui`, `approval-page`, `host-prompt` or `trusted-client`; `decidedBy` is `user`, `client`, `agent`, `praxis` or `nobody`. `confirmation=NO` is the agent's withdrawal, never the person's rejection. |
| G6 | Auditable, append-only corrections | Every request outcome is journaled outside the repository. Old misattributions are corrected by appended amendments that name the line and its hash. The person approves the amendments. No line is rewritten. |
| G7 | No retrying a known failure | A client version seen answering its dialog by itself is sent to the page directly. At most 6 new approval pages open per minute, and an open request is reused. |

## Threats, mitigations, and what remains

| # | Threat | Mitigation | Residual risk |
| --- | --- | --- | --- |
| T1 | The agent says the user approved (`confirmation=YES`, approval-looking arguments, chat text) | G1: refused; undeclared arguments are refused outright | none through Praxis |
| T2 | An approval reused for different content, or replayed | G2, G3 | none through Praxis |
| T3 | The client answers its own dialog: the Desktop Code tab's `decline` in milliseconds, or an `Elicitation` hook that auto-accepts | G4: recorded as `auto-answered` by the client; the page asks instead | a client that fakes a slow answer (a hook that sleeps, a malicious host) is believed: Praxis has to trust the client to show its own dialog |
| T4 | The agent opens or clicks the approval page through Praxis | The secret link goes from the Runtime to the browser through a short-lived file only the person can read. Results carry only the request id. The skills forbid opening it. | none through Praxis's tools |
| T5 | **An agent operates the browser that shows the page** (Claude in Chrome controls the person's real Chrome: it can see the tab and click Approve) | Praxis cannot detect browser automation. Set *Browser for approval pages* (`PRAXIS_APPROVAL_BROWSER`) to a browser no agent controls (for example Safari when Claude in Chrome runs in Chrome). The page strips its secret from the address bar on load. The skills forbid it. | **real**: with automation connected to that browser, the page is consent only for an agent that follows its instructions. The Desktop Code tab's built-in browser pane is a separate browser and cannot reach the page without the link. |
| T6 | **An agent with a shell on the person's account** (Desktop Code tab, CLI) | none that holds against a determined agent | **real, and not specific to the page**: such an agent can read the short-lived link file or the browser's history, request the page with a forged `Origin` header (that check stops browsers, not `curl`), edit Praxis's state or code, or skip Praxis and run `git` or Jira itself. The client dialog does not stop this either. Praxis approval is a consent and workflow mechanism, not a security boundary against a program running as the person. |
| T7 | Another web page or local program posts a decision (CSRF, DNS rebinding) | `Host` must be `127.0.0.1:<port>` or `localhost:<port>`; `Origin` must be the page's own; a per-load token in a custom header (which forces a CORS preflight the server never grants); JSON only; a separate port from the review pages | a local program with the token: see T6 |
| T8 | Clickjacking: the page framed under something else | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | none known |
| T9 | Plan text that injects markup or script into the page | everything is escaped server-side; a CSP with a per-page script nonce; no inline handlers; no images or remote resources | none known |
| T10 | The secret leaks | not in the process list (a file, not an argument), not in tool results or diagnostics; `Referrer-Policy: no-referrer`; stripped from the address bar after load (a reload of the same tab still works); the file is deleted after 15 s | see T5 and T6 |
| T11 | An agent floods the person with pages (a retry loop) | G7: 6 new pages per minute, and an open request for the same action is reused | the person may still be asked more than they like; the skills tell the agent not to loop |
| T12 | A misleading request (the content was written by the agent: a commit message, a story's text) | the page and the dialog show the full, exact content Praxis will act on, never a summary written by the agent; anything too long to show in full is refused | the person has to read it |
| T13 | A look-alike page made by the agent | clicking it changes nothing in Praxis (it has no token); results come only from Praxis | the person may be misled about whether something ran; Praxis's result says what really happened |
| T14 | Earlier journal entries that blame the person | G6 amendments; v2 entries carry `decidedBy` and evidence | entries without timing are listed `unverified` and left as written |
| T15 | Someone edits the journal or the observations file | the journal is never read back as an authorization; the observations file can only make Praxis use the page instead of a dialog | the journal is a record for an honest system, not tamper-proof storage (see T6) |
| T16 | Cowork runs the agent in a sandbox | a Runtime inside the sandbox cannot open a page in the person's browser: it answers `APPROVAL_CLIENT_UI_REQUIRED` (nothing runs, nobody rejected) | see [desktop-approvals.md](desktop-approvals.md) for which Cowork setup works |

## Comparing the channels honestly

| Channel | The agent cannot approve through Praxis | Holds against browser automation in the shown browser | Holds against a shell on the account | Label |
| --- | --- | --- | --- | --- |
| CLI approval dialog | yes | yes (it is not in a browser) | no | `client-ui` |
| Praxis approval page | yes | **no** (see T5) | no | `approval-page` |
| Review page Save | yes | no | no | trust `review-page` |
| Host permission prompt (opt-in) | no, if "always allow" is set | not applicable | no | `host-prompt` |
| Trusted Client (opt-in) | no: a standing permission | not applicable | no | `trusted-client` |

In the work item's approval records, an approval-page approval has the same trust class as a review-page Save (`review-page`): a person's click in a page the Runtime served on loopback and opened itself. It is never counted as `independent-human`, which is reserved for a client's own dialog.

## What would be stronger (not implemented here)

- **User verification on the page** (WebAuthn with a platform authenticator: Touch ID, Windows Hello). Browser automation cannot pass it, which closes T5. It does not close T6, because an agent with a shell can still change Praxis or bypass it. Praxis removed a WebAuthn-based approval service earlier, and adding this back is a product decision.
- **A separate trust domain**: a different OS account, or a hosted approval service the agent's account cannot reach. Only this closes T6.
