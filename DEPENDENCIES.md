# Core dependency management

## Current mechanism (default): tracked `vendor/*.tgz`

Consumers (`praxis-runtime`, role plugins, Marketplace) pin Core packages as **exact** `file:vendor/<name>-<version>.tgz` entries in `package.json`, with matching files committed under `vendor/` and a `vendor/manifest.json`.

Properties:

- No dependency on Praxis-mono or absolute Mac paths
- Clean-clone build works with `npm ci`
- Versions are explicit and reviewable in git
- Updating Core is **manual**: pack in Core → copy tgzs → refresh lockfile → `npm run verify` in the consumer
- Public consumers do **not** require a private package registry

### Update procedure (consumer)

1. In `praxis-core`: `npm ci && npm run verify && npm run pack:vendor`
2. Copy new `dist/vendor/<version>/*.tgz` into the consumer `vendor/`
3. Update `package.json` `file:vendor/...` pins and `vendor/manifest.json`
4. `npm install` to refresh `package-lock.json`
5. `npm run verify` in the consumer
6. Open a PR — do not auto-update other products

### Compatibility

A Core bump is compatible only after each consumer's verify (and role ZIP / MCPB acceptance where applicable) passes. There is no shared "force all products to alpha.N" release.

## Version policy

`ecosystem.json` in each repository has `"policy": "independent"`. Its `version` is that repository's own release version. Runtime, BA, Architect, Developer, and Quality do not have to match Core or each other.

`node tools/scripts/check-ecosystem-version.mjs` fails when this repository's manifests disagree, when a `file:vendor` pin does not match `vendor/manifest.json` and the committed tarball, or when `package-lock.json` names a Core prerelease other than this product's version or the declared vendor version. It does not fail because another repository has a different version.

`node tools/scripts/set-ecosystem-version.mjs <version>` changes only this repository. `node tools/scripts/set-ecosystem-version.mjs --vendor <core-version>` retargets only this consumer's Core pins. Copy new tarballs into that consumer and refresh its lockfile. Leave the other products on their current pins until they need the update.

Release the affected repository on GitLab first (`v<its version>`), then publish that repository's GitHub release. Do not tag or publish the repositories that did not change.

## Optional future: public npm / GitHub Packages

A registry-based `@praxis/*` install path may be added later. **Do not remove tracked vendor tgzs** until every consumer has a registry-based install path verified in CI.

## What not to do

- Do not `npm install` from a local monorepo path
- Do not silently bump consumer pins without verify
- Do not require a shared monorepo alpha tag on every product
- Do not require corporate GitLab Package Registry for public builds
