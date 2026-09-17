import type { JiraConfig } from "./config.js";

export type JiraIssueSemanticType =
  | "epic"
  | "story"
  | "task"
  | "bug"
  | "subtask"
  | "work-package"
  | "unknown";

export type RawIssueType = {
  id?: string;
  name?: string;
  subtask?: boolean;
  hierarchyLevel?: number;
};

export type IssueTypeDescriptor = {
  id: string;
  displayName: string;
  hierarchyLevel?: number;
  subtask?: boolean;
  semanticType: JiraIssueSemanticType;
};

export type IssueTypeMapping = {
  epicTypeId?: string;
  storyTypeId?: string;
  taskTypeId?: string;
  bugTypeId?: string;
  workPackageTypeId?: string;
  subtaskTypeIds: string[];
  types: IssueTypeDescriptor[];
};

/** Discovery-only aliases. Not a runtime source of truth. */
export const ISSUE_TYPE_NAME_ALIASES: Record<string, JiraIssueSemanticType> = {
  story: "story",
  история: "story",
  historia: "story",
  geschichte: "story",
  task: "task",
  задача: "task",
  bug: "bug",
  баг: "bug",
  ошибка: "bug",
  epic: "epic",
  эпик: "epic",
  "sub-task": "subtask",
  subtask: "subtask",
  "work package": "work-package",
  "пакет работ": "work-package",
};

export function normalizeIssueTypeName(name: string): string {
  return name.trim().toLowerCase();
}

function aliasSemantic(name: string | undefined): JiraIssueSemanticType | undefined {
  if (!name) return undefined;
  return ISSUE_TYPE_NAME_ALIASES[normalizeIssueTypeName(name)];
}

export function resolveSemanticType(
  raw: RawIssueType,
  mapping: IssueTypeMapping | undefined,
  config: JiraConfig,
): JiraIssueSemanticType {
  if (raw.subtask === true || raw.hierarchyLevel === -1) return "subtask";
  if (raw.hierarchyLevel === 1) return "epic";
  const id = raw.id ? String(raw.id) : "";
  if (id && config.storyTypeId && id === config.storyTypeId) return "story";
  if (id && config.epicTypeId && id === config.epicTypeId) return "epic";
  if (id && config.taskTypeId && id === config.taskTypeId) return "task";
  if (id && config.bugTypeId && id === config.bugTypeId) return "bug";
  if (mapping) {
    if (id && mapping.storyTypeId === id) return "story";
    if (id && mapping.epicTypeId === id) return "epic";
    if (id && mapping.taskTypeId === id) return "task";
    if (id && mapping.bugTypeId === id) return "bug";
    if (id && mapping.workPackageTypeId === id) return "work-package";
    if (id && mapping.subtaskTypeIds.includes(id)) return "subtask";
  }
  const aliased = aliasSemantic(raw.name);
  if (aliased) return aliased;
  if (raw.name && config.storyType && normalizeIssueTypeName(raw.name) === normalizeIssueTypeName(config.storyType)) {
    return "story";
  }
  if (raw.name && config.epicType && normalizeIssueTypeName(raw.name) === normalizeIssueTypeName(config.epicType)) {
    return "epic";
  }
  if (raw.name && config.taskType && normalizeIssueTypeName(raw.name) === normalizeIssueTypeName(config.taskType)) {
    return "task";
  }
  if (raw.name && config.bugType && normalizeIssueTypeName(raw.name) === normalizeIssueTypeName(config.bugType)) {
    return "bug";
  }
  if (
    raw.name &&
    config.workPackageType &&
    normalizeIssueTypeName(raw.name) === normalizeIssueTypeName(config.workPackageType)
  ) {
    return "work-package";
  }
  return "unknown";
}

function pickId(
  types: RawIssueType[],
  semantic: JiraIssueSemanticType,
  mapping: IssueTypeMapping,
  config: JiraConfig,
): string | undefined {
  const configured =
    semantic === "epic"
      ? config.epicTypeId
      : semantic === "story"
        ? config.storyTypeId
        : semantic === "task"
          ? config.taskTypeId
          : semantic === "bug"
            ? config.bugTypeId
            : undefined;
  if (configured && types.some((t) => String(t.id) === configured)) return configured;
  const hit = types.find(
    (t) => resolveSemanticType(t, mapping, config) === semantic,
  );
  return hit?.id ? String(hit.id) : undefined;
}

export function buildIssueTypeMapping(
  types: RawIssueType[],
  config: JiraConfig,
): IssueTypeMapping {
  const mapping: IssueTypeMapping = {
    subtaskTypeIds: [],
    types: [],
  };
  mapping.epicTypeId = pickId(types, "epic", mapping, config);
  mapping.storyTypeId = pickId(types, "story", mapping, config);
  mapping.taskTypeId = pickId(types, "task", mapping, config);
  mapping.bugTypeId = pickId(types, "bug", mapping, config);
  mapping.workPackageTypeId = pickId(types, "work-package", mapping, config);
  mapping.subtaskTypeIds = types
    .filter((t) => resolveSemanticType(t, mapping, config) === "subtask")
    .map((t) => String(t.id ?? ""));
  mapping.types = types.map((t) => ({
    id: String(t.id ?? ""),
    displayName: String(t.name ?? ""),
    hierarchyLevel: t.hierarchyLevel,
    subtask: t.subtask,
    semanticType: resolveSemanticType(t, mapping, config),
  }));
  return mapping;
}

export function isSemanticStory(type: JiraIssueSemanticType): boolean {
  return type === "story";
}

export function isSemanticBug(type: JiraIssueSemanticType): boolean {
  return type === "bug";
}

export function isSemanticEpic(type: JiraIssueSemanticType): boolean {
  return type === "epic";
}
