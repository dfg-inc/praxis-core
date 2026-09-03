import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import matter from "gray-matter";
import { z } from "zod";

export const ObsoleteToolBindingSchema = z.object({
  /** Identifier of the obsolete tool or binding (e.g. legacy tracker name). */
  toolId: z.string().min(1),
  /** Why the binding needs human review. */
  reason: z.string().min(1),
  /** Procedural content of the rule remains applicable despite the obsolete binding. */
  proceduralContentApplicable: z.boolean().default(true),
  /** Explicit review-required flag (defaults true when binding is present). */
  reviewRequired: z.boolean().default(true),
});

export type ObsoleteToolBinding = z.infer<typeof ObsoleteToolBindingSchema>;

export const RuleFrontmatterSchema = z.object({
  id: z.string().min(1),
  roles: z.array(z.string()).min(1),
  stages: z.array(z.string()).min(1),
  severity: z.enum(["mandatory", "advisory"]).default("mandatory"),
  overridable: z.boolean().default(true),
  title: z.string().optional(),
  sourceDoc: z.string().optional(),
  sourceVersion: z.string().optional(),
  /** Optional migration marker for bindings to tools the company no longer uses (WBS 2.6.2). */
  obsoleteToolBinding: ObsoleteToolBindingSchema.optional(),
});

export type RuleFrontmatter = z.infer<typeof RuleFrontmatterSchema>;

export type KnowledgeLevel = "company" | "product" | "service";

export type RuleRecord = {
  level: KnowledgeLevel;
  path: string;
  frontmatter: RuleFrontmatter;
  body: string;
  overriddenBy?: string;
};

export const PrecedentFrontmatterSchema = z.object({
  id: z.string().min(1),
  roles: z.array(z.string()).min(1),
  stages: z.array(z.string()).min(1),
  title: z.string().optional(),
});

export type PrecedentFrontmatter = z.infer<typeof PrecedentFrontmatterSchema>;

export type PrecedentRecord = {
  path: string;
  circumstances: string;
  chosen: string;
  rejected: string;
  why: string;
};

/** Precedent loaded from company/product/service corpus with scope metadata. */
export type ScopedPrecedentRecord = PrecedentRecord & {
  level: KnowledgeLevel;
  frontmatter: PrecedentFrontmatter;
  overriddenBy?: string;
};

const LEVEL_DIRS: { level: KnowledgeLevel; dir: string }[] = [
  { level: "company", dir: "company" },
  { level: "product", dir: "product" },
  { level: "service", dir: "service" },
];

function walkMarkdown(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const name of readdirSync(cur)) {
      const p = join(cur, name);
      const st = statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (name.endsWith(".md")) out.push(p);
    }
  }
  return out;
}

