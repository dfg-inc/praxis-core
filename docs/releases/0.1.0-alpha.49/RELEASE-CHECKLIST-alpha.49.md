# Release candidate checklist: Praxis 0.1.0-alpha.49

Status 2026-10-29: **release candidate prepared locally, not published.** Everything below that says "run" is a command for the owner (or for me after an explicit go). Nothing was pushed, tagged, merged, released or written to a Marketplace.

## A. State of the candidate (verified)

| Repo (branch `feature/ux-overhaul`) | Head | Version | Licence files |
|---|---|---|---|
| praxis-core | code `7e4fe59` (documents-only commits on top) | 0.1.0-alpha.49 | LICENSE (Apache-2.0, official text, sha256 `cfc7749b…`), NOTICE |
| praxis-runtime | `13c3cba` | alpha.49 | LICENSE, NOTICE, THIRD-PARTY-NOTICES.md (18 packages + Emscripten and musl notices for `sql-wasm.wasm`) |
| praxis-ba | `a2d6916` | alpha.49 | LICENSE, NOTICE, THIRD-PARTY-NOTICES.md (9 packages + the MIT notice for the adapted `grill-cr` text) |
| praxis-architect | `84c5378` | alpha.49 | LICENSE, NOTICE, THIRD-PARTY-NOTICES.md (9 packages) |
| praxis-developer | `2014cfe` | alpha.49 | same |
| praxis-quality | `0e24520` | alpha.49 | same |
| praxis-marketplace | `bd5ecc7` | alpha.49 | LICENSE, NOTICE at the root and in every plugin (staged) |

- `npm run verify`: exit 0 in all seven on this state, including the new content gate (`check:public`, 28 archives and vendor tarballs extracted and scanned). See FINAL-REPORT round 12.
- Marketplace install in a clean profile (Claude Code CLI 2.1.304): PASS, 11 checks, including the in-place upgrade alpha.48 to alpha.49 (praxis-ba, praxis-runtime) and a single-role install. Rollback (uninstall, then install from the previous marketplace revision) verified: back to alpha.48.
- Built archives (`praxis-runtime.mcpb`, four role ZIPs) carry LICENSE and NOTICE; the MCPB also carries THIRD-PARTY-NOTICES.md; their manifests say Apache-2.0. No `UNLICENSED` anywhere in tracked files or in the built archives and vendor tarballs.
- Not touched: `praxis-docs`, `vendor/0.1.0-alpha.44`, the installed alpha.48 Desktop extension, the lab.

## B. Licensing: DECIDED (owner, 2026-10-29): Apache-2.0
- [x] Full official Apache License 2.0 text in LICENSE of all seven repositories (and every distributed plugin/archive).
- [x] All `package.json`, `plugin.json`, MCPB manifest, catalog, READMEs, marketplace entries: `Apache-2.0`.
- [x] Copyright line: `Copyright 2026 dfuture-co`, as chosen by the owner (the name used as `author` in the manifests). The owner keeps `dfuture-co` until the official legal name is given; none was invented.
- [x] Third-party notices shipped with every build output that bundles third-party code (MIT, ISC, BSD-3-Clause, MCP SDK MIT/Apache transition text; Emscripten MIT/UIUC and musl MIT for `sql-wasm.wasm`, texts from the Emscripten 5.0.0 tag). Nothing third-party was relicensed.
- [x] The unconfirmed corporate knowledge dataset is no longer shipped (see C0). Originality of the other prompts and skills: no match found against the checked sources (PROVENANCE-AUDIT section 3); `grill-cr` carries the MIT notice.
- [x] `author` is dfuture-co in every manifest; the personal e-mail is gone.
- Website imagery and the Claude/GitHub marks are outside this change.
- Known gap (not required by Apache-2.0 for internal build inputs): the vendored `@praxis/*` tarballs carry LICENSE but not NOTICE; the shipped artifacts carry both.

## C. Decisions and remaining items (state after round 14)

**Accepted by the owner (closed, not blockers):** Apache-2.0 is cleared for publication; `Copyright 2026 dfuture-co` until the official legal name is given; Git history, old GitHub Releases, vendor archives and the corporate dataset in earlier releases are left as they are (accepted residual risk: internal process information stays publicly available there; alpha.49 excludes the dataset); `owner.name: Praxis` stays; `sql-wasm.wasm` is the unmodified upstream `sql.js@1.14.2` and now ships its Emscripten and musl notices.

