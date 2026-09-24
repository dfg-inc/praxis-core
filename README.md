# praxis-core

Shared Praxis libraries published by **dfg-inc**.

Packages: `@praxis/contracts`, `@praxis/cli`, `@praxis/vcs`, `@praxis/jira`, `@praxis/plugin-sdk`, `@praxis/project-config`, `@praxis/knowledge`, `@praxis/catalog`, `@praxis/testing`.

Jira and VCS are **libraries** here. Desktop MCPB lives in [`praxis-runtime`](https://github.com/dfg-inc/praxis-runtime). Role Skills live in the four role repositories.

## Clone

```bash
git clone https://github.com/dfg-inc/praxis-core.git
cd praxis-core
npm ci
npm run verify
npm run pack:vendor   # write dist/vendor/<version>/*.tgz
```

Node.js `>=20` (CI uses 22).

## Consumers

Downstream products pin Core via tracked `vendor/*.tgz` (`file:vendor/...`). See [DEPENDENCIES.md](./DEPENDENCIES.md).

## Testing

- Unit/workspace tests: `npm run test`
- Contracts + Git Delivery library acceptance: `npm run accept:git-delivery-lib`

## Release (libraries)

1. Bump workspace package versions independently.
2. `npm run verify && npm run pack:vendor`
3. Publish `dist/vendor/` artifacts from CI or copy tgzs into consumer `vendor/` folders.

Installable desktop artifacts are **not** shipped from this repository.
