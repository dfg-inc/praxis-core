# Provenance and distribution audit: Praxis 0.1.0-alpha.49 release candidate

**Status after the owner's decisions (2026-10-29, round 12).** Sections 1-7 below are the audit as first written; this block says what changed since.

Owner statement applied: Praxis is an internal company project; the `<corporate-domain>` and `dfuture.co` commits are corporate development and are not classified as third-party provenance from an e-mail address. NOTICE stays `Copyright 2026 dfuture-co`.

### Closed

| # | Item | What was done | Evidence |
|---|---|---|---|
| 1 | corporate dataset in packages | `@praxis/knowledge` publishes only `dataset/templates/` (package `files` and `pack-core-vendor.mjs`); the five vendored `praxis-knowledge-0.1.0-alpha.49.tgz` were rebuilt | `check-public-content` extracts all 23 vendor tarballs: none ships `dataset/company` or `dataset/product/demo`; Runtime bundle, MCPB, 4 ZIPs, Marketplace stage never contained it |
| 1b | dataset in the public Core tree | removed from the tree in a separate local commit (`5e78f55`); nothing reads it (Runtime and roles use the project's own `knowledge.path`); `knowledge-external-acceptance.mjs` (Core and Runtime) writes its own neutral fixtures (`example-handbook`) | Runtime MCP 253/253 and knowledge/plugin-sdk/cli suites pass without it; core and runtime acceptance rerun in verify |
| 2 | `grill-cr` MIT overlap | attribution added: comment in the skill, BA `THIRD-PARTY-NOTICES.md` (root, plugin, Marketplace stage, and now inside `praxis-ba.zip`) with the upstream MIT text, `Copyright (c) 2026 Matt Pocock`, stating that the adapted paragraph is not original Apache-2.0 code | generator `gen-third-party-notices.mjs --profile ba`; gate checks the BA ZIP |
| 3 | personal e-mail and `author` | e-mail removed from the BA `plugin.json` and its stage; `author` is `dfuture-co` in every plugin manifest, the MCPB manifest and the generated ZIP manifests (the Marketplace `owner.name` field "Praxis" is a marketplace owner, not an author, and was left) | gate |
| 4 | local paths and internal hosts | the Runtime message no longer names an internal host; tests and acceptance scripts use `~/praxis-acceptance` via `os.homedir()` or placeholders; `.env.example`, quality-service README, hard-coded test paths replaced; public release documents sanitized (neutral placeholders) | `git grep` for the home path and the host name: 0 hits in all seven repositories; gate scans archive contents |
| 6 | archive contents, not only sources | new gate `praxis-marketplace/tools/scripts/check-public-content.mjs` (in `npm run verify`): extracts the `.mcpb`, the four ZIPs and every vendor tgz and scans them, plus the Marketplace tree | see FINAL-REPORT round 12 |

### Residual risks

- **The corporate dataset is already public.** Scale (read-only checks of the GitHub API on 2026-10-29): all seven repositories are public. `dfg-inc/praxis-core` master (`0f71e38`) contains the 8 files (6 rules, 1 company precedent, 1 product precedent; added by `823369b` and `893d4a4`, so present in the public history of 177 commits); the public GitHub Release `v0.1.0-alpha.47` of praxis-core carries `praxis-knowledge-0.1.0-alpha.47.tgz` (12,269 bytes, 9 dataset entries, 2 downloads); the public masters of praxis-runtime, -ba, -architect, -developer, -quality carry `vendor/praxis-knowledge-0.1.0-alpha.48.tgz` (3-4 historical versions each). The 20 role/Runtime release assets of alpha.45-48 (ZIP, MCPB) were downloaded and contain none. Marketplace: none. Forks: 0; stars: 52. Removing the files from the tree does not remove them from history, the old release asset or clones.
- Options, none executed: (a) leave as is if the content is judged non-sensitive (it is generic process guidance); (b) delete the single release asset (`gh release delete-asset`); (c) rewrite history of the six repositories with a history-filter tool and force-push (disruptive: every clone and the alpha.45-48 tags change; GitHub keeps commit SHAs reachable until support purges them); (d) make the repositories private until decided. Each outward-facing option needs the owner's explicit go.
- `sql-wasm.wasm`: origin established (unmodified `sql.js@1.14.2`), see the round 13 addendum; open: the unlicensed `extension-functions.c` inside it and the missing Emscripten/musl notice.
- The checks above find no match in the sources I could reach; they are not a legal clearance. Private sources cannot be checked.
- The Marketplace `owner.name` ("Praxis") and `author` of the generated BA ZIP manifest are consistent with `dfuture-co` only where the instruction applied.

### Needs agreement of the rights holder

1. Whether the corporate dataset may remain public in history and in the alpha.47 release asset (see options).
2. The legal name behind `Copyright 2026 dfuture-co` (NOTICE was not changed).
3. That the corporate Apache-2.0 grant covers all material created since 2026-08-25, including the Jira integration and prompts (the audit found no third-party origin; legal confirmation is the rights holder's).
4. The MIT attribution wording for `grill-cr` (applied as above).

---

## Round 13 addendum (2026-10-29): dataset content assessment, `sql-wasm.wasm`, knowledge check

No file of the release changed in this round; only documents.

### A. What the eight `company/**` files actually contain (read in full from commit `7e5423f`)

Factual reading, no legal conclusion.

| File | Content | Company-specific facts |
|---|---|---|
| `rules/task-schema.md` | task fields (type, summary, acceptance criteria, fix version) | none |
| `rules/review-checklist.md` | five merge-review checks (Developer-to-Quality handoff, intention, `FIXME-CRITICAL` markers, tests vs AC, deviation records); "combat CI remains the deployment gate" | a wording ("combat CI") |
| `rules/root-cause.md` | root cause before workaround | none |
| `rules/sprint-process.md` | work packages of at most 5 business days, definition of ready | none |
| `rules/defect-standard.md` | BUG pages, duplicate reports, return events | none |
| `rules/tracker-workflow.md` | four procedural gates; front matter says "Company retired Jira Server ... binding needs Linear review" | the statement that Jira Server was retired and that the current tracker is Linear |
| `precedents/sync-within-dc.md` | prefer synchronous HTTP within one datacenter | "two company services" (no names) |
| `product/demo/precedents/async-queue-gds.md` | queue between order and billing services | the label "Product GDS" and one sentence about billing incidents |

Checked: no names of people or customers, no hosts or URLs, no credentials, no prices, no contracts, no code, no data; 5,295 bytes in all. The vocabulary is Praxis's own workflow (BA-to-Architect handoff, final-arbiter, Quality review, finding-lift, change-spec, Definition of Ready, BUG/CR pages), not a general corporate policy. **Assessment: general process rules; the only facts about the company are the retired Jira Server, Linear as the current tracker, a product label "GDS" with an order/billing service pair, and an unspecified billing incident; none is a credential or personal or customer data.** What cannot be read from the files, and was not assumed: whether the sentences were condensed from a document that carries its own confidentiality marking (the labels `<handbook-label-1>` and `<handbook-label-2>` say so but point at nothing available).

### B. `sql-wasm.wasm`: origin, versions, licences

| Question | Finding (verified) |
|---|---|
| What is shipped | `praxis-runtime/plugins/runtime/server/sql-wasm.wasm`, the Marketplace stage copy and the copy inside the `.mcpb`: three byte-identical files, 658,410 bytes, sha256 `38c14f6e379210bc942bdc4ebca44e7bfdb4318ecc1c72ca666a28fdce96670a` |
| Exact upstream | `sql.js@1.14.2` (npm, `dist/sql-wasm.wasm`; registry integrity `sha512-3ZGPovObMF...YFcw==`, `gitHead 1d5db4546e5feb944a3415739eb2a54103b54882`) and the GitHub Release `sql-js/sql.js` `v1.14.2` (2026-08-14), asset `sqljs-wasm.zip`: the file in both has the same sha256 as ours. Provenance of the bytes: established, unmodified upstream binary. |
| What is inside | SQLite 3.49.1 (check-in line "2025-02-18 13:38:58 873d4e27...", amalgamation `sqlite-amalgamation-3490100`, SHA3 pinned in the upstream Makefile); the SQLite contrib file `extension-functions.c` by Liam Healy (the SQL functions `padl`, `stdev`, `charindex` and others are present in the binary; the file's SHA-1 equals the one pinned in the upstream Makefile); compiled with Emscripten (the upstream devcontainer pins 5.0.0; the binary reports `COMPILER=clang-23.0.0` and has no producers section, so the exact toolchain of the release build is not provable). Built with `-Oz`, no load-extension, FTS3, single-threaded. |
| Our use | The Quality service stores reviews in SQLite; no SQL in `apps/quality-service` or `packages/mcp` calls the extension functions. |
| SQLite | Public domain (sqlite.org/copyright.html): no notice required. |
| sql.js | MIT, "Copyright (c) 2017 sql.js authors", plus Makefile portions MIT "Copyright 2017 Ryusei Yamaguchi": already shipped in `THIRD-PARTY-NOTICES.md` (Runtime, MCPB). |
| Emscripten | Dual MIT / University of Illinois-NCSA for the Emscripten runtime and libraries; the compiled output links Emscripten's libc, whose code is MIT "Copyright 2005-2020 Rich Felker, et al." (musl). The wasm has no embedded copyright text and `THIRD-PARTY-NOTICES.md` does **not** yet carry the Emscripten or musl notice. Exposure: low (permissive), but a MIT notice for statically linked code is customary; nothing in the files proves which Emscripten libraries were linked. |
| Open point | `extension-functions.c` has no licence statement in the file; the SQLite contrib archive page calls these files unsupported, historical, "use at your own risk" and states no licence. sql.js has redistributed it under its own MIT licence for years; Praxis inherits that situation and cannot settle it. |
| Reproducibility | Not rebuilt here (no Emscripten toolchain). The binary is verifiably the upstream release artefact; its internals are as documented by upstream. |

Options: (1) accept as inherited from sql.js and add the Emscripten (MIT and UIUC) and musl MIT notices to the Runtime `THIRD-PARTY-NOTICES.md` (notice-only change; rebuilds the MCPB and restages Marketplace; not applied); (2) accept as is, document the risk (what this round does); (3) ask sql.js and the file's author for a licence statement; (4) build a Praxis-owned wasm without `extension-functions.c` from a pinned SQLite amalgamation and Emscripten (verified build, a release-content change); (5) later replace sql.js by the official SQLite WebAssembly build (dependency change). None is needed for the build to work.

### C. Knowledge and templates after the removal

`npm ci` installs `@praxis/knowledge` 0.1.0-alpha.49 from the vendored tarball: `dataset/` holds only `templates/precedent.md`. With that installed package: `praxis-knowledge slice` on a project corpus lists the rule for `ba/research`, lists the precedent created from the shipped template for `architect/plan`, and `precedent --path` parses it into the four sections. The Runtime and roles read a project's own `knowledge.path`; nothing reads a bundled corporate corpus. Earlier evidence on the same files (not rerun): Runtime MCP 253/253, knowledge/plugin-sdk/cli suites, `knowledge-external-acceptance` on neutral fixtures, all `verify` exit 0.

---

## Original audit (2026-10-29, before the decisions)

Scope: sources and everything shipped from the seven repositories (heads in `RELEASE-CHECKLIST-alpha.49.md`): five archives (`praxis-runtime.mcpb`, four role ZIPs), the 23 vendored `@praxis/*` tarballs, the Marketplace `plugins/` stage, and the git history. Read-only; nothing was changed, published, pushed, merged or tagged. A change list that needs the owner's go is in section 6 and in `proposed-exclusion-core.patch` (tested on a scratch clone, not applied).

Method limits, stated once: rights cannot be decided from files. "SAFE" means: written in this repository by the owner's own commits, no match with the external sources I could check, no data of others. External checks: web search plus the upstream repository `mattpocock/skills` (every SKILL.md and docs file, 95 files, 8-word-sequence overlap against all 150 skill/agent/template Markdown files of the four role plugins) and a search for the Developer sub-agent names. I could not check against private or unknown sources.

## 1. company/** and <handbook-label-1>: REQUIRES OWNER CONFIRMATION (interim exclusion prepared, tested)

| Item | Facts |
|---|---|
| Files | `praxis-core/packages/knowledge/dataset/company/rules/{task-schema,review-checklist,root-cause,defect-standard,sprint-process,tracker-workflow}.md`, `.../company/precedents/sync-within-dc.md`, `.../product/demo/precedents/async-queue-gds.md` (8 files, 5,295 bytes in all); the field example in `packages/knowledge/README.md:26` |
| Content | Short generic engineering-process rules (task schema, merge review checklist, root cause, defect standard, sprint cadence, tracker workflow, two architecture precedents). No names of people, customers, hosts, prices or code. Words that point at a company: "company", "Company retired Jira Server" (`tracker-workflow.md:12`), "GDS" product label in `async-queue-gds.md`. |
| Claimed source | front matter `sourceDoc: <handbook-label-1>` (task-schema, root-cause, sprint-process, tracker-workflow) and `sourceDoc: <handbook-label-2>` (review-checklist), `sourceVersion: "1.0.0"`. I found no such document in any repository or in the file system. |
| History | Added in the first commits by the owner's `dfuture.co` identity: `823369b` (2026-08-25, "Initialize Praxis Phase 1 monorepo") and `893d4a4` (2026-09-03, "close Epic 2 precedents, override findings, and migration metadata"). Nothing shows whether the text was typed fresh or condensed from a corporate document. That is exactly the point the owner must confirm. |
| Where it ships | Only inside the five vendored `praxis-knowledge-0.1.0-alpha.49.tgz` (runtime, ba, architect, developer, quality `vendor/`) and in the source tree of public praxis-core. **Not** in the Runtime bundle (`praxis-mcp.cjs`: 0 hits), the MCPB, the four ZIPs, or the Marketplace `plugins/` stage. |
| Does anything need it? | No. The Runtime and the roles read a project's own `knowledge.path`; no code reads the bundled dataset. In core it is only a fixture of `tools/scripts/knowledge-external-acceptance.mjs` (lines 362-528, also asserts the label `<handbook-label-1>@1.0.0`). |
| Safe exclusion, tested | Publish only `dataset/templates/` in the `@praxis/knowledge` package (`files`), see section 6, change C1. Proof: (a) praxis-runtime `packages/mcp` 253/253 tests pass with `company/` and `product/` removed from the installed `@praxis/knowledge`; (b) a scratch copy of core without those directories: knowledge, plugin-sdk, cli suites 11 files / 123 tests pass; (c) `npm pack --dry-run` of the patched package lists only `dataset/templates/precedent.md`. The Runtime bundle, MCPB and ZIPs are unaffected (they never contained it). |
| What exclusion does not do | The files stay in public praxis-core (fixtures of the core acceptance) and in published git history. Removing them from the tree or rewriting history, and relabelling `sourceDoc`, is a separate owner decision (changes C2, C3). Relabelling alone would not settle the rights question. |

## 2. Commits from <corporate-domain>: REQUIRES OWNER CONFIRMATION (no inference from the domain)

Facts only. All 250+ other commits in every repository carry `<author-address>` as author and committer. Exactly these carry `<corporate-address>` (same person name, Sergey Borovoy):

| Repo | Commit | Date | What |
|---|---|---|---|
| praxis-core | `91fd60a` | 2026-08-31 | GitLab merge "test-branch into master"; the merged commits (`02c9e12`, `aaf4390`, `a709246`) are authored by `dfuture.co`. Merge diff: 16 files (catalog, package versions, release script). |
| praxis-runtime | `5fb1fa1` | 2026-08-31 | same merge; adds `tools/scripts/release-lib.mjs`, `release-lib.test.mjs`, `release-version.mjs` (702 lines), authored by `dfuture.co` commits. |
| praxis-ba | `1781b39` | 2026-08-31 | same merge; 5 plugin manifest/version files. |
| praxis-architect | `8f971dd` | 2026-08-31 | same merge; 3 manifest files. |
| praxis-developer | `c8782b4` | 2026-08-31 | same merge; 3 manifest files. |
| praxis-marketplace | `f146f80` | 2026-08-31 | same merge; `apps/marketplace-site/package.json`. |
| praxis-marketplace | `3c0ab03` | 2026-10-22 | GitHub "Merge pull request #1 from dfg-inc/cleanup/plugins-only" by GitHub user `<github-user>`; the branch commit `fda9280` is authored by `dfuture.co`; removes the duplicate site and stale docs (115 files). |
| praxis-quality | none | | |

So the <corporate-domain> address authored **no file content**: every line is a merge of `dfuture.co`-authored commits. Other facts that bear on the question (not conclusions): the repositories' original remote is `git@<internal-gitlab>:engineering/ai-tooling/<repo>.git` (a GitLab group of that domain), the work started 2026-08-25 as "Praxis Phase 1 monorepo" (`SPLIT-FROM`: monorepo v0.1.0-alpha.44), and the strings `<internal-gitlab>` appear in public tests and one Runtime message (section 6, C4). **Legal confirmation needed** for all material created from 2026-08-25 onward: whether Praxis was created under an employment or contract with that organisation and who holds the rights. Nothing in the files answers it.

## 3. Prompts, skills, sub-agents

| Path | Origin evidence | Verdict |
|---|---|---|
| `praxis-developer/plugins/developer/agents/{codebase-analyzer,codebase-locator,codebase-pattern-finder,thoughts-analyzer,thoughts-locator,web-search-researcher}.md` (223-355 bytes each) | The six names match a widely circulated Claude Code agent set; a search found those names in third-party repositories (e.g. a Zed commit) and the HumanLayer repository is Apache-2.0, but I could not tie any file to a source or licence. The Praxis files are 10-20 line stubs ("Developer research sub-agent (name)", Input/Output headings) with none of the long prompts those agents are known for. | SAFE TO DISTRIBUTE (original generic stubs; names are descriptive). Low residual: owner may confirm they were not pasted from another project. |
| `praxis-developer/plugins/developer/skills/caveman/SKILL.md` | A different "caveman" (terse-output mode, JuliusBrussee/caveman) exists; the Praxis skill is a "simplified mode for small changes" in 12 lines. Only the name coincides. | SAFE |
| `praxis-developer/.../skills/tdd/SKILL.md`, `praxis-ba/.../skills/prototype/` | Same names as skills in mattpocock/skills; 0 shared 8-word sequences. | SAFE |
| `praxis-architect/plugins/architect/skills/grill/SKILL.md`, `agents/max.md` | Same practice (one question at a time, recommended answer) as upstream grilling skills; wording is different (0 shared sequences with the current upstream). The text says "port from praxis feat/grill-rules", an internal branch. | SAFE for the text; the idea is not protectable. |
| **`praxis-ba/plugins/ba/skills/grill-cr/SKILL.md`** and the staged copy `praxis-marketplace/plugins/praxis-ba/skills/grill-cr/SKILL.md` (also inside `praxis-ba.zip`) | The header comment says it was "Vendored ... from the owner's grilling skill at ~/.claude/skills/grilling/SKILL.md (and its /grill-me wrapper) ... original interview discipline preserved verbatim where possible". Its first paragraph ("Interview ... relentlessly about every aspect of ... until we reach a shared understanding. Walk down each branch of the ..., resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.") is the opening of the public `grill-me` skill of `github.com/mattpocock/skills` as first published on 2026-02-25 ("Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one."), adapted by replacing two nouns. That repository is MIT-licensed (`Copyright (c) 2026 Matt Pocock`, read from its LICENSE). The rest of the file (scope discipline, flow, CLI steps) is Praxis-specific. | **REQUIRES OWNER CONFIRMATION**: either the paragraph is rewritten in own words, or the MIT notice is added. Two sentences are probably not a "substantial portion", but the file itself says "verbatim", so the notice or the rewrite is the clean answer (change C5). |
| Other BA/Architect/Quality/Developer skills, templates, rules (150 Markdown files) | No 8-word overlap with the 95 upstream files; no "adapted from / copyright / licence" markers other than the two above; `max.md:21` "ported from praxis unmerged branches" is internal. | SAFE (no match found; not a legal clearance) |
| Plugin icons `*/.claude-plugin/icon.png` (11 files) | Generated by `praxis-core/tools/scripts/gen-plugin-icons.mjs` (geometric "p" and a dot in SVG rendered by headless Chromium; palette taken from the website; no font or third-party artwork embedded). | SAFE |

## 4. Shipped artifacts: content scan

Scanned: the extracted `praxis-runtime.mcpb` and four ZIPs, the 23 vendor tarballs (extracted), the Marketplace `plugins/` and `.claude-plugin/` tree, and the history of all repositories (commit-wide pattern search, no secret scanner installed).

| Check | Result |
|---|---|
| Secrets (GitHub, GitLab, AWS, Slack, OpenAI-style keys, private keys, JWT, `.env`, `.pem`) | none in artifacts or stage; history hits are test fixtures only (`glpat-not-real`, `ghp_not_a_real_token_value`, `OPERATOR-SECRET-TOKEN-123`, `-----BEGIN PRIVATE KEY-----\nAAA`, `.env` strings in tests). Heuristic, not a guarantee. |
| Absolute local paths in artifacts | none of the owner's. One third-party default in sql.js (`HOME: "/home/web_user"` in `praxis-quality.cjs`). In the repositories' source (not shipped): `~/...` in `praxis-core/.env.example`, acceptance scripts (`git-delivery-e2e-acceptance.mjs`, `quality-praxis-test-acceptance.mjs`, `desktop-mcp-runtime-acceptance.mjs`), `praxis-runtime/apps/quality-service/README.md:80`, `workflow-external-acceptance.mjs:451`, `browser-driver-hardening.test.ts` (4). |
| Internal hosts | `<internal-gitlab>` in one Runtime message (`plugins/vcs/src/delivery.ts:235`, therefore in `praxis-mcp.cjs` of the MCPB and the Marketplace Runtime plugin) and in 3 acceptance/test files. No other internal host: the bundle's external URLs are json-schema.org, api.github.com, raw.githubusercontent.com, gitlab.com, localhost. |
| Corporate documents / dataset | the knowledge dataset only in the five vendor tarballs (section 1). Marketplace plugins, ZIPs, MCPB: none. |
| E-mail addresses | `<withdrawn-address>` as `author.email` in `praxis-ba/plugins/ba/.claude-plugin/plugin.json:7` and the staged copy `praxis-marketplace/plugins/praxis-ba/.claude-plugin/plugin.json:7` (a person who is not a committer in any repository). Also `quality@praxis.local` (placeholder) and, inside THIRD-PARTY-NOTICES, the `yaml` author's address as printed in its licence. |
| Binary assets | icons (section 3), `sql-wasm.wasm` (sql.js; embeds SQLite and Emscripten runtime: terms not restated in the sql.js LICENSE, **NOT VERIFIED**). No fonts, images or documents otherwise. |
| `author` declarations | `dfuture-co` in 9 manifests; `Praxis` in 3 (`praxis-runtime/plugins/runtime`, its Marketplace copy, `praxis-marketplace/plugins/praxis`); `dfuture-co` plus the e-mail above in 2. Inconsistent, not a rights problem. |
| Release documents | `praxis-core/docs/releases/0.1.0-alpha.49/**` (committed locally) contain `~` paths and internal-host references in 7 files (`QUALITY-BRIEF.md`, `FINAL-REPORT.md`, `RELEASE-CHECKLIST-alpha.49.md`, `LICENSE-AUDIT.md`, `FINAL-MATRIX.md`, `manual-lab/MANUAL-ACCEPTANCE.md`, `manual-lab/setup-lab.sh`). They become public the moment praxis-core is pushed. |

## 5. LICENSE, NOTICE, THIRD-PARTY-NOTICES, copyright: SAFE TO DISTRIBUTE (consistent)

Checked by hash across all 18 copies in the seven repositories and the Marketplace stage: LICENSE is byte-identical (sha256 `cfc7749b…`, the official Apache-2.0 text); NOTICE is byte-identical (`Copyright 2026 dfuture-co`, the only copyright line anywhere); THIRD-PARTY-NOTICES has two variants by design (Runtime/MCPB: 18 packages, 3 copies; roles and role stages: 9 packages, 12 copies). Package lists were re-derived from the bundles (`node_modules/` path comments: zod, yaml, js-yaml, gray-matter and its five transitive packages in all role bundles; plus MCP SDK server and core, zod 4, sql.js, and the five packages inlined by the SDK build in the Runtime): they match. All `license` fields: `Apache-2.0` (no other value in any tracked manifest, archive or vendor tarball). The copyright holder was not changed. Not complete: the vendored tarballs carry LICENSE but not NOTICE (build inputs, not shipped); the holder name is the manifests' `dfuture-co`, not a confirmed legal entity.

## 6. Proposed changes (exact list; none applied; each needs the owner's go)

| # | Change | Why | Effect |
|---|---|---|---|
| C1 | `praxis-core/packages/knowledge/package.json`: `files` `"dataset"` to `"dataset/templates"`; `praxis-core/tools/scripts/pack-core-vendor.mjs`: knowledge `files` `["dist","bin","dataset"]` to `["dist","bin","dataset/templates"]` | keep company/** and product/demo out of every published package until the origin is confirmed | the five vendor tarballs lose 8 files; requires a Core commit, then `refresh-core-vendor.mjs` in runtime and the vendor refresh in the four roles (as done in this RC), re-stage and re-verify; no effect on Runtime bundle, MCPB, ZIPs, Marketplace plugins |
| C2 | (optional, after confirmation) move the 8 dataset files out of the public tree into test fixtures with neutral content, adapt `knowledge-external-acceptance.mjs` (core and runtime copies) | the public repo still contains them | history unchanged |
| C3 | (optional) relabel `sourceDoc` (`<handbook-label-1>`, `<handbook-label-2>`) and the README example | the label asserts a corporate source | cosmetic if rights are not settled |
| C4 | `praxis-core/plugins/vcs/src/delivery.ts:235`: drop `<internal-gitlab>` from the message ("will not guess github.com, gitlab.com, or any other host"); tests keep asserting that no host is guessed | internal host name in a shipped string | rebuilds the Runtime bundle (MCPB, Marketplace plugin) |
| C5 | `praxis-ba/plugins/ba/skills/grill-cr/SKILL.md` (and the Marketplace stage): rewrite the first paragraph in own words **or** add a MIT notice for `mattpocock/skills` (Copyright (c) 2026 Matt Pocock) to the BA THIRD-PARTY-NOTICES; drop the `~/.claude/skills` comment either way | near-verbatim opening of an MIT skill | BA ZIP and Marketplace praxis-ba change |
| C6 | `<withdrawn-address>`: remove from the two BA `plugin.json` or keep with the person's consent; unify `author` | personal e-mail of a non-committer in public manifests | BA manifests |
| C7 | strip `~` paths and `<internal-gitlab>` from `praxis-core/docs/releases/0.1.0-alpha.49/**` before any push of Core, or keep that folder unpushed | internal paths in public docs | docs only |
| C8 | (optional) replace `~/...` defaults in `.env.example`, acceptance scripts and `apps/quality-service/README.md` by placeholders | not shipped, but public in source | none on artifacts |

`proposed-exclusion-core.patch` contains C1 and C4 (3 lines in 3 files). Tested in a scratch clone: `plugins/vcs` and `packages/knowledge` suites pass (42 tests); `npm pack --dry-run` shows only `dataset/templates/precedent.md`.

## 7. Verdict table

| Verdict | Items |
|---|---|
| SAFE TO DISTRIBUTE | LICENSE, NOTICE, THIRD-PARTY-NOTICES and manifests (section 5); icons; Developer sub-agent stubs; `caveman`, `tdd`, `prototype`, architect `grill`, `max`; all other role skills/templates (no match found); Jira plugin source (no company ids or hosts); Runtime/MCPB/ZIP/Marketplace content other than listed below; no secrets found |
| REQUIRES OWNER CONFIRMATION | knowledge dataset origin (section 1); <corporate-domain> / `<internal-gitlab>` provenance of all material from 2026-08-25 (section 2); `grill-cr` MIT overlap (C5); `<withdrawn-address>` (C6); legal name of the holder; `sql-wasm.wasm` internals (SQLite, Emscripten) |
| EXCLUDE (until confirmed) | `dataset/company/**` and `dataset/product/demo/**` from every published package (C1, prepared, tested); `praxis-core/docs/releases/**` from any public push until stripped (C7) |