**Closed by work:** dataset out of every package and the Core tree; `grill-cr` MIT notice; `author` dfuture-co, personal e-mail removed; no developer paths or internal hosts in packages, messages, tests, documents; archive-content gate in `verify`; install, upgrade and rollback verified; H3 negative control automated (below).

**Real remaining limits (not blocking the build; stated in the release notes):**
1. A person pressing Reject in the real Claude Code dialog is **NOT VERIFIED**. The automated negative control (`manual-lab/h3-automated.mjs`, real Runtime alpha.49 from the Marketplace plugin, official MCP client, scripted decline, cancel and decision=reject, plus an agent with no dialog) PASSED: `APPROVAL_REJECTED` / `APPROVAL_CLIENT_UI_REQUIRED`, Story stays `proposed`, `approvals[]` empty, Work Item file byte-identical, no `independent-human`. It is not a human refusal. APR-0002 (earlier unexplained client approval) stays INCONCLUSIVE.
2. Claude Desktop Code/GUI dialog, Desktop Chat on alpha.49, live Jira, Linux and Windows: NOT VERIFIED.
3. `sql-wasm.wasm`: inherited from upstream, the contrib file `extension-functions.c` inside it has no licence text (not used by Praxis); the Emscripten toolchain of the upstream build is not provable from the binary.
4. Legal name behind the NOTICE line is not official yet; the corporate Apache-2.0 grant is taken as given.
5. Quality: no OS sandbox for project code, trusted projects only; browser checks need an operator-installed Playwright; 31/31 of the lab Work Item is honest execution but not strong proof (`QUALITY-BACKLOG.md`); deferred S5, S6, S14, RD2, P3.
6. `check-public-content` and the provenance checks are pattern and overlap checks with no secret scanner and no legal clearance.

**Before publication (owner action):** the go for merge, tags, GitHub Releases (Releases alpha.45-48 already exist), Marketplace push; optionally the real-client Reject check (commands in `OWNER-DECISIONS-alpha.49.md`).

## D. Pre-publication re-check (run, in `<praxis-split>`)
```bash
for r in praxis-core praxis-runtime praxis-ba praxis-architect praxis-developer praxis-quality praxis-marketplace; do git -C $r status --short | wc -l; git -C $r log -1 --format="$r %h"; done
export PRAXIS_BA_ROOT=$PWD/praxis-ba PRAXIS_DEVELOPER_ROOT=$PWD/praxis-developer PRAXIS_ARCHITECT_ROOT=$PWD/praxis-architect PRAXIS_QUALITY_ROOT=$PWD/praxis-quality
for r in praxis-core praxis-runtime praxis-ba praxis-architect praxis-developer praxis-quality praxis-marketplace; do (cd $r && npm run verify) || break; done
git -C praxis-runtime checkout -- claude-extensions; for r in praxis-ba praxis-architect praxis-developer praxis-quality; do git -C $r checkout -- claude-plugins; done   # the scripts rewrite archives; timestamp-only changes
(cd praxis-runtime && node tools/scripts/marketplace-install-acceptance.mjs --previous 3c0ab03)
(cd praxis-marketplace && node tools/scripts/check-public-content.mjs)   # extracts and scans the archives and vendor tarballs; requires the Emscripten/musl notices wherever a .wasm ships
```

## E. Publication sequence (nothing here has been run; each step needs the owner's explicit go)
State of GitHub on 2026-10-29 (read-only API check): all seven repositories are public; Releases exist for alpha.45-48 in runtime, ba, architect, developer, quality and alpha.47 in core (so alpha.48 is already public); praxis-marketplace has no Release. The step below creates the first alpha.49 tags and Releases.
Order follows `release/alpha.48/GITHUB-PUBLISH-PLAN.md`: ba, quality, developer, architect, core, runtime, marketplace (siblings are checked out by CI from GitHub). Remotes: `origin` is GitHub for core, runtime and the four roles; for marketplace GitHub is `github` (`origin` is GitLab).

