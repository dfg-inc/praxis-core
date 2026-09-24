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

## Optional future: public npm / GitHub Packages

A registry-based `@praxis/*` install path may be added later. **Do not remove tracked vendor tgzs** until every consumer has a registry-based install path verified in CI.

## What not to do

- Do not `npm install` from a local monorepo path
- Do not silently bump consumer pins without verify
- Do not require a shared monorepo alpha tag on every product
- Do not require corporate GitLab Package Registry for public builds
