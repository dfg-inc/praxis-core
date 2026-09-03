# @praxis/knowledge

Company / product / service rule corpus and finding-lift helpers for Praxis Phase 1.

## Dataset layout

```
<knowledgeRoot>/
  company/rules/*.md
  company/precedents/*.md
  product/<productId>/rules/*.md
  product/<productId>/precedents/*.md
  service/<serviceId>/rules/*.md
  service/<serviceId>/precedents/*.md
  templates/precedent.md
```

Each **rule** is Markdown with YAML frontmatter:

```yaml
id: task-schema
roles: [ba, architect, developer]
stages: [research, plan, implement]
severity: mandatory   # or advisory
overridable: true
sourceDoc: corp-engineering-handbook   # optional (migrated norms)
sourceVersion: "1.0.0"                 # optional
obsoleteToolBinding:                   # optional (WBS 2.6.2)
  toolId: legacy-jira-server
  reason: Company retired Jira Server; procedural gates remain
  proceduralContentApplicable: true
  reviewRequired: true
```

Each **precedent** lives under `precedents/` at the same company/product/service level, with frontmatter (`id`, `roles`, `stages`, optional `title`) plus four required `##` sections: Circumstances, Chosen, Rejected, Why (RU aliases accepted).

## Precedence

For the same `id`, higher levels replace lower ones (rules **and** precedents):

**service > product > company**

Product and service trees are only read when `product` / `service` ids are supplied to `loadApplicableSlice` (or via `.project` → `knowledge.product` / `knowledge.service`).

Malformed rule/precedent files are **not** treated as valid; their errors appear in `errors[]`.

## Role / stage slicing

`loadApplicableSlice({ knowledgeRoot, role, stage, product?, service? })` returns:

- `rules` — applicable rules (role ∩ stage)
- `precedents` — applicable scoped precedents (same filters)
- `errors` — parse/validation failures
- `emptyMessage` — when no rules match (`applicable rules: none`)

## `.project` → `knowledge.path`

Session bootstrap (`@praxis/plugin-sdk.bootstrapSession`) reads `.project` via `@praxis/project-config`:

```yaml
knowledge:
  path: /abs/or/repo-relative/knowledge
  ref: main
  product: demo      # optional
  service: api       # optional
```

| Condition | Result |
|-----------|--------|
| `.project` missing | defaults; `knowledge.path` reported unset |
| `knowledge.path` unset | **skipped** — no invented path |
| path missing / unreadable | **unavailable** |
| valid path | **loaded** — rule ids for role/stage |

## CLI

```bash
praxis-knowledge slice --root <path> --role ba --stage research [--product id] [--service id]
praxis-knowledge precedent --path <file.md>
praxis-knowledge finding propose --store findings.json --kind architecture-decision \
  --id async-queue --title "…" --body "…" --ref ADR-1 --ref ADR-2
praxis-knowledge finding successful-override --store findings.json \
  --original-rule prefer-sync-dc --override-level product --override-source demo --ref demo/ADR-9
praxis-knowledge finding reject --store findings.json --id async-queue --reason "too narrow"
praxis-knowledge finding accept --store findings.json --id prefer-hello
praxis-knowledge finding list --store findings.json
```

## Finding lifecycle

1. **propose** — appends `proposed` unless fingerprint was rejected (**suppressed**).
2. **successful-override** — structured proposal (`kind: successful-override`) naming the parent rule and override source; recommends reconsidering the company norm; **no auto-promotion**.
3. **reject** / **accept** — human gate only.
4. Persistence via `loadFindingStore` / `saveFindingStore`.

## SessionStart

BA / Architect / Developer hooks call shared `bootstrapSession()` (packed as `session-bootstrap.cjs`).