export function parseRuleFile(path: string, level: KnowledgeLevel): RuleRecord | { error: string; path: string } {
  const raw = readFileSync(path, "utf8");
  const parsed = matter(raw);
  const fm = RuleFrontmatterSchema.safeParse(parsed.data);
  if (!fm.success) {
    return {
      path,
      error: `missing/invalid frontmatter: ${fm.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    };
  }
  return { level, path, frontmatter: fm.data, body: parsed.content.trim() };
}

function extractPrecedentSections(raw: string): {
  circumstances: string;
  chosen: string;
  rejected: string;
  why: string;
} | { error: string } {
  const sections: Record<string, string> = {};
  let current = "";
  for (const line of raw.split(/\r?\n/)) {
    const m = /^##\s+(.+)\s*$/.exec(line);
    if (m) {
      current = m[1].trim().toLowerCase();
      sections[current] = "";
      continue;
    }
    if (current) sections[current] = (sections[current] ?? "") + line + "\n";
  }
  const circumstances = (sections["обстоятельства"] ?? sections["circumstances"] ?? "").trim();
  const chosen = (sections["выбранный вариант"] ?? sections["chosen"] ?? "").trim();
  const rejected = (sections["отвергнутые варианты"] ?? sections["rejected"] ?? "").trim();
  const why = (sections["причина выбора"] ?? sections["why"] ?? "").trim();
  if (!circumstances || !chosen || !rejected || !why) {
    return { error: "precedent missing required sections" };
  }
  return { circumstances, chosen, rejected, why };
}

/**
 * Resolve applicable rules with override semantics:
 * service > product > company for the same rule id.
 * Also loads scoped precedents from `precedents/` under each level (WBS 2.4.1).
 */
export function loadApplicableSlice(opts: {
  knowledgeRoot: string;
  role: string;
  stage: string;
  product?: string;
  service?: string;
}): {
  rules: RuleRecord[];
  precedents: ScopedPrecedentRecord[];
  emptyMessage?: string;
  errors: string[];
} {
  const { knowledgeRoot, role, stage, product, service } = opts;
  const errors: string[] = [];
  const byId = new Map<string, RuleRecord>();
  const precedentsById = new Map<string, ScopedPrecedentRecord>();

  for (const { level, dir } of LEVEL_DIRS) {
    let base = join(knowledgeRoot, dir);
    if (level === "product" && product) base = join(base, product);
    if (level === "service" && service) base = join(base, service);
    if (level !== "company" && !existsSync(base)) continue;

    for (const file of walkMarkdown(join(base, "rules"))) {
      const result = parseRuleFile(file, level);
      if ("error" in result) {
        errors.push(`${relative(knowledgeRoot, file)}: ${result.error}`);
        continue;
      }
      const { roles, stages, id } = result.frontmatter;
      if (!roles.includes(role) || !stages.includes(stage)) continue;
      const prev = byId.get(id);
      if (prev) {
        result.overriddenBy = undefined;
        prev.overriddenBy = result.path;
      }
      byId.set(id, result);
    }

    for (const file of walkMarkdown(join(base, "precedents"))) {
      const result = parseScopedPrecedentFile(file, level);
      if ("error" in result) {
        errors.push(`${relative(knowledgeRoot, file)}: ${result.error}`);
        continue;
      }
      const { roles, stages, id } = result.frontmatter;
      if (!roles.includes(role) || !stages.includes(stage)) continue;
      const prev = precedentsById.get(id);
      if (prev) {
        result.overriddenBy = undefined;
        prev.overriddenBy = result.path;
      }
      precedentsById.set(id, result);
    }
  }

  const rules = [...byId.values()];
  const precedents = [...precedentsById.values()];
  return {
    rules,
    precedents,
    errors,
    emptyMessage: rules.length === 0 ? "applicable rules: none" : undefined,
  };
}

/**
 * Parse a precedent markdown file (four required ## sections).
 * Frontmatter is optional for standalone template checks; corpus load requires it.
 */
export function parsePrecedent(path: string): PrecedentRecord | { error: string } {
  const raw = readFileSync(path, "utf8");
  const parsed = matter(raw);
  const sections = extractPrecedentSections(parsed.content);
  if ("error" in sections) return sections;
  return { path, ...sections };
}

/** Parse a corpus precedent: validated frontmatter + four content sections. */
export function parseScopedPrecedentFile(
  path: string,
  level: KnowledgeLevel,
): ScopedPrecedentRecord | { error: string; path: string } {
  const raw = readFileSync(path, "utf8");
  const parsed = matter(raw);
  const fm = PrecedentFrontmatterSchema.safeParse(parsed.data);
  if (!fm.success) {
    return {
      path,
      error: `missing/invalid frontmatter: ${fm.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    };
  }
  const sections = extractPrecedentSections(parsed.content);
  if ("error" in sections) {
    return { path, error: sections.error };
  }
  return {
    level,
    path,
    frontmatter: fm.data,
    ...sections,
  };
}

export type FindingSourceKind =
  | "architecture-decision"
  | "successful-override"
  | "repeated-choice";

export type FindingProposal = {
  kind: FindingSourceKind;
  proposedRuleId: string;
  title: string;
  body: string;
  sourceRefs: string[];
  status: "proposed" | "accepted" | "rejected";
  rejectionReason?: string;
};

export type FindingStore = {
  proposals: FindingProposal[];
  rejections: { fingerprint: string; reason: string }[];
};

function fingerprint(kind: FindingSourceKind, sourceRefs: string[]): string {
  return `${kind}:${[...sourceRefs].sort().join("|")}`;
}

/**
 * Prepare a rule proposal from a project finding (WBS 2.5).
 * Does not auto-promote: human owner must accept. Previously rejected
 * fingerprints are not re-proposed.
 */
export function prepareFindingProposal(
  store: FindingStore,
  input: {
    kind: FindingSourceKind;
    proposedRuleId: string;
    title: string;
    body: string;
    sourceRefs: string[];
  },
): { status: "proposed"; proposal: FindingProposal } | { status: "suppressed"; reason: string } {
  const fp = fingerprint(input.kind, input.sourceRefs);
  const prior = store.rejections.find((r) => r.fingerprint === fp);
  if (prior) {
    return {
      status: "suppressed",
      reason: `previously rejected: ${prior.reason}`,
    };
  }
  const proposal: FindingProposal = {
    kind: input.kind,
    proposedRuleId: input.proposedRuleId,
    title: input.title,
    body: input.body,
    sourceRefs: input.sourceRefs,
    status: "proposed",
  };
  store.proposals.push(proposal);
  return { status: "proposed", proposal };
}

/**
 * WBS 2.5.2 — when a product/service override outperformed the company rule,
 * propose reconsidering the parent norm. Uses existing finding store semantics
 * (no auto-promotion). Structured refs identify original rule + override source.
 */
export function prepareSuccessfulOverrideFinding(
  store: FindingStore,
  input: {
    /** Company (parent) rule id to reconsider. */
    originalRuleId: string;
    /** Level that successfully overrode the parent. */
    overrideLevel: "product" | "service";
    /** Product or service id / path that owns the successful override. */
    overrideSource: string;
    /** Additional durable refs (ADR, WP, etc.). */
    sourceRefs?: string[];
  },
): { status: "proposed"; proposal: FindingProposal } | { status: "suppressed"; reason: string } {
  const originalRef = `original-rule:${input.originalRuleId}`;
  const overrideRef = `override:${input.overrideLevel}/${input.overrideSource}`;
  const sourceRefs = [
    ...(input.sourceRefs ?? []),
    originalRef,
    overrideRef,
  ];
  return prepareFindingProposal(store, {
    kind: "successful-override",
    proposedRuleId: input.originalRuleId,
    title: `Reconsider company rule ${input.originalRuleId}`,
    body: [
      `A ${input.overrideLevel}-level override of company rule "${input.originalRuleId}"`,
      `from ${input.overrideSource} was used successfully and outperformed the parent norm.`,
      `Recommend reviewing whether the company rule should be updated.`,
      `No automatic promotion into the corpus — human accept/reject required.`,
    ].join(" "),
    sourceRefs,
  });
}

export function rejectFindingProposal(
  store: FindingStore,
  proposal: FindingProposal,
  reason: string,
): void {
  proposal.status = "rejected";
  proposal.rejectionReason = reason;
  store.rejections.push({
    fingerprint: fingerprint(proposal.kind, proposal.sourceRefs),
    reason,
  });
}

export function acceptFindingProposal(
  store: FindingStore,
  proposal: FindingProposal,
): void {
  proposal.status = "accepted";
}

export function findingFingerprint(
  kind: FindingSourceKind,
  sourceRefs: string[],
): string {
  return fingerprint(kind, sourceRefs);
}

/** True when a loaded rule marks an obsolete tool binding as needing review. */
export function ruleRequiresObsoleteToolReview(rule: RuleRecord): boolean {
  const binding = rule.frontmatter.obsoleteToolBinding;
  return Boolean(binding?.reviewRequired);
}

/** Load / save finding store as JSON (WBS 2.5 persistence). */
export function loadFindingStore(path: string): FindingStore {
  if (!existsSync(path)) {
    return { proposals: [], rejections: [] };
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as FindingStore;
  return {
    proposals: Array.isArray(raw.proposals) ? raw.proposals : [],
    rejections: Array.isArray(raw.rejections) ? raw.rejections : [],
  };
}

export function saveFindingStore(path: string, store: FindingStore): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
}
