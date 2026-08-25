---
name: set-fix-version
description: Preview and set Fix Version on a Jira issue only after human confirm — PUT /rest/api/2/issue/{key}.
---

# set-fix-version

Set `fixVersions` on an issue via `JiraClient.setFixVersion`. Mutation confirm required.

## When to use

- After create when the delivery version is known.
- As a step inside `confirm-write-package` with feature/stories.

## Config (Jira Server)

`PRAXIS_JIRA_BASE_URL`, `PRAXIS_JIRA_TOKEN`, `PRAXIS_JIRA_PROJECT_KEY`.

## REST assumptions

```http
PUT /rest/api/2/issue/{issueKey}
{ "fields": { "fixVersions": [{ "name": "<version>" }] } }
```

Version **name** must already exist on the Server project (client does not auto-create versions in Phase 1).

## Preview package

`setFixVersionPreview` → show issue key, version name, full PUT body. Human must see that other fixVersions are replaced by this field set as sent (array replace semantics per Server).

## Confirm gate

1. Preview.
2. Human approve/reject.
3. Execute only via `confirmAndExecute`.
4. Reject → no PUT.

## Inputs

- `issueKey` (required)
- `fixVersion` (required name string)

## Done when

- Version field updated after approve, or no write on reject.

## Failure modes

| Mode | Response |
|------|----------|
| Unknown version name | Server error — create version in UI/admin first |
| Write without confirm | **Forbidden** |
| Assuming Cloud version APIs | Stick to issue field PUT v2 |
| Silent overwrite of multiple fix versions | Show body so human sees replace array |
