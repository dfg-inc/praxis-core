# Praxis license audit (read-only)

Date: 2026-10-26. Scope: praxis-core, praxis-runtime, praxis-ba, praxis-architect, praxis-developer, praxis-quality, praxis-marketplace (incl. `plugins/` staged copies and `release-candidate/`), praxis-docs, <monorepo>-website, and release artifacts (`release/alpha.48/*`, `desktop-install/*`). Nothing was edited, committed or published. No license is chosen here; section 3 gives options only and section 4 lists owner decisions.

Method: manifests parsed from files; vendored `.tgz` and release ZIP/MCPB opened read-only (extracted into the session scratchpad); third-party packages inside the bundles identified from the esbuild `// node_modules/...` path comments and their licenses read from `node_modules/*/package.json` of praxis-runtime (versions may differ slightly from what was bundled on build day; the bundles were built on this machine at alpha.48). All paths below are under `<praxis-split>` unless noted. "(R)" = praxis-runtime, "(M)" = praxis-marketplace.

Context facts from the repo's own notes (not decisions): the six repos are PUBLIC on GitHub under `dfg-inc/*` (`GITHUB-POST-MIGRATE-STATUS.md`), with no GitHub Releases or tags yet. `GITHUB-PUBLIC-MIGRATION-PREFLIGHT.md` blocker B6 says the license decision is unsettled, "Do not auto-pick MIT/Apache", and `GITHUB-POST-MIGRATE-STATUS.md` item 4 says "license posture unchanged ... accepted for publish as-is". `FIRST-RELEASE-PUBLISH-PLAN.md` lines 44-57 say "Public GitHub is not a grant of rights" and that Runtime/Quality need rights-holder confirmation.

---

## 1. Inventory table

### 1a. Repository roots and packages

No repository root contains a LICENSE, COPYING or NOTICE file (checked: core, runtime, ba, architect, developer, quality, marketplace, docs, website). The only LICENSE files are inside the three role plugin directories and their staged copies (see 1b), plus the Geist font license on the website.

