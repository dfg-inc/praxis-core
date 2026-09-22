# Core dependency management

## Current mechanism (default): tracked `vendor/*.tgz`

Consumers (`praxis-runtime`, role plugins, Marketplace) pin Core packages as **exact** `file:vendor/<name>-<version>.tgz` entries in `package.json`, with matching files committed under `vendor/` and a `vendor/manifest.json`.

Properties:

- No dependency on Praxis-mono or absolute Mac paths
- Clean-clone build works with `npm ci`
- Versions are explicit and reviewable in git
- Updating Core is **manual**: pack in Core → copy tgzs → refresh lockfile → `npm run verify` in the consumer

### Update procedure (consumer)

1. In `praxis-core`: `npm ci && npm run verify && npm run pack:vendor`
2. Copy new `dist/vendor/<version>/*.tgz` into the consumer `vendor/`
3. Update `package.json` `file:vendor/...` pins and `vendor/manifest.json`
4. `npm install` to refresh `package-lock.json`
5. `npm run verify` in the consumer
6. Open MR — do not auto-update other products

### Compatibility

A Core bump is compatible only after each consumer's verify (and role ZIP / MCPB acceptance where applicable) passes. There is no shared "force all products to alpha.N" release.

## Target mechanism: GitLab Package Registry

Core CI includes a **manual** `publish_registry` job that publishes packed tgzs to the project npm Package Registry:

`https://gl.jetru.by/api/v4/projects/<praxis-core-id>/packages/npm/`

Consumers can later switch from `file:vendor/...` to:

```json
"@praxis/contracts": "0.1.0-alpha.45"
```

with `.npmrc`:

```
@praxis:registry=https://gl.jetru.by/api/v4/projects/<id>/packages/npm/
```

**Do not remove tracked vendor tgzs until** every consumer has a registry-based install path verified in CI. Keep the vendor fallback during transition.

## What not to do

- Do not `npm install` from `/Users/serg/work/praxis`
- Do not silently bump consumer pins without verify
- Do not require a shared monorepo alpha tag on every product
