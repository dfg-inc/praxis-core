import { requireMutationLease } from "@praxis/contracts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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
      /** Optional product id for product-level rule overrides (subdir under product/). */
      product: z.string().optional(),
      /** Optional service id for service-level rule overrides (subdir under service/). */
      service: z.string().optional(),
    })
    .default({}),
  jira: z
    .object({
      baseUrl: z.string().url().optional(),
      projectKey: z.string().optional(),
    })
    .default({}),
  quality: z
    .object({
      install: z.string().optional(),
      build: z.string().optional(),
      test: z.string().optional(),
      coverage: z.string().optional(),
      start: z.string().optional(),
      healthUrl: z.string().optional(),
      startupTimeoutMs: z.number().int().positive().optional(),
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

export type InferProjectResult = {
  proposed: ProjectConfig;
  yaml: string;
  notes: string[];
  existing: LoadProjectResult;
};

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function inferProjectConfig(repoRoot: string): InferProjectResult {
  const existing = loadProjectConfig(repoRoot);
  const notes: string[] = [];
  const pkg = readJson(join(repoRoot, "package.json"));
  const scripts =
    pkg && typeof pkg.scripts === "object" && pkg.scripts
      ? (pkg.scripts as Record<string, string>)
      : {};
  const stack: string[] = [];
  if (pkg) {
    stack.push("node", "javascript");
  }
  const quality: ProjectConfig["quality"] = {};
  if (scripts.test) quality.test = "npm test";
  if (scripts.build) quality.build = "npm run build";
  if (scripts.coverage) quality.coverage = "npm run coverage";
  if (!scripts.test) notes.push("no test script found; quality.test omitted");
  if (!scripts.build) notes.push("no build script found; quality.build omitted");
  const proposed = ProjectConfigSchema.parse({
    stack: stack.length ? [...new Set(stack)] : [],
    requirementsFormat: "user-story-gherkin",
    quality,
  });
  const yaml = stringifyYaml(proposed).trimEnd() + "\n";
  return { proposed, yaml, notes, existing };
}

export function writeProjectConfig(repoRoot: string, yamlOrConfig: string | ProjectConfig): string {
  requireMutationLease();
  const path = join(repoRoot, ".project");
  const yaml =
    typeof yamlOrConfig === "string"
      ? yamlOrConfig.endsWith("\n")
        ? yamlOrConfig
        : `${yamlOrConfig}\n`
      : `${stringifyYaml(yamlOrConfig).trimEnd()}\n`;
  writeFileSync(path, yaml);
  return path;
}
