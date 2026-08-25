import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const ProjectConfigSchema = z.object({
  stack: z.array(z.string()).default([]),
  requirementsFormat: z
    .enum([
      "user-story-gherkin",
      "история с критериями в сценарной форме",
      "freeform",
    ])
    .default("user-story-gherkin"),
  requiredArtifacts: z.array(z.string()).default([]),
  environments: z.array(z.string()).default([]),
  knowledge: z
    .object({
      path: z.string().optional(),
      ref: z.string().default("main"),
    })
    .default({}),
  jira: z
    .object({
      baseUrl: z.string().url().optional(),
      projectKey: z.string().optional(),
    })
    .default({}),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const PROJECT_FILE_NAMES = [".project", ".project.yaml", ".project.yml"] as const;

export type LoadProjectResult =
  | {
      status: "loaded";
      path: string;
      config: ProjectConfig;
      unset: string[];
    }
  | {
      status: "missing";
      config: ProjectConfig;
      unset: string[];
      suggestedPath: string;
    }
  | {
      status: "invalid";
      path: string;
      errors: string[];
      config: ProjectConfig;
      unset: string[];
    };

const DEFAULTS = ProjectConfigSchema.parse({});

function unsetFields(config: ProjectConfig): string[] {
  const unset: string[] = [];
  if (config.stack.length === 0) unset.push("stack");
  if (config.requiredArtifacts.length === 0) unset.push("requiredArtifacts");
  if (config.environments.length === 0) unset.push("environments");
  if (!config.knowledge.path) unset.push("knowledge.path");
  return unset;
}

export function loadProjectConfig(repoRoot: string): LoadProjectResult {
  for (const name of PROJECT_FILE_NAMES) {
    const path = join(repoRoot, name);
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf8");
      const data = parseYaml(raw) ?? {};
      const config = ProjectConfigSchema.parse(data);
      return { status: "loaded", path, config, unset: unsetFields(config) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "invalid",
        path,
        errors: [message],
        config: DEFAULTS,
        unset: unsetFields(DEFAULTS),
      };
    }
  }
  return {
    status: "missing",
    config: DEFAULTS,
    unset: unsetFields(DEFAULTS),
    suggestedPath: join(repoRoot, ".project"),
  };
}

export function usesGherkinAcceptance(config: ProjectConfig): boolean {
  return (
    config.requirementsFormat === "user-story-gherkin" ||
    config.requirementsFormat === "история с критериями в сценарной форме"
  );
}
