---
name: create-story
description: Preview and create a Story with acceptance-criteria body on Jira Server only after human confirm.
---

# create-story

Create a **Story** via `JiraClient.createStory` **only** for legacy Server packages that are not the BA Epic orchestration.

For Epic → Stories (Cloud or DC) use BA skill `jira-analyze-epic` / `baAnalyzeEpic`. Raw `createStory` does **not** write `praxis.artifactId` before/with create and will duplicate if mixed with BA apply.


## When to use

- Feature exists (or will exist in the same atomic package) and stories with AC are ready.
- For feature + N stories + links + version as one unit → `confirm-write-package`.

## Config (Jira Server)

| Env | Required |
|-----|----------|
| `PRAXIS_JIRA_BASE_URL` | yes |
| `PRAXIS_JIRA_TOKEN` | yes |
| `PRAXIS_JIRA_PROJECT_KEY` | yes |

REST: `POST /rest/api/2/issue`. Optional parent via `fields.parent.key` when the Server project supports parent/epic-style linkage for the issue type.

## Preview package

From `createStoryPreview`:

- `method` / `path`: `POST` `/rest/api/2/issue`
- `description`: prefixed with `Acceptance Criteria:\n\n` + `acceptanceCriteria`
- `issuetype.name`: default `"Story"`
- Optional `parent.key`

Show the complete `MutationPreview` body to the human.

## Confirm gate

1. Build preview (summary, AC text, parentKey, issueType).
2. Present full package — human must see AC text as it will be stored.
3. `confirmAndExecute` only on explicit approve.
4. Reject → no write; approve → return issue `key`.

## Inputs

- `summary` (required)
- `acceptanceCriteria` (required string)
- `parentKey` (optional feature/parent key)
- `issueType` (optional; default `Story`)

## Done when

- Preview approved or rejected with no silent write.
- On success, Story key available for `link-issues` / status reads.

## Failure modes

| Mode | Response |
|------|----------|
| Empty AC | Refuse preview; AC required |
| Write without confirm | **Forbidden** |
| Assuming Jira Cloud ADF description | Server client sends plain description string in v2 fields |
| Creating stories that orphan from intended feature without saying so | Prefer atomic `confirm-write-package` |