| Component | Location | Declared license | LICENSE file present? | Contradictions / notes |
|---|---|---|---|---|
| praxis-core (root) | `praxis-core/package.json` | UNLICENSED | No | Public GitHub repo with no grant of rights. Code is therefore all-rights-reserved by default. |
| core workspaces: catalog, cli, tools/scripts, tools/e2e | `praxis-core/packages/{catalog,cli}/package.json`, `tools/{scripts,e2e}/package.json` | UNLICENSED | No | Consistent with root. |
| core workspaces: contracts, plugin-sdk, knowledge, project-config, testing | `praxis-core/packages/*/package.json` | none declared (no `license` field) | No | Not declared at all. Packed as vendored `.tgz` into the Apache role plugins and the Runtime. `praxis-website/.../upstream/guide/start.md` line 23 says "Apache-2.0 where the package says so"; the packages say nothing. |
| core plugins: jira, vcs | `praxis-core/plugins/jira/{package.json,.claude-plugin/plugin.json,README.md}`, `plugins/vcs/package.json` | UNLICENSED | No | Jira README: "Company-internal ... not part of the Apache-2.0 role plugin line". But `@praxis/jira` and `@praxis/vcs` are bundled into the public Runtime (see below). |
| core catalog | `praxis-core/packages/catalog/catalog.json` | role plugins `Apache-2.0` (lines 11-23), jira "company-only Jira mediator - UNLICENSED, not published" (line 33) | n/a | Says Jira is "not published" while its code ships inside the Runtime bundle and vendor tarballs in public repos. |
| praxis-core knowledge dataset | `praxis-core/packages/knowledge/dataset/**` (11 files) | none | No | Front matter says `sourceDoc: <handbook-label-1>`; text is company-internal ("Company retired Jira Server"). Ships only inside `@praxis/knowledge` tgz (not inside the Runtime bundle or ZIPs: grep for `<handbook-label-1>` in the bundles = 0). |
| praxis-runtime (root) | `praxis-runtime/package.json` line 39 | UNLICENSED | No | See next rows. |
| runtime workspaces | `praxis-runtime/packages/mcp`, `apps/quality-service`, `tools/scripts` package.json | UNLICENSED | No | |
| Runtime Claude Code plugin | `praxis-runtime/plugins/runtime/.claude-plugin/plugin.json`; (M) `plugins/praxis-runtime/.claude-plugin/plugin.json`, `release-candidate/plugins/praxis-runtime/...` | UNLICENSED | No | CONTRADICTS the MCPB manifest below (Apache-2.0) for the same code. |
| Runtime MCPB (Desktop extension) | `praxis-runtime/claude-extensions/praxis-runtime.mcpb` (manifest.json inside); `release/alpha.48/gitlab-release-assets/praxis-runtime.mcpb`; `desktop-install/praxis-runtime.mcpb` | **Apache-2.0** (manifest `license`, hard-coded at `praxis-runtime/tools/scripts/claude-extensions-shared.mjs:95` and `praxis-core/tools/scripts/claude-extensions-shared.mjs:87`) | **No** (archive contains only `manifest.json`, `server/praxis-mcp.cjs`, `server/praxis-quality.cjs`, `server/sql-wasm.wasm`) | MAJOR: declares Apache-2.0 but the package.json / plugin.json of the same code say UNLICENSED; Apache-2.0 with no LICENSE or NOTICE inside; it bundles UNLICENSED `@praxis/jira`, `@praxis/vcs`, `@praxis/cli`. `FIRST-RELEASE-PUBLISH-PLAN.md` says Runtime is UNLICENSED. Author is "dfuture-co". |
| Runtime bundle | `praxis-runtime/plugins/runtime/server/praxis-mcp.cjs` (3.1 MB), `server/sql-wasm.wasm`; same files in (M) `plugins/praxis-runtime/server/` and inside the MCPB | UNLICENSED (by plugin.json) | No; no third-party license text kept in the bundle (no `@license`/Copyright comments at all in `praxis-mcp.cjs`) | Third-party list in section 2. |
| praxis-ba (root) | `praxis-ba/package.json` line 29 | Apache-2.0 | **No root LICENSE** (only `plugins/ba/LICENSE`) | Root declares Apache-2.0 but root has no license text. |
| BA plugin | `praxis-ba/plugins/ba/{package.json,.claude-plugin/plugin.json}`; (M) `plugins/praxis-ba/...`; `release-candidate/plugins/praxis-ba/...` | Apache-2.0 | Yes: `plugins/ba/LICENSE` (13-line short notice: "Copyright 2026 Praxis contributors ... Licensed under the Apache License, Version 2.0"; it is the standard boilerplate header, NOT the full Apache-2.0 text) | Copyright holder "Praxis contributors" vs author "dfuture-co" (+ personal email `<withdrawn-address>` in BA plugin.json) vs repo owner `dfg-inc`. No NOTICE file although `tools/scripts/pack-claude-plugins.mjs:216-217` copies NOTICE if present. |
| BA canon-graph | `praxis-ba/plugins/ba/canon-graph/package.json`; (M) `plugins/praxis-ba/canon-graph/package.json` | none declared | covered by plugin LICENSE only by location | Sub-package has no license field inside an Apache plugin. |
| BA CLI bundle | (M) `plugins/praxis-ba/bin/praxis-ba.bundle.mjs` (735 KB), `bin/praxis-ba.cjs` | Apache-2.0 (by location) | plugin LICENSE only | Bundles third-party code (section 2) with only Jon Schlinkert header comments retained. |
| praxis-architect (root) | `praxis-architect/package.json` line 27 | Apache-2.0 | No root LICENSE (only `plugins/architect/LICENSE`) | `plugins/architect/README.md` line 13 "Apache-2.0". |
| Architect plugin | `praxis-architect/plugins/architect/{package.json,.claude-plugin/plugin.json}`; (M) `plugins/praxis-architect/*` | Apache-2.0 | Yes (same 13-line notice) | `session-bootstrap.cjs` bundles third-party code. |
| praxis-developer (root) | `praxis-developer/package.json` line 27 | Apache-2.0 | No root LICENSE | |
| Developer plugin | `praxis-developer/plugins/developer/*`; (M) `plugins/praxis-developer/*` | Apache-2.0 | Yes (same) | README lines 19 and 32 repeat "Apache-2.0". Contains agents `codebase-*`, `thoughts-*`, `web-search-researcher` (see 2c). |
| praxis-quality (root) | `praxis-quality/package.json` line 27 | UNLICENSED | No | |
| Quality plugin | `praxis-quality/plugins/quality/{package.json,.claude-plugin/plugin.json,README.md}`; (M) `plugins/praxis-quality/*` | UNLICENSED ("Company-internal QA plugin") | **No** (not in plugin dir, not in `praxis-quality.zip`) | CONTRADICTION: README says company-internal, yet it is installable from the public marketplace (`/plugin install praxis-quality --marketplace dfg-inc/praxis-marketplace`, `plugins/praxis-quality/README.md`) and shipped as a release asset (`release/alpha.48/gitlab-release-assets/praxis-quality.zip`). Its `tools/session-bootstrap.cjs` (580 KB) bundles the same third-party libraries as the Apache plugins. |
| Role ZIPs (Desktop Chat) | `release/alpha.48/gitlab-release-assets/praxis-{ba,architect,developer,quality}.zip`, `release/alpha.48/desktop-chat-full/*.zip`, `desktop-install/*.zip` | plugin.json inside: BA/Architect/Developer Apache-2.0; Quality UNLICENSED | LICENSE inside BA/Architect/Developer ZIPs; none in Quality ZIP | ZIPs are skills/prompts/README only (no JS, no third-party code). Also present: `praxis-split/praxis-ba-desktop-fixed.zip` (not inspected; not a release asset). |
| praxis-marketplace (root) | `praxis-marketplace/package.json` line 17 | UNLICENSED | No | Root catalog `.claude-plugin/marketplace.json` has no license field per plugin; so marketplace metadata does not say which plugin is under which license. |
| Marketplace bundle plugin "praxis" | (M) `plugins/praxis/.claude-plugin/plugin.json`, `release-candidate/plugins/praxis/...` | UNLICENSED | No | Installing "praxis" pulls Apache role plugins (BA/Architect/Developer) plus UNLICENSED Runtime and Quality as dependencies, so the aggregate is mixed. Author "Praxis" (not dfuture-co). |
| Marketplace plugin copies | (M) `plugins/*` vs `release-candidate/plugins/*` | same as the sources | LICENSE copies identical (md5 33f9e5a5...) | Staged copies consistent with sources for license fields. |
| Per-role `marketplace.json` | `*/plugins/*/.claude-plugin/marketplace.json`, (M) `.claude-plugin/marketplace.json`, `release-candidate/manifest.json` | no license field | n/a | |
| praxis-docs | `praxis-docs/package.json`, `apps/docs-site/package.json` | UNLICENSED | No | `docs/user/technical/plugin-manifests.md:43` documents the license split (BA/Architect/Developer Apache-2.0; Quality, Runtime, bundle UNLICENSED) and is itself UNLICENSED content. |
| Vendored Core tarballs (declared license only) | `praxis-{architect,ba,developer,quality,runtime}/vendor/*.tgz` alpha.48; `vendor/0.1.0-alpha.44/*.tgz` | `@praxis/contracts`, `knowledge`, `plugin-sdk`, `project-config`, `testing`: no license field. `@praxis/jira`, `@praxis/vcs`, `@praxis/cli`, `@praxis/catalog`: UNLICENSED. No LICENSE file inside any tgz. | No | Apache role repos vendor license-less packages (contracts/knowledge/plugin-sdk/project-config); Quality repo vendors UNLICENSED `@praxis/jira`. These tgz are tracked in the public repos (and in history). |
| Website (praxis-website) | `<monorepo>-website/package.json`, `site/package.json`, `site/docs/package.json` | none declared (`private: true`) | No LICENSE/NOTICE (only `site/public/fonts/geist/LICENSE.txt` and copies in `site/dist`) | Website text, images and code have no stated license or copyright footer in source. |
| Website font | `site/public/fonts/geist/` | SIL OFL 1.1, "Copyright (c) 2023 Vercel, in collaboration with basement.studio" | Yes, `LICENSE.txt` present and copied into `site/dist/fonts/geist/` and `site/dist/docs/fonts/geist/` | OK. |
| Website images / marks | `site/public/logos/claude.png`, `site/public/icons/github.svg`, `site/public/images/lens-*.webp`, `migration-order-*.png`, `og-praxis.png`, `favicon.*` | unknown | No | Claude logo and GitHub mark are third-party trademarks; `lens-*.webp` / illustration provenance not recorded in the repo (`implementation-provenance.json` lists authoring agents only). |
| Website npm deps (not distributed as source; code ends up in `site/dist`) | `site/package.json` | astro 7.3.3 MIT, react/react-dom 19.3.0 MIT, @astrojs/react MIT, tailwindcss/@tailwindcss/vite MIT, lucide-react 1.47.0 ISC, radix-ui MIT, class-variance-authority 0.7.1 Apache-2.0, clsx MIT, tailwind-merge MIT; docs: vitepress 1.6.3 MIT, mermaid 11.12.2 MIT | no third-party license file in `site/dist` other than Geist | Minified JS has no consolidated notices (`grep @license` found only `contact-form...js`). Lucide (ISC) and cva (Apache-2.0) need notices if redistributed in built form. |

