# Praxis 0.1.0-alpha.49: owner decisions (state 2026-10-29, after round 14)

Heads: core code `7e4fe59` (plus documents-only commits on top), runtime `13c3cba`, ba `a2d6916`, architect `84c5378`, developer `2014cfe`, quality `0e24520`, marketplace `bd5ecc7`; all `0.1.0-alpha.49`, branch `feature/ux-overhaul`, working trees clean, nothing pushed, tagged, merged or published.

## Accepted (closed)

| Decision | Applied |
|---|---|
| Apache-2.0 is cleared for publication | LICENSE/NOTICE everywhere, licence fields Apache-2.0 |
| Copyright stays `2026 dfuture-co` until the official legal name is given | NOTICE unchanged |
| Git history, old GitHub Releases, vendor archives, the corporate dataset in earlier releases: not touched | alpha.49 excludes the dataset; residual risk recorded: internal process information stays publicly available in earlier releases and history |
| `owner.name: Praxis` stays | unchanged |
| `sql-wasm.wasm`: Emscripten and musl notices | added to the Runtime THIRD-PARTY-NOTICES (repo, plugin, stage, MCPB); gate enforces them |

## Open: only the release itself

| # | Item | Status |
|---|---|---|
| 1 | The go for merge (ba, quality, developer, architect, core, runtime, marketplace), tags `v0.1.0-alpha.49`, five GitHub Releases, Marketplace push | waits for your separate command; commands and rollback in `RELEASE-CHECKLIST-alpha.49.md` D-F |
| 2 | Optional: a real person's Reject in the Claude Code dialog (H3) | NOT VERIFIED; the automated negative control passed (it is not a human refusal). To close it: commands below. Otherwise the release notes list it as NOT VERIFIED |
| 3 | Optional: the official legal name for NOTICE | when known: one line in 18 NOTICE copies, rebuild archives, restage, verify |

## Real remaining limits (no decision needed)

- Real-client Reject, Claude Desktop Code/GUI and Chat dialogs, live Jira, Linux, Windows: NOT VERIFIED; APR-0002 INCONCLUSIVE.
- `sql-wasm.wasm`: the contrib file `extension-functions.c` inside the unmodified upstream binary has no licence text (unused by Praxis); the Emscripten build toolchain is not provable from the binary.
- Quality runner: no OS sandbox for project code, trusted projects only; browser checks need an operator-installed Playwright; the lab's 31/31 is not strong proof of every criterion (backlog in `QUALITY-BACKLOG.md`); deferred S5, S6, S14, RD2, P3.
- Pattern-based content gate, no secret scanner, no legal clearance.

## Real-client Reject check (optional, 5 minutes)

```bash
cd <praxis-split>/release/ux-overhaul/manual-lab && PRAXIS_APPROVAL_COPY=$HOME/praxis-alpha49-h3-copy ./start-alpha49.sh approval
```

In the Claude session: (1) `Измени в US-ORD-004 формулировку любого шага на эквивалентную (update-story), покажи preview и применяй после моего подтверждения.` (2) `Подтверди US-ORD-004 (confirm-story): preview, показать, дальше apply.` and press **Reject**. Then outside Claude: `node h3-check.mjs`. PASS: `US-ORD-004` stays `proposed` with the same revision, `approvals[]: 0`. If no dialog appears but a record is created, report it as it is.
