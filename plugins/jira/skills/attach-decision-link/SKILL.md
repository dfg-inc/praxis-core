---
name: attach-decision-link
description: Preview and attach an architecture-decision file link as a Jira comment only after human confirm (WBS 3.7).
---

# attach-decision-link

Attach a stable reference to an ADR file on a tracker issue via `JiraClient.attachDecisionLink` (comment body). Confirm gate mandatory. Supports revision stamp so the link stays meaningful later (WBS 3.7).

## When to use

- After `record-decision` produced `architecture/decisions/ADR-*.md`.
- When a feature/story must point at the binding rule file.
- Prefer including this step in `confirm-write-package` when shipping tracker + ADR together.

## Config (Jira Server)

`PRAXIS_JIRA_BASE_URL`, `PRAXIS_JIRA_TOKEN`, `PRAXIS_JIRA_PROJECT_KEY`.

## REST assumptions

```http
POST /rest/api/2/issue/{issueKey}/comment
{ "body": "Architecture decision: <decisionPath>[@<revision>]" }
```

Plain-text comment body (Server v2). Revision should be a git SHA or tag that pins the file edition.

## Preview package

`attachDecisionLinkPreview` → show issue key, `decisionPath`, optional `revision`, exact comment string. Human verifies path is repo-relative and revision pins the intended edition.

## Confirm gate

1. Build preview.
2. Show full package (comment text as it will land).
3. `confirmAndExecute` on approve only.
4. Reject → no comment created.

## Inputs

- `issueKey` (required)
- `decisionPath` (required; e.g. `architecture/decisions/ADR-001-….md`)
- `revision` (optional; appended as `@sha`)

## Done when

- Comment created after approve with path (+ revision); or no write on reject.
- Month-later navigation still targets the same edition when revision was set.

## Failure modes

| Mode | Response |
|------|----------|
| Path without revision on critical ADR | Warn; prefer adding git SHA |
| Write without confirm | **Forbidden** |
| Using remote Confluence instead of repo path | Out of scope — this skill comments the git path |
| ADF Cloud comment format | Not used — Server string body |
