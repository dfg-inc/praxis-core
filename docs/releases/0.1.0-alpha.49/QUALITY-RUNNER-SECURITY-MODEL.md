# Quality runner: security model (alpha.49 RC)

Scope: `verify-stories` in the Praxis Runtime, with executable checks from the project (`.praxis/quality/checks.json`, optional `adapter.mjs`) and the browser driver (`level: browser`). Each line says whether it is **CONFIRMED** (tested here), **BY DESIGN** (implemented, not independently attacked) or **NOT CONFIRMED / RISK**. Nothing here says the runner is safe for untrusted projects: it is not.

## 1. Trust model
- **The project under test is trusted code.** Adapter modules, check modules and the project's build run **as the same OS user as the Runtime, with no OS-level sandbox** (no container, no seccomp, no chroot, no separate user). They can read and write what the user can, use the network and read the user's environment of their own process. NOT SANDBOXED. Run Quality only on projects the operator trusts, preferably in a dedicated user or machine for third-party code.
- Praxis does not execute project code to check PASS claims through an agent: PASS comes only from the Runtime's own execution (`executed` / `browser` sources); `agent` or no source is "attested" and never counts as PASS.

## 2. Browser driver (`level: browser`)
| Property | Status |
|---|---|
| Praxis-owned detached process with a scrubbed environment (no MCP secrets passed; env is never printed) | CONFIRMED (tests, review) |
| Playwright loaded only from the operator's `PRAXIS_PLAYWRIGHT_DIR`; a Playwright inside the project is refused | CONFIRMED |
| Chromium sandbox on (no `--no-sandbox`) | CONFIRMED |
| Page served from a private snapshot of the built bundle on a loopback static server; no dot-files, no symlinks; limits 5000 entries / 200 MB; a root equal to the service directory is refused | CONFIRMED (tests) |
| External HTTP and WebSocket blocked by route rules; host resolver maps everything except 127.0.0.1 to NOTFOUND; WebRTC restricted | CONFIRMED for HTTP, WebSocket, preconnect, WebRTC UDP and a TCP LAN listener (tests received nothing) |
| DNS exfiltration channel | **NOT TESTED** |
| Time limit 240 s; the driver and Chromium are swept on timeout and when the parent dies; temp directory removed | CONFIRMED (parent SIGKILL test) |
| Memory and disk caps for a hostile page | **NONE.** Only the time limit bounds a hostile page. |
| Artifacts written with exclusive create (`wx`), symlink-safe | CONFIRMED |

## 3. `PRAXIS_PLAYWRIGHT_DIR` requirements
- An operator-owned directory outside any project under test (default `~/.praxis/quality-browser`), created by `node praxis-runtime/tools/scripts/setup-quality-browser.mjs` (pinned `playwright-core 1.64.1`, `--ignore-scripts`).
- **Must be read-only for the user that runs untrusted project code** (a project that can write there can replace Playwright and run code in the driver). Not enforced by Praxis: NOT ENFORCED, operator responsibility.
- The two variables belong in the Runtime server's own environment (operator settings), never in the project. Without them a browser check is BLOCKED with the reason, never PASS.

## 4. Network and resource limits (summary)
Network: the page cannot reach the LAN or the internet (see table); the project's adapter/check code and the build are **not** network-restricted. Resources: 240 s wall time; no CPU/memory/disk quota; screenshots and results are size-limited per artifact only.

## 5. Other residual risks
- The one-time review link file in TMPDIR is readable by a same-user process for about 15 s.
- Trusted Client is a standing permission (`host-attested`), never a human approval.
- `independent-human` means the client returned Approve to its own dialog; the person is not identified (`actor` empty). H3 of the alpha.49 manual run left an unexplained client approval (APR-0002); the controlled retest is recorded in FINAL-REPORT round 10.
- Evidence binds to the built bundle, not to `src/`; a stale `dist` still reads as current until rebuilt.
- Windows and Linux: **NOT VERIFIED** (macOS arm64, Node 24, Chrome 156 only).
