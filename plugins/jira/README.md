# praxis-jira

Company-internal Jira Server integration for Praxis (WBS 3.x). **UNLICENSED** — not part of the Apache-2.0 role plugin line.

## Config

| Env | Required | Description |
|-----|----------|-------------|
| `PRAXIS_JIRA_BASE_URL` | yes | Jira Server base URL (no trailing slash) |
| `PRAXIS_JIRA_TOKEN` | yes | Personal access / bearer token |
| `PRAXIS_JIRA_PROJECT_KEY` | yes | Default project key |

Optional `.project` jira fields may override later.

## Live smoke

See **`docs/JIRA_LIVE.md`**. Default command is dry-run (connect → read → preview). Mutations require `--allow-mutate --confirm-mutate YES`.

```bash
npm run build -w @praxis/jira
npm run live-smoke -w @praxis/jira
```

## Human gate

All mutating methods build a preview. Writes run only through `confirmAndExecute(preview, confirmer)` after the human approves.

## API

- `verifyConnection()`
- `createFeature` / `createStory` / `linkIssues` / `setFixVersion` / `setArchitectEstimate` / `attachDecisionLink`
- `readFeatureStatuses` (read-only)

Targets Jira Server REST API style (`/rest/api/2/...`).
