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
};

export const JIRA_ENV_MAP = {
  PRAXIS_JIRA_BASE_URL: "${user_config.jira_base_url}",
  PRAXIS_JIRA_EMAIL: "${user_config.jira_email}",
  PRAXIS_JIRA_PROJECT_KEY: "${user_config.jira_project_key}",
  PRAXIS_JIRA_TOKEN: "${user_config.jira_token}",
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
      "Praxis Runtime is the single local MCP server for Praxis BA, Architect, Developer, and Quality.\n\nConfigure Jira in this extension's settings. The API token is marked sensitive and stored in OS secure storage. Role plugins contain Skills only and do not launch duplicate MCP servers.\n\nCLI and CI continue to use `PRAXIS_JIRA_*` environment variables. Desktop injected env wins over repository `.env` files.",
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
