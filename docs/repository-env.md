# Repository `.env` files

A repository file is something an agent can write, so it must not decide how Praxis approves an action, where a request goes, which program runs or where the journal is kept. Praxis therefore reads a repository's `.env.praxis`, `.env` and `.env.praxis.local` (only those three files, only at the repository root) through a strict **allowlist**:

- `PRAXIS_JIRA_PROJECT_KEY`, `PRAXIS_JIRA_*_TYPE`, `PRAXIS_JIRA_*_TYPE_ID`, `PRAXIS_JIRA_WORK_PACKAGE_TYPE`, `PRAXIS_JIRA_STORY_POINTS_FIELD`, `PRAXIS_JIRA_ARCHITECT_ESTIMATE_FIELD`, `PRAXIS_JIRA_TRANSITION_*`
- `PRAXIS_GIT_PROVIDER`
- `PRAXIS_WORK_PACKAGE_MAX_HOURS`

Each allowed key must also have a value of the right shape (a project key like `PRX`, a numeric id, a field id, `github` or `gitlab`, a short number): a value with path, query or query-language syntax is refused and listed by the doctor. Only regular files up to 64 KB are read (a FIFO, a device, a link or a huge file is skipped), and values from one repository's file apply only to calls for that repository: they are taken back before the next call loads another repository's file. Lines may use `export`, quotes, CRLF line ends, a BOM and trailing ` # comments`.

