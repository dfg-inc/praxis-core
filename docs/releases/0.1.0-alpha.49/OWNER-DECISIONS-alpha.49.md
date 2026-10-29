# Praxis 0.1.0-alpha.49: owner decisions (state 2026-10-29)

The release candidate is built, verified and committed locally; nothing is published. These decisions are open. None changes the build unless stated. The release itself needs your separate go.

Heads: core code `5e78f55` (plus documents-only commits on top), runtime `c796606`, ba `a2d6916`, architect `84c5378`, developer `2014cfe`, quality `0e24520`, marketplace `67f252d`; all `0.1.0-alpha.49`, branch `feature/ux-overhaul`, working trees clean.

| # | Decision | Options | Engineering view |
|---|---|---|---|
| 1 | The 8 `company/**` files are already public: `dfg-inc/praxis-core` master and history (since `823369b`), release asset `praxis-knowledge-0.1.0-alpha.47.tgz` (12,269 bytes, 2 downloads), `vendor/praxis-knowledge-0.1.0-alpha.48.tgz` on five public masters | (a) leave: the content is general process rules (PROVENANCE-AUDIT, round 13 A); (b) delete only the alpha.47 release asset; (c) rewrite history of six repositories and force-push; (d) make the repositories private meanwhile | (a) or (b) are proportionate if legal agrees; (c) and (d) are disruptive (old SHAs, tags and clones, forks 0, 52 stars). None was done. A legal conclusion is not given here. |
| 2 | Legal name behind `Copyright 2026 dfuture-co` | (a) keep as is; (b) give the official name: one-line change in 18 NOTICE copies, rebuild the archives, restage | (a) is valid; (b) is a small content change with a re-verify |
| 3 | The corporate Apache-2.0 grant covers all material created since 2026-08-25 (Jira integration, prompts, skills, the Runtime) | confirmed by the rights holder or legal; or name exceptions | no third-party origin was found; only the rights holder can confirm |
| 4 | `sql-wasm.wasm`: bytes are the unmodified upstream `sql.js@1.14.2`; it contains SQLite 3.49.1 (public domain) and the unlicensed contrib file `extension-functions.c` (not used by Praxis); Emscripten/musl notice is missing | (a) accept the inherited risk and document it (current state); (b) add Emscripten (MIT/UIUC) and musl (MIT) notices to the Runtime `THIRD-PARTY-NOTICES.md`: notice-only change, rebuild MCPB, restage; (c) ask upstream for a licence statement; (d) build a Praxis-owned wasm without the extension; (e) later switch to the official SQLite wasm | (b) is cheap and recommended with (a); (d) and (e) are not needed for alpha.49 |
| 5 | Marketplace `owner.name` is "Praxis" (every `author` is `dfuture-co`) | keep (marketplace owner); change to `dfuture-co` | cosmetic; one file |
| 6 | **Scenario H3 with Reject is still OPEN.** APR-0002 (`confirm-story` US-ORD-001 through the client dialog) stays INCONCLUSIVE: neither a human action nor a defect is proven. The Desktop Code/GUI dialog is NOT VERIFIED | (a) run H3 now (needs your click, 5 minutes, commands below); (b) publish with H3 and the Desktop/GUI dialog listed as NOT VERIFIED | (a) is the only way to close it |
| 7 | The release itself | after 1-6: merge order (ba, quality, developer, architect, core, runtime, marketplace), tags `v0.1.0-alpha.49`, five GitHub Releases (Releases alpha.45-48 already exist), Marketplace push, pre-release flag | checklist: `RELEASE-CHECKLIST-alpha.49.md`, sections D-F (commands and rollback, not run) |

Already decided and applied (no action): Apache-2.0; dataset removed from every package and from the Core tree; `grill-cr` MIT attribution (Matt Pocock); `author` dfuture-co and the personal e-mail removed; no developer paths or internal hosts in packages, messages, tests and public documents; archive-content gate in `npm run verify`.

## H3 with Reject (decision 6a)

```bash
cd <praxis-split>/release/ux-overhaul/manual-lab && PRAXIS_APPROVAL_COPY=$HOME/praxis-alpha49-h3-copy ./start-alpha49.sh approval
```

In the Claude session: (1) `Измени в US-ORD-004 формулировку любого шага на эквивалентную (update-story), покажи preview и применяй после моего подтверждения.` (2) `Подтверди US-ORD-004 (confirm-story): preview, показать, дальше apply.` and press **Reject** in the dialog. Then, outside Claude: `node h3-check.mjs`. PASS: `US-ORD-004` stays `proposed` with the same revision, `approvals[]: 0`. If no dialog appears but a record is created, report it as it is.
