---
name: read-feature-statuses
description: "Read-only: return a feature's status and linked issue statuses from Jira Server without a confirm gate (WBS 3.9)."
---

# read-feature-statuses

Read statuses for a feature and its linked issues via `JiraClient.readFeatureStatuses`. **No mutation confirm** — GET only (WBS `3.9.1`).

## When to use

- BA/Architect/Developer asks “what’s the tracker state of this feature?”
- After `confirm-write-package` to verify created links appear.
- Connection sanity beyond `verify-connection` when issue data is needed.

Also referred to as the **read-statuses** capability for the feature subgraph.

## Config (Jira Server)

| Env | Required |
|-----|----------|
| `PRAXIS_JIRA_BASE_URL` | yes |
| `PRAXIS_JIRA_TOKEN` | yes |
| `PRAXIS_JIRA_PROJECT_KEY` | yes (client config; not required on this GET path beyond auth) |

## REST assumptions

```http
GET /rest/api/2/issue/{featureKey}?fields=status,issuelinks
Authorization: Bearer <token>
Accept: application/json
```

Server `/rest/api/2` issue payload: `fields.status.name`, `fields.issuelinks[]` with `type.name` and inward/outward issue + nested `fields.status.name`.

## Steps

1. Load config; construct `JiraClient`.
2. Call `readFeatureStatuses(featureKey)`.
3. Return structured result:

   ```ts
   {
     key: string
     status: string
     linked: { key: string; status: string; type: string }[]
   }
   ```

4. Present a compact table to the human (feature row + linked rows). No writes.

## Confirm gate

**None.** Read-only. Do not wrap in `confirmAndExecute`.

## Done when

- Structured statuses returned for the feature and each linked issue, or a clear HTTP/error message.
- Tracker unchanged.

## Failure modes

| Mode | Response |
|------|----------|
| 404 / unknown key | Surface error; do not invent statuses |
| Empty issuelinks | Valid — return `linked: []` |
| Treating this as a write skill | Incorrect — no preview/confirm |
| Cloud changelog-only APIs | Not used; stick to v2 issue fields |
