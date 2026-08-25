---
name: link-issues
description: Preview and link two Jira issues (Relates by default) only after human confirm — Server REST /rest/api/2/issueLink.
---

# link-issues

Create an issue link via `JiraClient.linkIssues`. Default link type `Relates`. Confirm gate mandatory.

## When to use

- After feature/stories exist and need explicit links.
- Inside `confirm-write-package` as one mutation step (prefer package-level confirm when batched).

## Config (Jira Server)

`PRAXIS_JIRA_BASE_URL`, `PRAXIS_JIRA_TOKEN`, `PRAXIS_JIRA_PROJECT_KEY`.

## REST assumptions

```http
POST /rest/api/2/issueLink
{
  "type": { "name": "Relates" },
  "inwardIssue": { "key": "…" },
  "outwardIssue": { "key": "…" }
}
```

Link type names are instance-specific; override with `linkType` when `Relates` is absent.

## Preview package

`linkIssuesPreview` → `MutationPreview` with method `POST`, path `/rest/api/2/issueLink`, full body. Show both keys + type to the human.

## Confirm gate

1. Build preview (`inwardKey`, `outwardKey`, optional `linkType`).
2. Show full package.
3. `confirmAndExecute` on approve only.
4. Reject → no write (204/empty success path never hit).

## Done when

- Approved link created, or reject with zero writes.
- Keys remain valid references for `read-feature-statuses`.

## Failure modes

| Mode | Response |
|------|----------|
| Unknown link type name | Surface Server error; adjust `linkType` |
| Write without confirm | **Forbidden** |
| Linking before creates in an atomic package without placeholders | Use `confirm-write-package` ordering |
| Sub-task creation disguised as link | Out of scope — this skill only issueLink |
