import { dirname, join } from "node:path";

export const MCPB_MANIFEST_VERSION = "0.4";
export const MCPB_SCHEMA =
  "https://raw.githubusercontent.com/anthropics/mcpb/main/schemas/mcpb-manifest-v0.4.schema.json";
export const EXTENSION_ID = "praxis-runtime";
export const EXTENSION_FILE = "praxis-runtime.mcpb";
export const EXTENSION_CONTRACT = "praxis.claude-extensions.manifest";

export const JIRA_USER_CONFIG = {
  jira_base_url: {
    type: "string",
    title: "Jira Base URL",
    description: "Jira Cloud or Data Center origin, for example https://your-domain.atlassian.net. No trailing slash.",
    required: true,
  },
  jira_email: {
    type: "string",
    title: "Jira Email",
    description: "Atlassian account email for Cloud (email + API token). For Data Center, the account email associated with the token.",
    required: true,
  },
  jira_project_key: {
    type: "string",
    title: "Jira Project Key",
    description: "Jira project key, for example PRX.",
    required: true,
  },
  jira_token: {
    type: "string",
    title: "Jira API Token",
    description: "Jira API token. Stored in the operating system secret vault (Keychain / Credential Manager). Never paste it into chat.",
    required: true,
    sensitive: true,
  },
  github_token: {
    type: "string",
    title: "GitHub Token",
    description: "GitHub personal access token with repo scope for Pull Requests and Actions status. PAT, not OAuth. Stored in OS secret vault. Never paste into chat.",
    required: false,
    sensitive: true,
  },
  github_api_url: {
    type: "string",
    title: "GitHub API URL",
    description: "Optional. Must be https://api.github.com (or https://HOST/api/v3 for GitHub Enterprise). Not a git remote such as git@github.com:owner/repo.git.",
    required: false,
  },
  gitlab_token: {
    type: "string",
    title: "GitLab Token",
    description: "GitLab personal access token (api scope) for Merge Requests. PAT, not OAuth. Optional if you only use GitHub. Never paste into chat.",
    required: false,
    sensitive: true,
  },
  gitlab_base_url: {
    type: "string",
    title: "GitLab Base URL",
    description: "Optional. GitLab.com or Self-Managed origin, for example https://gitlab.example.com. No trailing slash.",
    required: false,
  },
};

export const JIRA_ENV_MAP = {
  PRAXIS_JIRA_BASE_URL: "${user_config.jira_base_url}",
  PRAXIS_JIRA_EMAIL: "${user_config.jira_email}",
  PRAXIS_JIRA_PROJECT_KEY: "${user_config.jira_project_key}",
  PRAXIS_JIRA_TOKEN: "${user_config.jira_token}",
  PRAXIS_GITHUB_TOKEN: "${user_config.github_token}",
  PRAXIS_GITHUB_API_URL: "${user_config.github_api_url}",
  PRAXIS_GITLAB_TOKEN: "${user_config.gitlab_token}",
  PRAXIS_GITLAB_BASE_URL: "${user_config.gitlab_base_url}",
};

export function praxisRuntimeManifest(version) {
  return {
    $schema: MCPB_SCHEMA,
    manifest_version: MCPB_MANIFEST_VERSION,
    name: EXTENSION_ID,
    display_name: "Praxis Runtime",
    version,
    description:
      "Shared Praxis MCP runtime for Claude Desktop. Configure Jira once; role plugins use these tools.",
    long_description:
      "Praxis Runtime is the single local MCP server for Praxis BA, Architect, Developer, and Quality.\n\nConfigure Jira in this extension's settings. Optionally configure a GitHub token (MVP Git Delivery) or GitLab token. Tokens are marked sensitive and stored in OS secure storage. Role plugins contain Skills only and do not launch duplicate MCP servers.\n\nCLI and CI continue to use `PRAXIS_JIRA_*` / `PRAXIS_GITHUB_*` / `PRAXIS_GITLAB_*`. Desktop injected env wins over repository `.env` files.",
    author: { name: "dfuture-co" },
    license: "Apache-2.0",
    keywords: ["praxis", "jira", "mcp", "runtime"],
    tools_generated: true,
    server: {
      type: "node",
      entry_point: "server/praxis-mcp.cjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/praxis-mcp.cjs", "--role", "runtime"],
        env: { ...JIRA_ENV_MAP },
      },
    },
    user_config: { ...JIRA_USER_CONFIG },
    compatibility: {
      platforms: ["darwin", "win32", "linux"],
      runtimes: { node: ">=20" },
    },
  };
}

export function distClaudeExtensionsDir(root, version) {
  return join(root, "dist", "claude-extensions", version);
}

export function repoClaudeExtensionsDir(root) {
  return join(root, "claude-extensions");
}

export function mcpbCliPath(requireFn) {
  return join(dirname(requireFn.resolve("@anthropic-ai/mcpb/cli")), "cli/cli.js");
}
