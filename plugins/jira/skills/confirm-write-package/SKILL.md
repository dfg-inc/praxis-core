---
name: confirm-write-package
description: Atomic Jira mutation package — show the full set of creates/links/versions to the human; on confirm execute entirely and return keys; on reject write nothing (WBS 3.8).
---

# confirm-write-package

WBS **3.8** gate: prepared set (e.g. one feature, several stories, links, fix version) is shown as a **single preview package**. Human confirms → mutations run as a unit and created keys are reported. Human refuses → **no** create/update/link in the tracker (WBS `3.8.1`, `3.8.2`).

## When to use

- Any multi-step Jira write set (feature + stories + links + version/estimate).
- Prefer this over chaining `create-feature` / `create-story` / `link-issues` with separate confirms when the set is one business package.
- Single-mutation calls may use their skill-level confirm; this skill owns **atomic packages**.

## Config (Jira Server)

Same env as other jira skills: `PRAXIS_JIRA_BASE_URL`, `PRAXIS_JIRA_TOKEN`, `PRAXIS_JIRA_PROJECT_KEY`. All calls use `/rest/api/2/...`.

## Preview package shape

Build an ordered list of `MutationPreview` objects **before any write**:

| Step | Client helper | REST |
|------|---------------|------|
| Create feature | `createFeaturePreview` | `POST /rest/api/2/issue` |
| Create stories | `createStoryPreview` × N | `POST /rest/api/2/issue` |
| Link issues | `linkIssuesPreview` | `POST /rest/api/2/issueLink` |
| Fix version | `setFixVersionPreview` | `PUT /rest/api/2/issue/{key}` |
| Estimate / decision | `setArchitectEstimatePreview` / `attachDecisionLinkPreview` | PUT / comment POST |

Present one human-visible package:

```text
Package id: <local>
Mutations:
  1. POST /rest/api/2/issue — Create feature: …
  2. POST /rest/api/2/issue — Create story: …
  …
Dependency note: story/link steps that need new keys run after creates in order.
```

Include full bodies, not summaries only.

## Confirm gate

1. Assemble previews (no network writes yet). For steps that need keys from earlier creates, show **placeholders** (`$FEATURE_KEY`) and the execution order.
2. AskUserQuestion / confirmer: approve entire package?
3. **Reject** → return `{ executed: false }`; do not call any mutating REST method.
4. **Approve** → execute in order via `confirmAndExecute` **or** a single package-level confirmer that wraps the whole execute function:
   - Create feature → capture `key`
   - Create stories (inject parent key) → capture keys
   - Links / version / estimate / decision comment
5. On mid-package HTTP failure: stop; report completed keys + failed step; do not pretend atomic DB transaction (Jira has none) — surface partial state for human cleanup. Prefer designing packages so dry-run preview is trusted before approve.
6. On full success: print all created/updated identifiers.

## Done when

- Approve → all planned mutations attempted in order; keys listed.
- Reject → tracker unchanged (verified by performing zero writes).
- Human always saw the full package once before any write.

## Failure modes

| Mode | Response |
|------|----------|
| Per-item confirms that leave half the set unapproved | Use one package gate |
| Writing before approve | **Forbidden** |
| Claiming atomic rollback on Server | Impossible — document partial failure honestly |
| Empty package | Refuse |
| Mixing read-only status calls into “mutations” | Reads may run anytime; do not require confirm for GET |