Everything else is not loaded: approval variables (`PRAXIS_APPROVAL_*`; since 0.1.0-alpha.49.2 no variable weakens approval from any source, and the Trusted Client and host-permission modes are removed), test switches (`PRAXIS_TEST_*`, `PRAXIS_FIXTURE_*`), the state location (`PRAXIS_STATE_HOME`), `PRAXIS_SKIP_DOTENV`, every URL, e-mail and credential (`PRAXIS_JIRA_BASE_URL`, `*_TOKEN`, `PRAXIS_GITLAB_*`, `PRAXIS_GITHUB_*`), Quality service settings, and any non-Praxis variable such as `PATH`, `BROWSER`, `NODE_OPTIONS`, `LD_PRELOAD` or `GIT_ASKPASS`. The doctor lists the refused `PRAXIS_*` names (never their values), grouped by reason, and the allowlisted names that were loaded; see [What the doctor tells you](#what-the-doctor-tells-you).

Order of precedence: the operator's real environment (extension settings or shell) always wins; among the three files the first one read wins. Praxis does not read nested `.env` files, `.project` or `.praxis/` files for these settings.

**Change from alpha.48:** a URL or credential in a repository `.env` used to be loaded. It is not any more, because a file the agent can write could otherwise point a request that carries your real token at another host. Put connection settings in the extension settings or your shell.

**Since 0.1.0-alpha.49.3, the same rule covers a repository's Claude Code settings.** Claude Code applies the `env` of a repository's `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json` servers to the Runtime's environment, so a value there looks to Praxis like one from your shell. A token and the settings that decide where and how it is sent (the Jira base URL, e-mail, mode and authentication; the GitHub API URL; the GitLab base URL) must come from the same place. When a repository file sets any of them (in the working folder, the repository or a folder above), the token is not used and nothing is sent: `CREDENTIAL_SOURCE_UNTRUSTED` names the variables and the files. A file Praxis cannot read counts as setting everything. Remove the entries from the repository file and configure them with the token.

## Where to configure Jira, GitHub and GitLab now

Connection settings come only from the operator's real environment, never from a file in the repository.

| Setting | Environment variable | Desktop extension setting | Where to set it |
|---|---|---|---|
| Jira base URL | `PRAXIS_JIRA_BASE_URL` | `jira_base_url` | Operator environment |
| Jira e-mail | `PRAXIS_JIRA_EMAIL` | `jira_email` | Operator environment |
| Jira API token (secret) | `PRAXIS_JIRA_TOKEN` | `jira_token` | Operator environment |
| Jira project key | `PRAXIS_JIRA_PROJECT_KEY` | `jira_project_key` | Operator environment, or the repository `.env` (allowlisted) |
| Jira issue-type, field and transition names | `PRAXIS_JIRA_*_TYPE`, `*_TYPE_ID`, `*_FIELD`, `PRAXIS_JIRA_TRANSITION_*` | none | Repository `.env` (allowlisted) or operator environment |
| GitHub token (secret) | `PRAXIS_GITHUB_TOKEN` | `github_token` | Operator environment |
| GitHub API URL | `PRAXIS_GITHUB_API_URL` | `github_api_url` | Operator environment |
| GitLab token (secret) | `PRAXIS_GITLAB_TOKEN` | `gitlab_token` | Operator environment |
| GitLab base URL | `PRAXIS_GITLAB_BASE_URL` | `gitlab_base_url` | Operator environment |
| Git provider choice | `PRAXIS_GIT_PROVIDER` | none | Repository `.env` (allowlisted) or operator environment |
| Work-package time box | `PRAXIS_WORK_PACKAGE_MAX_HOURS` | none | Repository `.env` (allowlisted) or operator environment |
| Quality service settings, test switches, `PRAXIS_STATE_HOME`, `PRAXIS_SKIP_DOTENV` | `PRAXIS_QUALITY_*`, `PRAXIS_TEST_*`, ... | none | Operator environment only |
| Approval variables (`PRAXIS_APPROVAL_*`) | none can weaken approval | none | Ignored from every source since 0.1.0-alpha.49.2, except a longer `PRAXIS_APPROVAL_MIN_ANSWER_MS` |

"Operator environment" means one of:

- **Claude Desktop:** Settings, Extensions, Praxis Runtime, Settings (the `user_config` of the `praxis-runtime` extension). Secrets are kept by the host.
- **Claude Code and CI:** variables exported in the shell or CI job that launches Claude Code.
- **A manually registered Runtime:** `claude mcp add -e KEY=VALUE ...`.

Never paste a token into chat, a prompt or a repository file.

A token exported for your whole login session (for example with `launchctl setenv` on macOS) or in a global shell profile reaches every app you start and every agent shell inside them. Praxis keeps such values out of what it outputs and out of the repository code it starts, but it cannot take them out of an environment that was already inherited. `praxis_doctor` → `credentialExposure` names the credential variables the Runtime inherited (names only). Prefer the Desktop extension settings, which only the Runtime receives, or a token exported only in the terminal that starts Claude Code, and give agent sessions least-privilege tokens.

## Migrating an old `.env`

If your repository `.env` (or `.env.praxis`, `.env.praxis.local`) holds Jira, GitHub or GitLab URLs, tokens or e-mail from alpha.48 or earlier:

1. Run `praxis_doctor`. Under "Ignored, move to the operator environment" it lists the key names that are no longer read (names only).
2. Copy each of those lines into the operator environment (below). Keep the allowlisted lines (project key, issue-type names, `PRAXIS_GIT_PROVIDER`, time box) in the file if you like.
3. Delete the moved lines from the repository file. If a token was ever committed or shared, revoke it and issue a new one.
4. Restart the Claude session (Desktop: reopen the conversation after saving the settings; CLI: start a new `claude` from the shell that has the variables).
5. Run `praxis_doctor` again. The ignored list should be empty and the providers should show as configured.

Examples that never put a secret on the command line or in history. Bash or zsh, same terminal that launches Claude Code:

```bash
# Non-secret values may be exported directly.
export PRAXIS_JIRA_BASE_URL="https://example.atlassian.net"
export PRAXIS_JIRA_EMAIL="you@example.com"

# macOS: read the token from the Keychain (stored earlier with `security add-generic-password -s praxis-jira -a "$USER" -w`,
# which prompts for the value instead of taking it as an argument).
export PRAXIS_JIRA_TOKEN="$(security find-generic-password -s praxis-jira -a "$USER" -w)"

# Any secret manager works the same way; the CLI name below is only an example.
export PRAXIS_GITLAB_TOKEN="$(my-secret-manager read praxis/gitlab-token)"

claude
```

Hidden prompt without history, Bash or zsh (does not echo the value; never enable `set -x` here):

```bash
printf 'Jira API token: ' >&2; stty -echo; IFS= read -r PRAXIS_JIRA_TOKEN; stty echo; printf '\n' >&2; export PRAXIS_JIRA_TOKEN
```

A manually registered Runtime stores the variables you pass in your Claude configuration. Let the shell expand them from variables you already loaded securely, so the literal value is never typed or echoed:

```bash
claude mcp add praxis-runtime \
  -e PRAXIS_JIRA_BASE_URL="$PRAXIS_JIRA_BASE_URL" -e PRAXIS_JIRA_EMAIL="$PRAXIS_JIRA_EMAIL" -e PRAXIS_JIRA_TOKEN="$PRAXIS_JIRA_TOKEN" \
  -- node /path/to/praxis-mcp.cjs --role runtime
```

Windows PowerShell: use `$env:PRAXIS_JIRA_BASE_URL = "https://example.atlassian.net"` for non-secret values and read the token with `$env:PRAXIS_JIRA_TOKEN = [System.Net.NetworkCredential]::new('', (Read-Host -AsSecureString 'Jira API token')).Password` in the same window that starts Claude Code; for a permanent setting use the Credential Manager or your secret manager rather than `setx`.

## What the doctor tells you

For a repository file with refused `PRAXIS_*` keys, `praxis_doctor` reports names only, never values:

- `dotenvRefused`: `[{ key, reason }]` with `reason` one of `not-allowed` (URLs, tokens, e-mail, authentication, Quality service settings and any other non-allowlisted key: move to the operator environment), `trust` (approval, test, state-location and skip switches: never allowed from a repository) and `bad-value-shape` (an allowlisted key with a malformed value).
- `dotenvLoaded`: the allowlisted keys that were taken from a repository file for this call.
- `dotenvRejected`: the alpha.48-compatible list of refused names.
- `nextSteps`: plain text per group, plus one line on how to migrate.

Non-`PRAXIS_` variables in the file (such as `DATABASE_URL`) are simply not loaded and not reported.

