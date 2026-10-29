# Compatibility and migration report

Baseline: 0.1.0-alpha.48 (Core `0f71e38`, Runtime `d55ed5b`, role plugins at their alpha.48 heads, Marketplace `3c0ab03`).
This work: local branches `feature/ux-overhaul` in every repository. Nothing is published, tagged or merged.

## Contract

| Item | alpha.48 | This work |
| --- | --- | --- |
| `praxis.workflow.state` version | 1.0.0 | 1.1.0 (accepts 1.0.0 and 1.1.0: `SUPPORTED_WORKFLOW_VERSIONS`) |
| Handoff contract version | 1.0.0 | accepts 1.0.0 and 1.1.0 |
| Ids (REQ, US, WI, DEC, service ids) | stable | unchanged; new `RepositoryId` shared in `ids.ts` |
| Approval model | Approval Required / Trusted Client / host-permission | unchanged; one new personal act `review-decisions` (excluded from Trusted Client like the other personal acts) |
| MCP tools | 52 | 59 (seven added, none renamed or removed) |
| MCP servers | one (`praxis-runtime`) | one |

## What a 1.0.0 work item looks like to the new Runtime

Verified by `S16` of the acceptance script, which creates the work item with the real alpha.48 Runtime bundle (git `d55ed5b`) and then opens it with the new one:

- Read without rewriting: the file on disk is byte-identical after `praxis_workflow_status`.
- Opens in `classic` mode: stages are recorded, nothing new is enforced; stories can still be added without a plan.
- Every requirement is `in` scope; criteria of requirements that were already approved read as accepted (`via: system`), the others pending.
- Ids are unchanged (`REQ-LEG-001`, `US-LEG-001`, `DEC-LEG-1`).
- The first write migrates the file to 1.1.0 and keeps the original next to it as `<id>.json.v1.0.0.bak`, byte-identical to what alpha.48 wrote.
- The old inspect tool and the old commands keep working on the migrated item.

`planning-tools.test.ts` ("state written by alpha.48") repeats this with a hand-built 1.0.0 file; `planning.test.ts` tests the pure migration.

## Behaviour changes a user can notice

1. New work items default to `guided` mode: `add-story` is refused before an agreed story plan, and `advance-phase` enforces gates. Old items and `mode: "classic"` are unaffected.
2. `accept-requirements`, criterion marks, `accept-prototype`, `agree-story-plan`, `review-stories`, `accept-stories` are refused through `praxis_workflow_apply` (`USER_DECISION_REQUIRED`). A skill or script that used `accept-*` from the agent side must use the review page or `praxis_review_apply`. (These commands did not exist in alpha.48, so no alpha.48 flow breaks.)
3. `praxis_workflow_status` and `praxis_session_start` return more fields (`phase`, `mode`, `next`, `briefing`, `resume`); existing fields are unchanged.
4. Core errors raised by workflow commands now keep their own code (`PHASE_GATE`, `STORY_PLAN_NOT_AGREED`, ...) where they used to be reported as `INVALID_INPUT`.
5. `add-story` accepts `title`, `capabilities`, `screenRefs`, `repositoryIds` (optional).

## Persisted-state hazard found and fixed

The store's secret redaction rewrote any key containing `token` to `"[redacted]"`. The first design of the prototype used `tokens` for design tokens and `tokensFound` for the inspection; both would have been persisted as strings and made the state unreadable. Renamed to `styles` / `hasStyles`; `persistence.test.ts` round-trips every planning artifact through the redaction.

## Marketplace

`marketplace-install-acceptance` (clean clone, throwaway `CLAUDE_CONFIG_DIR`, Claude Code CLI 2.1.304): installing `praxis` installs the five dependencies; exactly one MCP server; the installed Runtime lists 59 tools and answers `praxis_doctor`; Approval Required refuses a write with no dialog; Trusted Client (explicit) writes; single-role install pulls only the Runtime; generated outputs present; no developer path shipped. The in-place *upgrade* step was not run: the plugin version is still 0.1.0-alpha.48 in both the old and the new marketplace revision, so `claude plugin update` correctly reports "already at the latest version". It needs a version bump, which belongs to the release step.

## Not verified here

See `USER-CHECKS.md`.

## Upgrade and rollback check on the alpha.49 candidate (2026-10-29)

`marketplace-install-acceptance.mjs --previous 3c0ab03` (throwaway `CLAUDE_CONFIG_DIR`, Claude Code CLI 2.1.304, marketplace cloned from the committed branch): installing `praxis` brings the five components at 0.1.0-alpha.49, one MCP server, the Runtime lists 61 tools and answers `praxis_doctor`; Approval Required refuses without a dialog; Trusted Client writes only by explicit opt-in; a single-role install pulls only the Runtime; **an install of alpha.48 (marketplace `3c0ab03`) updates in place to alpha.49** for praxis-ba and praxis-runtime. This supersedes the earlier remark that the upgrade step was not run for lack of a version bump. Rollback: after `marketplace update` against the old revision, `plugin uninstall` and `plugin install` of praxis-runtime gives 0.1.0-alpha.48 again. Work Item data upgrade (1.0.0 to 1.1.0 with `.v1.0.0.bak`) is covered by scenario S16 and `planning-tools.test.ts`. Not run: the Claude UI flow and Desktop Chat upgrade over the alpha.48 extension.
