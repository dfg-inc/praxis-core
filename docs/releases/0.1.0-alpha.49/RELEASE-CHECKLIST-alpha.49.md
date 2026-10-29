# Release candidate checklist: Praxis 0.1.0-alpha.49

Status 2026-10-29: **release candidate prepared locally, not published.** Everything below that says "run" is a command for the owner (or for me after an explicit go). Nothing was pushed, tagged, merged, released or written to a Marketplace.

## A. State of the candidate (verified)

| Repo (branch `feature/ux-overhaul`) | Head | Version | Licence files |
|---|---|---|---|
| praxis-core | `cab84df` | 0.1.0-alpha.49 | LICENSE (Apache-2.0, official text, sha256 `cfc7749b…`), NOTICE |
| praxis-runtime | `07529e5` | alpha.49 | LICENSE, NOTICE, THIRD-PARTY-NOTICES.md (18 packages) |
| praxis-ba | `b48c027` | alpha.49 | LICENSE, NOTICE, THIRD-PARTY-NOTICES.md (9 packages) |
| praxis-architect | `7fc5683` | alpha.49 | same |
| praxis-developer | `65da885` | alpha.49 | same |
| praxis-quality | `ed2210c` | alpha.49 | same |
| praxis-marketplace | `876621f` | alpha.49 | LICENSE, NOTICE at the root and in every plugin (staged) |

- `npm run verify`: exit 0 in all seven (final run on this state; see FINAL-REPORT round 10).
- Marketplace install in a clean profile (Claude Code CLI 2.1.304): PASS, 11 checks, including the in-place upgrade alpha.48 to alpha.49 (praxis-ba, praxis-runtime) and a single-role install. Rollback (uninstall, then install from the previous marketplace revision) verified: back to alpha.48.
- Built archives (`praxis-runtime.mcpb`, four role ZIPs) carry LICENSE and NOTICE; the MCPB also carries THIRD-PARTY-NOTICES.md; their manifests say Apache-2.0. No `UNLICENSED` anywhere in tracked files or in the built archives and vendor tarballs.
- Not touched: `praxis-docs`, `vendor/0.1.0-alpha.44`, the installed alpha.48 Desktop extension, the lab.

## B. Licensing: DECIDED (owner, 2026-10-29): Apache-2.0
- [x] Full official Apache License 2.0 text in LICENSE of all seven repositories (and every distributed plugin/archive).
- [x] All `package.json`, `plugin.json`, MCPB manifest, catalog, READMEs, marketplace entries: `Apache-2.0`.
- [x] Copyright line: `Copyright 2026 dfuture-co`, as chosen by the owner (the name used as `author` in the manifests). **Open for the owner:** the full legal name of the rights holder; I did not invent one.
- [x] Third-party notices shipped with every build output that bundles third-party code (MIT, ISC, BSD-3-Clause, MCP SDK MIT/Apache transition text). Nothing third-party was relicensed.
- [ ] **Owner confirmations that cannot be checked from the files** (do not block the technical RC):
  1. Rights to publish under Apache-2.0 the content marked company-internal in `LICENSE-AUDIT.md`: knowledge dataset `packages/knowledge/dataset/company/**` (`sourceDoc: corp-engineering-handbook`), which ships inside `@praxis/knowledge` and the Runtime build.
  2. Originality of the unattributed prompts and skills listed in `LICENSE-AUDIT.md` section 2c (developer research sub-agents, `caveman`, ported `grill` skills).
  3. A few commits carry a `jetruby.com` author address; confirm that no third-party employer holds rights.
  4. Website imagery and the Claude/GitHub marks are outside this change.
- Known gap (not required by Apache-2.0 for internal build inputs): the vendored `@praxis/*` tarballs carry LICENSE but not NOTICE; the shipped artifacts carry both.

## C. Remaining owner decisions before publication
1. Confirm the legal name of the copyright holder (B).
2. Confirm the three rights items in B.
3. Controlled H3 retest (press Reject on the real confirm-story dialog) and, if wanted, the Desktop Code/GUI dialog check; otherwise publish with those stated as NOT VERIFIED.
4. Accept the residual security risks and the Quality backlog (`QUALITY-RUNNER-SECURITY-MODEL.md`, `QUALITY-BACKLOG.md`).
5. The go for merge, tags, GitHub Releases and Marketplace publication.

## D. Pre-publication re-check (run, in `/Users/serg/work/praxis-split`)
```bash
for r in praxis-core praxis-runtime praxis-ba praxis-architect praxis-developer praxis-quality praxis-marketplace; do git -C $r status --short | wc -l; git -C $r log -1 --format="$r %h"; done
export PRAXIS_BA_ROOT=$PWD/praxis-ba PRAXIS_DEVELOPER_ROOT=$PWD/praxis-developer PRAXIS_ARCHITECT_ROOT=$PWD/praxis-architect PRAXIS_QUALITY_ROOT=$PWD/praxis-quality
for r in praxis-core praxis-runtime praxis-ba praxis-architect praxis-developer praxis-quality praxis-marketplace; do (cd $r && npm run verify) || break; done
git -C praxis-runtime checkout -- claude-extensions; for r in praxis-ba praxis-architect praxis-developer praxis-quality; do git -C $r checkout -- claude-plugins; done   # the scripts rewrite archives; timestamp-only changes
(cd praxis-runtime && node tools/scripts/marketplace-install-acceptance.mjs --previous 3c0ab03)
```

## E. Publication sequence (nothing here has been run; each step needs the owner's explicit go)
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
