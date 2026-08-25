---
name: verify-connection
description: Verify Jira Server connection with GET /rest/api/2/myself using env config (read-only).
---

# verify-connection

Smoke-check that env credentials reach Jira Server. Wraps `JiraClient.verifyConnection`.

## When to use

- Before any mutation package session.
- When writes fail with auth errors — confirm token/base URL first.
- Onboarding a new shell / CI secret set.

## Config (Jira Server)

| Env | Required | Notes |
|-----|----------|-------|
| `PRAXIS_JIRA_BASE_URL` | yes | No trailing slash |
| `PRAXIS_JIRA_TOKEN` | yes | Bearer |
| `PRAXIS_JIRA_PROJECT_KEY` | yes | Loaded with client even if unused here |

## REST assumptions

```http
GET /rest/api/2/myself
Authorization: Bearer <token>
Accept: application/json
```

Success → `{ ok: true, displayName?: string }` from Server user payload. Non-OK HTTP → thrown error with status.

## Confirm gate

**None.** Read-only — no `MutationPreview`, no `confirmAndExecute`.

## Steps

1. `loadJiraConfig` / construct client (fail fast on missing env).
2. `await client.verifyConnection()`.
3. Report `ok` + `displayName` to the human.
4. On failure: show HTTP status; do not retry with alternate guessed URLs.

## Done when

- Clear ok + identity, or clear error — enough to know whether mutation skills can proceed.

## Failure modes

| Mode | Response |
|------|----------|
| Missing env | Fail at config load |
| Cloud-only `/rest/api/3/myself` | Not used — Server v2 path |
| Logging raw token | **Forbidden** |
| Treating success as project-key validation | Project key is not checked here; use a read/create preview next |
