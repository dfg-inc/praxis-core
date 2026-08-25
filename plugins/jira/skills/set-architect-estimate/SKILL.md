---
name: set-architect-estimate
description: Preview and set architect estimate custom field on a Jira issue only after human confirm.
---

# set-architect-estimate

Write the architect estimate custom field via `JiraClient.setArchitectEstimate`. Confirm gate mandatory.

## When to use

- After `initial-estimate` (Architect) when tracker should carry hours/points.
- Inside `confirm-write-package` with other mutations.

## Config (Jira Server)

| Env / config | Notes |
|--------------|-------|
| `PRAXIS_JIRA_BASE_URL` / `TOKEN` / `PROJECT_KEY` | Required |
| `architectEstimateFieldId` on client config | Default `customfield_architect_estimate` — **replace with real Server customfield id** |

## REST assumptions

```http
PUT /rest/api/2/issue/{issueKey}
{ "fields": { "<customfield_id>": <estimate> } }
```

Field type must match instance config (number vs string). Wrong type → HTTP 400 from Server.

## Preview package

Show issue key, field id, estimate value, full PUT body. Human confirms the field id is the Architect estimate field (not Story Points unless intentionally aliased).

## Confirm gate

1. `setArchitectEstimatePreview`.
2. Full package to human.
3. `confirmAndExecute` only on approve.
4. Reject → no write.

## Inputs

- `issueKey` (required)
- `estimate` (string | number)

## Done when

- Field set after approve, or unchanged on reject.
- Preview disclosed real `customfield_*` id used.

## Failure modes

| Mode | Response |
|------|----------|
| Placeholder field id on production | Configure real id before approve |
| Write without confirm | **Forbidden** |
| Confusing with sprint estimate fields | Name field explicitly in preview summary |
