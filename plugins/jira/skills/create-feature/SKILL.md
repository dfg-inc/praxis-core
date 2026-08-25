---
name: create-feature
description: Preview and create a New Feature on Jira Server only after human confirm (WBS 3.x). Uses REST /rest/api/2/issue.
---

# create-feature

Create a **New Feature** issue via `@praxis/jira` `JiraClient.createFeature`. Every write is gated: build preview → show package → `confirmAndExecute` only on explicit approve.

## When to use

- Architect/BA decomposition produced a feature to track.
- Part of an atomic multi-issue package → prefer `confirm-write-package` instead of calling this alone.

## Config (Jira Server)

| Env | Required | Notes |
|-----|----------|-------|
| `PRAXIS_JIRA_BASE_URL` | yes | No trailing slash |
| `PRAXIS_JIRA_TOKEN` | yes | Bearer / PAT |
| `PRAXIS_JIRA_PROJECT_KEY` | yes | Default project |

Assumes **Jira Server / Data Center** REST style: `POST /rest/api/2/issue` (not Cloud v3-only fields unless configured).

## Preview package (must show human)

From `createFeaturePreview`:

- `method`: `POST`
- `path`: `/rest/api/2/issue`
- `body.fields`: `project.key`, `summary`, `description`, `issuetype.name` (default `"New Feature"`)

Display the full `MutationPreview` (`id`, `summary`, `method`, `path`, `body`) — not a one-line paraphrase.

## Confirm gate

1. Build preview via `client.createFeaturePreview(input)` or `createFeature`’s internal preview.
2. Show the **entire** change package to the human (AskUserQuestion / confirmer callback).
3. Execute **only** through `confirmAndExecute(preview, confirmer, execute)`.
4. On reject → `{ executed: false }`; **zero** HTTP writes.
5. On approve → POST issue; return `{ executed: true, result: { key } }`.

Never call `requestJson` for create outside that gate.

## Inputs

- `summary` (required)
- `description` (optional)
- `issueType` (optional; default `New Feature`)

## Done when

- Human saw full preview; approve → issue key returned; reject → no Jira object created.
- No write without confirm.

## Failure modes

| Mode | Response |
|------|----------|
| Write without preview | **Forbidden** |
| Cloud-only API assumptions | Stick to `/rest/api/2/...` Server paths |
| Partial package (feature without planned stories) when atomic package intended | Use `confirm-write-package` |
| Missing env | Fail `loadJiraConfig`; do not prompt-and-guess tokens into logs |