1. Merge locally, no force, no PR bypass (per repo, on a clean `master` that equals `origin/master`):
```bash
for r in praxis-ba praxis-quality praxis-developer praxis-architect praxis-core praxis-runtime; do git -C $r switch master && git -C $r merge --no-ff feature/ux-overhaul -m "Merge feature/ux-overhaul: 0.1.0-alpha.49"; done
git -C praxis-marketplace switch master && git -C praxis-marketplace merge --no-ff feature/ux-overhaul -m "Merge feature/ux-overhaul: 0.1.0-alpha.49"
```
2. Re-run section D on the merge commits. Stop on any failure.
3. Disable the release workflows so a tag cannot rebuild different bytes (as in alpha.48): `gh workflow disable release.yml -R dfg-inc/<repo>` for core, runtime, ba, architect, developer, quality.
4. Tag (annotated) on the merge commit, then push master and the tag, no force:
```bash
for r in praxis-ba praxis-quality praxis-developer praxis-architect praxis-core praxis-runtime; do git -C $r tag -a v0.1.0-alpha.49 -m "Praxis 0.1.0-alpha.49" && git -C $r push origin master && git -C $r push origin v0.1.0-alpha.49; done
```
5. Build the release assets from the tagged commits: `praxis-runtime.mcpb` and `praxis-{ba,architect,developer,quality}.zip` from `claude-extensions/` and `claude-plugins/`; `release-meta.json` per asset with `write-release-meta.mjs` (env `PRAXIS_RELEASE_ARTIFACT_NAME`, `PRAXIS_RELEASE_SEARCH_ROOT`, `PRAXIS_RELEASE_KIND=mcpb|zip`, `GITHUB_SHA`); `SHA256SUMS`; `compatibility.json` with the new heads. Same bytes for every destination.
6. GitHub Releases, five repos, exactly those assets:
```bash
gh release create v0.1.0-alpha.49 --verify-tag -R dfg-inc/praxis-runtime --title "Praxis 0.1.0-alpha.49" --notes-file praxis-marketplace/RELEASE-NOTES-0.1.0-alpha.49.md --prerelease <assets>
# repeat for praxis-ba, praxis-architect, praxis-developer, praxis-quality with their ZIP + release-meta.json
```
7. Marketplace (production write): `git -C praxis-marketplace push github master` (fast-forward), then verify publicly:
```bash
export CLAUDE_CONFIG_DIR=$(mktemp -d) && claude plugin marketplace add dfg-inc/praxis-marketplace && claude plugin install praxis@praxis && claude plugin list
(cd praxis-runtime && node tools/scripts/marketplace-install-acceptance.mjs --marketplace dfg-inc/praxis-marketplace --previous 3c0ab03)
```
8. Re-enable (or deliberately leave disabled) the release workflows; docs and website update (owner).

## F. Rollback (verified locally on a throwaway profile)
- **User side (plugins):** previous marketplace revision is `3c0ab03` (alpha.48). Tested sequence: `claude plugin marketplace update praxis` against the old revision, `claude plugin uninstall <name>@praxis`, `claude plugin install <name>@praxis` gives alpha.48. Desktop Chat: reinstall the alpha.48 `praxis-runtime.mcpb` from the alpha.48 release assets and restart.
- **Marketplace side:** push a revert commit that restores the alpha.48 marketplace content (new commit, never a force-push): `git -C praxis-marketplace revert -m 1 <merge sha> && git -C praxis-marketplace push github master`.
- **Tags and Releases:** never move or delete a pushed tag. Mark the GitHub Release as pre-release or edit its notes with the known issue; fix forward with a new version.
- **Data:** Work Items written by the new Runtime are migrated to 1.1.0; the original is kept as `<id>.json.v1.0.0.bak` (byte-identical to what alpha.48 wrote). Restoring that file returns the Work Item to alpha.48 (decisions made after the migration are lost). The installed alpha.48 and the lab were never modified.
- **Evidence:** browser evidence under `.praxis/quality/` can be deleted; criteria then read as unproven, not failed.

## G. After publication
- [ ] State in the release notes: Desktop Code/GUI and Desktop Chat dialogs NOT VERIFIED on this build; Linux/Windows NOT VERIFIED; live Jira NOT VERIFIED.
- [ ] Open issues for the deferred list and for `QUALITY-BACKLOG.md`.
