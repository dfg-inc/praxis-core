# praxis-core

Shared Praxis libraries. Independent product repository under `engineering/ai-tooling/praxis-core`.

## Packages

`@praxis/contracts`, `@praxis/cli`, `@praxis/vcs`, `@praxis/jira`, `@praxis/plugin-sdk`, `@praxis/project-config`, `@praxis/knowledge`, `@praxis/catalog`, `@praxis/testing`.

Jira and VCS are **libraries** here. Desktop MCPB lives in `praxis-runtime`. Role Skills live in the four role repositories.

## Development

```bash
npm ci
npm run build
npm run typecheck
npm run test
npm run verify          # build + typecheck + test
npm run pack:vendor     # write dist/vendor/<version>/*.tgz
```

Node.js `>=20` (CI uses 22).

## Testing

- Unit/workspace tests via `npm run test`
- Contracts package tests in CI `contracts` job
- Git Delivery **library** acceptance: `npm run accept:git-delivery-lib` (no MCPB)

## Release

1. Bump `package.json` / workspace package versions independently (do **not** reuse a monorepo alpha tag as a required release tag).
2. `npm run verify && npm run pack:vendor`
3. Publish CI artifacts (`dist/vendor/`) or manually trigger `publish_registry` to GitLab Package Registry.
4. Downstream products must **deliberately** pin the new vendor tgzs and re-verify — no automatic cascade.

See [DEPENDENCIES.md](./DEPENDENCIES.md).

## GitLab CI

`.gitlab-ci.yml` stages: `build`, `typecheck`, `test`, `contracts`, `pack_vendor` (+ optional manual `publish_registry`).

No Docker-in-Docker. Image: `node:22-bookworm`.