### 1b. LICENSE files found (complete list outside node_modules)

- Apache boilerplate (13 lines, identical md5 `33f9e5a5548d3920b596253b8431333d`): `praxis-ba/plugins/ba/LICENSE`, `praxis-architect/plugins/architect/LICENSE`, `praxis-developer/plugins/developer/LICENSE`, (M) `plugins/praxis-{ba,architect,developer}/LICENSE`, (M) `release-candidate/plugins/praxis-{ba,architect,developer}/LICENSE`, plus the `dist/claude-plugins*-staging/*/praxis-*/LICENSE` and `dist/release-mirror/plugins/*/LICENSE` copies in the role repos.
- `praxis-website/site/public/fonts/geist/LICENSE.txt` (SIL OFL 1.1) and its dist copies.
- NOT present anywhere: LICENSE for Runtime, Quality, Core, Jira, docs, marketplace root, MCPB, website; any NOTICE / THIRD-PARTY file; any repository-root LICENSE.

### 1c. Statements in README/docs/release notes

| Statement | File | Issue |
|---|---|---|
| "BA, Architect, and Developer harnesses are Apache-2.0. Quality Harness has its own distribution and license terms." | `praxis-website/content/docs/index.md:58` | "own license terms" does not exist anywhere (Quality is UNLICENSED, no terms). |
| Catalog table "Apache-2.0 harness" for BA/Architect/Developer | `praxis-website/content/docs/catalog/index.md:8-10`, `concepts/marketplace.md:8-10`, `plugins/index.md:20-22` | Runtime not listed; Runtime license not stated on the website. |
| "Its distribution and license should be checked from its own release" | `praxis-website/content/docs/workflows/quality-only.md:3`; `plugins/quality.md:72` ("does not settle its license"); `getting-started/installation.md:29` ("use its supplied access and license terms"); `getting-started/requirements.md:42` | No supplied terms exist; the Quality ZIP has no LICENSE. |
| Quality "UNLICENSED (company-only). Not an Apache marketplace plugin and not in the public catalog"; "Quality ... stay UNLICENSED company infra ... not part of the public plugin lineup" | `praxis-website/site/docs/sources/praxis-marketplace/plugins/quality.md:12`, `site/docs/upstream/index.md:9`, `upstream/guide/start.md:24` ("No - company-only") | STALE and contradicted: Quality is in the public marketplace, a public repo, and a release ZIP at alpha.48 (and the site's own `docs/index.md` calls it "a delivered role package"). These docs are synced at alpha.44. |
| "Jira is company infra (UNLICENSED), not a public role plugin" | `praxis-website/site/docs/*/method/roles.md:10` | Jira code is inside the public Runtime bundle and in public repos. |
| "After the open-source cutover ... Apache-2.0 tree will be public" | `praxis-website/site/docs/upstream/index.md:7`, `guide/start.md:38` | Public repos have no root LICENSE. |
| "Company-internal QA plugin. UNLICENSED" | `praxis-quality/plugins/quality/README.md:3`, (M) `plugins/praxis-quality/README.md:3` | See above. |
| "Company-internal Jira Server integration ... UNLICENSED" | `praxis-core/plugins/jira/README.md:3` | |
| "Role manifests ... Apache-2.0; quality, runtime and the bundle are UNLICENSED" | `praxis-docs/docs/user/technical/plugin-manifests.md:43` | Contradicted by MCPB manifest (Apache-2.0 for Runtime). |
| `marketplace-acceptance.mjs` asserts roles must be Apache-2.0 and jira/quality must stay UNLICENSED | `praxis-core/tools/scripts/marketplace-acceptance.mjs:49-54`, same in `praxis-runtime/tools/scripts/` | A release gate hard-codes the current split; any license decision needs this script changed. Also `hosted-plugin-policy.mjs` compares `license` fields across manifests. |

### 1d. Contradictions found (summary)

1. Runtime MCPB manifest says Apache-2.0; Runtime package.json, plugin.json (all copies) and the docs say UNLICENSED. The MCPB has no LICENSE.
2. Apache-2.0 role plugins bundle (`session-bootstrap.cjs`, `praxis-ba.bundle.mjs`) and vendor Praxis packages with NO license (`@praxis/contracts`, `knowledge`, `project-config`, `plugin-sdk`); the website claims "Apache-2.0 where the package says so".
3. Quality: UNLICENSED/"company-internal" yet publicly installable and distributed; no LICENSE; website says both "company-only, not public" (alpha.44 sources) and "delivered role package with its own license terms".
4. Repo roots: `praxis-ba|architect|developer/package.json` declare Apache-2.0 but have no root LICENSE; core/runtime/quality/marketplace are UNLICENSED and public on GitHub, so default copyright law applies (all rights reserved; GitHub ToS viewing/forking rights only).
5. Apache LICENSE is a 13-line boilerplate notice, not the full Apache License 2.0 text; Apache-2.0 section 4 expects a copy of the License to be given to recipients. Copyright holder "Praxis contributors" is not a legal entity; manifests say author "dfuture-co", "Praxis", repo owner `dfg-inc`; BA plugin.json exposes a personal email.
6. Mixed-license aggregate: the "praxis" marketplace bundle (UNLICENSED) depends on Apache and UNLICENSED plugins; per-plugin licenses are not in `marketplace.json`.
7. Apache role plugin code shares distribution with UNLICENSED Jira/VCS code (Runtime bundle) and the Quality repo vendors UNLICENSED `@praxis/jira`.
8. Third-party notices are not shipped in any artifact (see section 2).
9. Docs describe Jira/Quality as "not published" (website sources at alpha.44) while their code is published.
10. Website has no license/copyright statement for its own content or imagery.

---

## 2. Third-party notices required per artifact

### 2a. Third-party code actually inside distributable artifacts

Identified from esbuild path comments in the bundles. Versions from `praxis-runtime/node_modules/*/package.json` unless noted.

| Package | Version | License | Where bundled | Notice obligation |
|---|---|---|---|---|
| zod | 3.25.76 | MIT | Runtime `praxis-mcp.cjs`, MCPB `praxis-mcp.cjs` and `praxis-quality.cjs`, all four `session-bootstrap.cjs`, `praxis-ba.bundle.mjs` | MIT: copyright + permission notice must accompany copies/substantial portions. Not shipped. |
| zod (v4 copies nested under MCP SDK, and `packages/mcp/node_modules/zod`) | 4.6.5 | MIT | Runtime / MCPB `praxis-mcp.cjs` | same |
| @modelcontextprotocol/server, @modelcontextprotocol/core (MCP TypeScript SDK) | 2.0.0 | `package.json` says MIT, but package `LICENSE` text says the project is "undergoing a licensing transition from MIT to Apache-2.0"; new code Apache-2.0, docs CC-BY-4.0, unconsented older contributions stay MIT | Runtime / MCPB `praxis-mcp.cjs` | Treat as MIT AND Apache-2.0: include the package LICENSE text verbatim (it carries the dual explanation); if Apache-2.0 parts are redistributed in a modified/bundled form, Apache-2.0 sec. 4 (license copy, preserve notices; include NOTICE if upstream has one; no NOTICE file found in the package). |
| ajv | 8.18.0 | MIT | inlined in `@modelcontextprotocol/server/dist/ajvProvider-*.mjs`, therefore in Runtime/MCPB `praxis-mcp.cjs` | MIT notice |
| ajv-formats | 3.0.1 | MIT | same | MIT notice |
| fast-uri | 3.1.0 | BSD-3-Clause (read from another local install of 3.1.0) | same | BSD-3: reproduce copyright, conditions and disclaimer in docs/other materials for binary redistribution; no endorsement. |
| fast-deep-equal | 3.1.3 | MIT (not verified locally; widely MIT) | same | MIT notice |
| json-schema-traverse | 1.0.0 | MIT (not verified locally) | same | MIT notice |
| gray-matter | 4.0.3 | MIT | Runtime/MCPB `praxis-mcp.cjs`, `praxis-quality.cjs`, all `session-bootstrap.cjs`, `praxis-ba.bundle.mjs` | MIT notice (Copyright Jon Schlinkert; only two "Copyright (c) 2015" comment lines survive in the bundles) |
| extend-shallow 2.0.1, is-extendable 0.1.1, kind-of 6.0.3, section-matter 1.0.0, strip-bom-string 1.0.0 | as listed | MIT (transitive of gray-matter) | same | MIT notice each |
| js-yaml | 3.15.2 | MIT | same | MIT notice (also `require("esprima")` left external in the bundle, an unresolved optional dependency; esprima is BSD-2-Clause but is NOT bundled) |
| yaml | 2.9.1 | ISC | Runtime/MCPB `praxis-mcp.cjs`, all `session-bootstrap.cjs`, `praxis-ba.bundle.mjs` | ISC: copyright + permission notice must be kept. |
| sql.js (JS glue in `praxis-quality.cjs`) and `sql-wasm.wasm` | 1.14.2 | MIT (`node_modules/sql.js/LICENSE` also lists portions under MIT from Ryusei Yamaguchi; the WASM embeds SQLite, which is public domain, and an Emscripten runtime, normally MIT/UIUC; those two are not stated in the sql.js LICENSE file and were not verified) | MCPB `server/` and (M) `plugins/praxis-runtime/server/sql-wasm.wasm` (658 KB); `praxis-mcp.cjs` locates it | MIT notice for sql.js; confirm Emscripten/SQLite statements upstream before final NOTICE. |
| @praxis/contracts, knowledge, project-config, plugin-sdk (own code) | alpha.48 | NONE declared | bundled in Runtime, Quality service bundle, all `session-bootstrap.cjs` (including the Apache plugins) | Own code: no third-party notice, but license must be declared (owner decision). |
| @praxis/jira, vcs, cli (own code) | alpha.48 | UNLICENSED | Runtime / MCPB `praxis-mcp.cjs` only | Own code; this is the only UNLICENSED code inside the Apache-labelled MCPB. |
| prototype viewer (inline HTML in the Runtime bundle, `praxis-mcp.cjs:8914`) | n/a | no CDN URLs found | Runtime | No third-party notice found (grep for cdn/unpkg URLs returned none). |

Dev-only / not in any artifact (no distribution notice): esbuild (MIT, build tool), vitest/@vitest/* (MIT), jsdom (dev only), typescript, `@anthropic-ai/*` packages seen in `praxis-runtime/node_modules` (build/test tooling; not found in the bundles' path comments).

Current state: NO artifact ships a THIRD-PARTY-NOTICES or per-package license text. Esbuild dropped the license banners. This does not meet the notice requirements of MIT/ISC/BSD-3 for the Runtime bundle, the MCPB, and the marketplace plugins that contain bundled JS.

### 2b. Required notices per artifact

| Artifact | Contains third-party code? | Notices required (to include if distributed) |
|---|---|---|
| `praxis-runtime.mcpb` (Desktop extension) | Yes (largest set) | A `THIRD-PARTY-NOTICES` file (or per-package license texts) in the archive covering: zod 3.25.76 and 4.6.5, @modelcontextprotocol/server+core 2.0.0 (full LICENSE text, MIT + Apache-2.0 transition wording), ajv, ajv-formats, fast-deep-equal, json-schema-traverse (MIT), fast-uri (BSD-3-Clause), gray-matter, extend-shallow, is-extendable, kind-of, section-matter, strip-bom-string, js-yaml (MIT), yaml (ISC), sql.js (MIT, plus SQLite/Emscripten statement). Plus Praxis' own LICENSE/terms file matching the manifest. |
| Marketplace plugin `praxis-runtime` (`plugins/praxis-runtime/server/*`) | Yes (same bundle as above + `sql-wasm.wasm`) | Same list. Plugin directory has no LICENSE at all today. |
| Marketplace plugin `praxis-ba` (`bin/praxis-ba.bundle.mjs`, `tools/session-bootstrap.cjs`) | Yes | zod 3.25.76, gray-matter and its 5 transitive MIT packages, js-yaml 3.15.2, yaml 2.9.1. Apache-2.0 plugin LICENSE alone is not a notice for them. |
| Marketplace plugins `praxis-architect`, `praxis-developer` (`tools/session-bootstrap.cjs`) | Yes | Same set as BA minus the BA bundle. |
| Marketplace plugin `praxis-quality` (`tools/session-bootstrap.cjs`) | Yes | Same set. Also needs its own LICENSE/terms (none). |
| Marketplace plugin `praxis` (bundle; `skills/` + README only) | No | Only the Praxis license/terms; dependencies are the plugins above. |
| Desktop ZIPs `praxis-{ba,architect,developer,quality}.zip` | No code, only skills/prompts/README/LICENSE (BA/Architect/Developer) | No third-party notices needed; need Praxis license text (full Apache-2.0 text for the three, nothing for Quality). The ZIPs are skills-only and do not include `session-bootstrap`. |
| `praxis-docs` / website build | Website: Geist (OFL 1.1, notice present), Lucide ISC, cva Apache-2.0, others MIT in `site/dist` JS bundle; docs site uses vitepress/mermaid (MIT) | A website "open source notices" page or `THIRD-PARTY.txt` served with the site; trademark/usage check for the Claude logo (`site/public/logos/claude.png`) and GitHub mark; confirm image provenance. |

### 2c. Bundled prompts, templates, skills, datasets of unclear origin (from files only)

Observations only; no external lookup was done and no claim of infringement is made.

| Item | Location | Apparent provenance from the files | Flag |
|---|---|---|---|
| Developer research sub-agents `codebase-analyzer`, `codebase-locator`, `codebase-pattern-finder`, `thoughts-analyzer`, `thoughts-locator`, `web-search-researcher` | `praxis-developer/plugins/developer/agents/*.md`; (M) `plugins/praxis-developer/agents/` | Each file is a short (about 10-20 line) stub with `version: "0.1.0"` and the description "Developer research sub-agent (name)". No author, source or license header. The set of six names and the `thoughts-*` (a "thoughts" directory concept) naming resembles a widely-circulated community agent set; the files here do not copy long upstream prose and no origin note exists. | Owner to confirm these are original; if derived, attribution/license of the source is unknown. |
| Skill `caveman` | `praxis-developer/plugins/developer/skills/caveman/SKILL.md` | Short bilingual (EN/RU) skill, "WBS 5.11", references Praxis stack rules/context slice; no origin note. Name suggests a known community "caveman" mode, but the file content is Praxis-specific. | Confirm originality. |
| Skills `grill`, `grill-cr`, `council`, `lens-review` etc. | `praxis-architect/plugins/architect/skills/grill/SKILL.md`; BA `skills/grill-cr` | `grill` front matter: "Architect Phase 1 port from praxis feat/grill-rules"; `agents/max.md:21` "Hard rules (ported from praxis unmerged branches)". These point to an internal prior Praxis monorepo ("Praxis-mono"/"praxis" branches), not to a third party. The "one question at a time, each with a recommended answer" pattern is a popular community pattern; no third-party text identified. | Internal provenance only (the old monorepo). Confirm all contributors assigned rights to the owner. |
| Templates and rules | `praxis-ba/plugins/ba/templates/*.md`, `rules/{ba-ac-gherkin,ba-requirement-has-goal}.md`, `praxis-architect/.../templates/*.md` | Praxis-specific ADLC/WBS wording. "Gherkin" is a name/format (Cucumber), not copied text. | Low risk. |
| Knowledge dataset | `praxis-core/packages/knowledge/dataset/company/**`, `product/demo/precedents/async-queue-gds.md` | Company-internal content: `sourceDoc: <handbook-label-1>` v1.0.0, "Company retired Jira Server". Ships in `@praxis/knowledge` tgz in all public repos' `vendor/`. | Confidentiality and ownership question: this looks like extracts of an internal corporate handbook (employer content?). Needs owner confirmation that it may be public. Not inside the bundles/ZIPs. |
| Prompts | `*/prompts/{jira-role,ui-examples}.md` | Praxis-specific. | Low risk. |
| Test fixtures | `praxis-core/tools/e2e/fixtures/*` (demo-widget, demo-greeter) | Minimal sample apps, no license. | Low risk. |
| Website imagery | `praxis-website/site/public/images/lens-*.webp`, `migration-order-*.png`, `og-praxis.png` | No origin record. `implementation-provenance.json` lists "agentId" authors and a Figma role only. | Confirm origin (design tool vs generated) and rights. |
| Third-party marks | `site/public/logos/claude.png`, `icons/github.svg` | Anthropic and GitHub marks. | Needs trademark-use check; not covered by any license grant. |

---

## 3. Proposed single licensing policy (options for the owner)

Goal: one statement per artifact family that the manifests, LICENSE files, README/docs and the website all repeat. The three options below are alternatives; none is selected here. In all options: ship a full license text, a THIRD-PARTY-NOTICES file inside every artifact that bundles code (section 2), and one named copyright holder (a legal entity).

### Option A: Proprietary, all rights reserved, with beta usage terms (keep `UNLICENSED`/`SEE LICENSE IN LICENSE`)

- Applies to all components (including the three roles that are Apache-2.0 today) or only to Runtime/Quality/Core with roles unchanged (a "mixed" variant).
- Pros: matches current Core/Runtime/Quality/Jira posture and `FIRST-RELEASE-PUBLISH-PLAN.md`; keeps all commercial options open; simplest to explain; lets you gate Quality; easy to relax later.
- Cons: Apache-2.0 already published (or published via public GitHub/marketplace in role ZIPs at alpha.44-48) cannot be withdrawn for copies already obtained; public GitHub repos with all-rights-reserved give users no right to use beyond viewing, so "install and use" needs explicit terms; contradicts the website's "open-source lineup" messaging; may hinder community or enterprise adoption; needs a written beta terms/EULA file.

### Option B: Source-available (for example a source-available or fair-code style license with use restrictions, or Business Source style with a change date)

- Pros: code stays visible (matches public repos), users can self-host and inspect, restricts commercial resale/competing hosted services, can convert to open source after a date.
- Cons: not "open source" by the OSI definition, so the website's Apache/open-source messaging must change; license text needs legal review; Apache-2.0 already granted for earlier role-plugin versions stays valid for those versions; some enterprises avoid such licenses; custom terms increase review burden.

### Option C: Permissive open source (for example Apache-2.0 or MIT across all repos)

- Pros: consistent with current role plugins and website messaging, simple notices, patent grant (Apache-2.0), maximum adoption; removes the Runtime-vs-MCPB contradiction by making everything one license.
- Cons: irreversible for published versions; gives up exclusivity on Runtime, Quality and Jira code (which hold internal company logic, and Jira/knowledge dataset may contain employer-specific material); requires all contributors and any employer to have assigned/licensed rights; the corporate handbook dataset and Jira integration would need review before relicensing; Quality Platform plans (private product) would need a clear boundary.

A hybrid (permissive roles/skills, proprietary Runtime/Quality/Jira) is the current state; it is workable only if the boundary is enforced in artifacts: separate LICENSE files per artifact, the MCPB manifest corrected, and Apache plugins not bundling UNLICENSED code.

### Draft "beta usage terms" bullets (for Option A or as a front-matter to any option; wording to be reviewed by counsel)

- Praxis alpha/beta software is provided "as is" for evaluation and internal use, without warranty or support commitment; versions may change or be withdrawn.
- You may install and run the Desktop ZIPs, MCPB and marketplace plugins for your own or your organization's internal evaluation; you may not redistribute, resell, sublicense or host them as a service without written permission. (Remove or adapt for Option B/C.)
- No reverse engineering, except where law allows or where a component is expressly open source.
- Third-party components are under their own licenses, listed in THIRD-PARTY-NOTICES shipped with each artifact.
- Praxis stores state locally in your repositories and `.praxis`; the owner does not collect your project data, and tokens you enter (Jira, GitHub, GitLab) stay in your OS secret storage (verify against actual telemetry before publishing this bullet).
- You are responsible for approvals of protected actions (commits, pushes, Jira writes) that Praxis asks you to approve; the owner is not liable for changes you approve.
- Feedback you submit may be used by the owner without obligation.
- Quality Harness and any future Quality Platform may require separate access terms.
- Names, logos and marks (Praxis, Claude, GitHub) are not licensed by these terms.
- Terms may change between releases; continued use after an update constitutes acceptance. Governing law and contact: to be filled by the owner.
- Beta terms end or convert when a final license is chosen; previously published Apache-2.0 versions remain under Apache-2.0.

---

## 4. Questions only the OWNER can decide

1. Who is the copyright holder and licensor (legal entity: "dfuture-co", "dfg-inc", "Praxis contributors", an individual)? Which name goes into LICENSE/NOTICE, manifests `author`, and the MCPB manifest? Do employment/contractor agreements assign contributions to that entity? (Employer rights are not provable from files.)
2. Overall approach: Option A, B, C or the current hybrid? Is one license for the whole ecosystem preferred, or per-artifact?
3. Runtime: is the MCPB/Runtime Apache-2.0 (as the manifest says), or UNLICENSED/proprietary (as package.json, plugin.json, docs and the release plan say)? Which one is the truth for already-published artifacts?
4. Quality (plugin, ZIP, marketplace entry, GitHub repo): public, restricted, or closed? Under what terms is it installable? Should it remain in the public marketplace while UNLICENSED?
5. Core packages (`@praxis/contracts`, `knowledge`, `project-config`, `plugin-sdk`) and Jira/VCS/CLI: what license applies, given Apache role plugins embed them?
6. Have any Apache-2.0 role-plugin versions (alpha.44-48) already been distributed publicly (GitLab releases, GitHub, marketplace)? If so, does the owner want to keep Apache-2.0 for those versions regardless of future choices?
7. The public GitHub repos (`dfg-inc/*`) currently have no root LICENSE: should they be made private, get a license, or stay "UNLICENSED" with explicit terms in README? Is GitHub "public" intended to grant any rights?
8. The corporate-handbook knowledge dataset (`packages/knowledge/dataset/company/**`) and company-specific wording (Jira Server retirement, `<internal-gitlab>` references): may these be published? Do they belong to the owner or an employer/client?
9. Provenance of the six Developer agents, `caveman`, `grill*` skills, templates, rules and website images: original work, derived, or generated? If derived, which source and license?
10. Trademarks: is use of the Claude and GitHub marks on the website acceptable, and is the name "Praxis" owned/cleared?
11. Beta terms: approve, change or reject the draft bullets; who is the governing law/contact; is a click-through or only a file in the archive acceptable?
12. Is a Contributor License Agreement or DCO needed for external contributions once repos are public?
13. Should the Apache LICENSE be replaced with the full Apache-2.0 text plus a NOTICE (if Option C/hybrid), and should the personal email in BA plugin.json be removed?
14. Whether the marketplace `praxis` bundle plugin should state a single umbrella license and how its dependency licenses are communicated to users.
15. Who maintains THIRD-PARTY-NOTICES and gating in `marketplace-acceptance.mjs` after the decision?

---

## 5. Low-risk metadata fixes that do not assign a license

All items are listed as proposals only; none was applied. Items marked PENDING depend on an owner decision.

A. Do not need an owner choice of license (factual consistency):
1. Generate and ship a `THIRD-PARTY-NOTICES.txt` (package name, version, license, copyright, full license text for each package in section 2a) in: the MCPB, `praxis-marketplace/plugins/praxis-runtime/`, `.../praxis-ba/`, `.../praxis-architect/`, `.../praxis-developer/`, `.../praxis-quality/`, and optionally the ZIPs. Have the build (`pack-claude-plugins.mjs`, `mcpb-runtime.mjs`, `mcp-bundle.mjs`) copy it. esbuild `--legal-comments=linked|external` would preserve upstream banners (zod, yaml, etc.).
2. Add the MCP SDK `LICENSE` text verbatim to the notices (it explains the MIT-to-Apache-2.0 transition).
3. Make the website and `praxis-docs` statements factual about the present state: replace "Quality has its own license terms" (`praxis-website/content/docs/index.md:58`, `installation.md:29`, `requirements.md:42`, `workflows/quality-only.md:3`, `plugins/quality.md:72`) with the real manifest value (UNLICENSED, no terms file) until a decision is made; refresh the alpha.44 `site/docs/sources/praxis-marketplace/**` and `site/docs/upstream/**` copies that still say Quality is "not in the public catalog".
4. Add `license` field presence checks (including `canon-graph` and core packages) to `hosted-plugin-policy.mjs` as a warning, not a value.
6. Add an explicit `license` or `"private": true` + `"license": "UNLICENSED"` to the website `package.json` files only after owner confirms (PENDING, since UNLICENSED is a position).
7. Reconcile the `author` fields (`Praxis` vs `dfuture-co`) and remove the personal email from `praxis-ba/plugins/ba/.claude-plugin/plugin.json` (privacy hygiene; the owner chooses the replacement).
8. Add an origin note (author/source/"original") to the six agent stubs, `caveman`, `grill*`, and a `PROVENANCE.md` for the knowledge dataset and website images once the owner answers questions 8-9.
9. Run `npm pack --dry-run`/archive listing in CI to assert every artifact contains a LICENSE (or terms file) and THIRD-PARTY-NOTICES.

B. PENDING owner decision (do not apply before):
1. Align the MCPB manifest `license` (`claude-extensions-shared.mjs` in both core and runtime) with the Runtime's decided license; add the matching LICENSE file into the MCPB.
2. Add LICENSE/terms to `praxis-quality` plugin and ZIP (currently none) and to Runtime plugin directories.
3. Add a root LICENSE to each repo; replace the 13-line Apache boilerplate with the full Apache-2.0 text if Apache stays; add NOTICE.
4. If the owner decides on one license: set `license` consistently in root, workspaces and plugin manifests (for example `"SEE LICENSE IN LICENSE"` for a custom/proprietary choice, or an SPDX id), update `marketplace-acceptance.mjs:49-54`, `hosted-plugin-policy.test.mjs`, `catalog.json`, and the website catalog tables.
5. Add a per-plugin `license` entry in the marketplace `marketplace.json` (supported fields should be checked against the Claude plugin schema first).
6. Stop shipping UNLICENSED `@praxis/jira|vcs|cli` inside an Apache-labelled artifact, or relabel the artifact.
7. Decide whether the knowledge dataset is removed from public `vendor/*.tgz` history-forward.

---

## Resolution (2026-10-29)

The owner decided: Praxis is distributed under the **Apache License 2.0** (`Apache-2.0`), copyright holder name as used in the manifests: `dfuture-co` (year 2026). Implemented in the alpha.49 release candidate: official full text in LICENSE and a NOTICE in all seven repositories and every distributed plugin and archive; every manifest, README and catalog entry says Apache-2.0 (the earlier UNLICENSED declarations, the "company-only / not public Apache" wording and the short LICENSE stubs are gone); THIRD-PARTY-NOTICES.md with the unchanged licence texts of the bundled third-party packages (Runtime/MCPB: 18 packages; role plugins: 9). Findings 1-5 and 8 of section 4 are closed. Still open and owner-only (cannot be settled from files): the legal name of the holder, the rights to publish the company handbook dataset and the unattributed prompts/skills (section 2c), the `<corporate-domain>` commits, and the website/third-party marks. See RELEASE-CHECKLIST-alpha.49.md, section B.

Round 12 update: the dataset in `@praxis/knowledge` is no longer packaged or kept in the Core tree, the adapted `grill-cr` text carries its MIT notice, the personal e-mail is removed and `author` is `dfuture-co`; see PROVENANCE-AUDIT.md (status block) and the archive-content gate `check-public-content.mjs`.
