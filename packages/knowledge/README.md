# @praxis/knowledge

Company / product / service rule corpus and finding-lift helpers for Praxis Phase 1.

## Dataset layout

```
<knowledgeRoot>/
  company/rules/*.md
  product/<productId>/rules/*.md
  service/<serviceId>/rules/*.md
  templates/precedent.md
```

Each rule is Markdown with YAML frontmatter:

```yaml
id: task-schema
roles: [ba, architect, developer]
stages: [research, plan, implement]
severity: mandatory   # or advisory
overridable: true
```

## Precedence

For the same `id`, higher levels replace lower ones:

**service > product > company**

Product and service trees are only read when `product` / `service` ids are supplied to `loadApplicableSlice` (or via `.project` → `knowledge.product` / `knowledge.service`).

## Role / stage slicing

`loadApplicableSlice({ knowledgeRoot, role, stage, product?, service? })` keeps rules whose `roles` and `stages` both include the requested values.

## `.project` → `knowledge.path`

Session bootstrap (`@praxis/plugin-sdk.bootstrapSession`) reads `.project` via `@praxis/project-config`:

```yaml
knowledge:
  path: /abs/or/repo-relative/knowledge
  ref: main
  product: demo      # optional
  service: api       # optional
```

Behavior:

| Condition | Result |
|-----------|--------|
| `.project` missing | defaults; `knowledge.path` reported unset |
| `knowledge.path` unset | **skipped** — `knowledge.path unset; rules not applied` (no invented path) |
| path missing / unreadable | **unavailable** — `knowledge unavailable: …` |
| valid path | **loaded** — count + rule ids for role/stage |

Relative `knowledge.path` values are resolved against the session `repoRoot`.

## CLI

```bash
praxis-knowledge slice --root <path> --role ba --stage research [--product id] [--service id]
praxis-knowledge precedent --path <file.md>
praxis-knowledge finding propose --store findings.json --kind architecture-decision \
  --id async-queue --title "…" --body "…" --ref ADR-1
praxis-knowledge finding reject --store findings.json --id async-queue --reason "too narrow"
praxis-knowledge finding accept --store findings.json --id prefer-hello
praxis-knowledge finding list --store findings.json
```

## Finding lifecycle

1. **propose** — appends a `proposed` entry unless the fingerprint was previously rejected (**suppressed**).
2. **reject** — marks proposal rejected and records fingerprint + reason.
3. **accept** — marks proposal accepted (human gate; no auto-promotion into the corpus).
4. Persistence via `loadFindingStore` / `saveFindingStore` (JSON on disk).

## SessionStart consumption

| Plugin | Role | Default stage | Hook | Tool |
|--------|------|---------------|------|------|
| BA | `ba` | `research` | `hooks/session-start.md` | `tools/session-bootstrap.mjs` (`.cjs` in packs) |
| Architect | `architect` | `plan` | `hooks/session-start.md` | same |
| Developer | `developer` | `implement` | `hooks/session-start.md` | same |

All three call shared `bootstrapSession()` from `@praxis/plugin-sdk` (bundled into release artifacts). Skills: `skills/session-start/SKILL.md`.
