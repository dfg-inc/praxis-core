# Repository `.env` files

A repository file is something an agent can write, so it must not decide how Praxis approves an action, where a request goes, which program runs or where the journal is kept. Praxis therefore reads a repository's `.env.praxis`, `.env` and `.env.praxis.local` (only those three files, only at the repository root) through a strict **allowlist**:

- `PRAXIS_JIRA_PROJECT_KEY`, `PRAXIS_JIRA_*_TYPE`, `PRAXIS_JIRA_*_TYPE_ID`, `PRAXIS_JIRA_WORK_PACKAGE_TYPE`, `PRAXIS_JIRA_STORY_POINTS_FIELD`, `PRAXIS_JIRA_ARCHITECT_ESTIMATE_FIELD`, `PRAXIS_JIRA_TRANSITION_*`
- `PRAXIS_GIT_PROVIDER`
- `PRAXIS_WORK_PACKAGE_MAX_HOURS`

Each allowed key must also have a value of the right shape (a project key like `PRX`, a numeric id, a field id, `github` or `gitlab`, a short number): a value with path, query or query-language syntax is refused and listed by the doctor. Only regular files up to 64 KB are read (a FIFO, a device, a link or a huge file is skipped), and values from one repository's file apply only to calls for that repository: they are taken back before the next call loads another repository's file. Lines may use `export`, quotes, CRLF line ends, a BOM and trailing ` # comments`.

Everything else is not loaded: approval modes (`PRAXIS_APPROVAL_*`, so `trusted-client` and `host-permission` cannot be enabled from a repository), test switches (`PRAXIS_TEST_*`, `PRAXIS_FIXTURE_*`), the state location (`PRAXIS_STATE_HOME`), `PRAXIS_SKIP_DOTENV`, every URL, e-mail and credential (`PRAXIS_JIRA_BASE_URL`, `*_TOKEN`, `PRAXIS_GITLAB_*`, `PRAXIS_GITHUB_*`), Quality service settings, and any non-Praxis variable such as `PATH`, `BROWSER`, `NODE_OPTIONS`, `LD_PRELOAD` or `GIT_ASKPASS`. The doctor lists the refused `PRAXIS_*` names (never their values).

Order of precedence: the operator's real environment (extension settings or shell) always wins; among the three files the first one read wins. Praxis does not read nested `.env` files, `.project` or `.praxis/` files for these settings.

**Change from alpha.48:** a URL or credential in a repository `.env` used to be loaded. It is not any more, because a file the agent can write could otherwise point a request that carries your real token at another host. Put connection settings in the extension settings or your shell.
