import type { PraxisRole } from "@praxis/contracts";

export type JiraOperation =
  | "read-epic"
  | "read-issue"
  | "create-story"
  | "update-story"
  | "ba-comment"
  | "ba-handoff"
  | "transition-ready-for-architecture"
  | "create-architecture"
  | "create-technical-ticket"
  | "create-work-package"
  | "transition-ready-for-development"
  | "claim-work-package"
  | "developer-evidence"
  | "transition-in-progress"
  | "transition-ready-for-qa"
  | "rewrite-requirements"
  | "rewrite-architecture"
  | "qa-pass"
  | "create-bug"
  | "qa-report"
  | "block-package"
  | "resolve-bug"
  | "force-release-work-package";

const ALLOWED: Record<PraxisRole, Set<JiraOperation>> = {
  ba: new Set([
    "read-epic",
    "read-issue",
    "create-story",
    "update-story",
    "ba-comment",
    "ba-handoff",
    "transition-ready-for-architecture",
  ]),
  architect: new Set([
    "read-epic",
    "read-issue",
    "create-architecture",
    "create-technical-ticket",
    "create-work-package",
    "transition-ready-for-development",
  ]),
  developer: new Set([
    "read-issue",
    "claim-work-package",
    "developer-evidence",
    "transition-in-progress",
    "transition-ready-for-qa",
  ]),
  qa: new Set([
    "read-issue",
    "create-bug",
    "qa-report",
    "block-package",
    "qa-pass",
    "resolve-bug",
  ]),
};

export function assertRole(role: PraxisRole, op: JiraOperation): void {
  if (!ALLOWED[role].has(op)) {
    throw new Error(`role-policy deny: ${role} cannot ${op}`);
  }
}

export function roleAllows(role: PraxisRole, op: JiraOperation): boolean {
  return ALLOWED[role].has(op);
}
