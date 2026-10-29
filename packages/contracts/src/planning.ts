import { createHash } from "node:crypto";
import { z } from "zod";
import { WorkflowError } from "./errors.js";
import { canonicalText } from "./human-acts.js";
import { verifyUserApproval, type ApprovalRequest, type UserApproval } from "./user-approval.js";
import { evaluateEvidence } from "./quality-model.js";
import { RepositoryIdSchema, RequirementIdSchema, StoryIdSchema } from "./ids.js";
import {
  ACCEPTABLE_PHASES,
  ApiEndpointSchema,
  CoverageWaiverSchema,
  ImpactSchema,
  MockCollectionSchema,
  PHASES,
  PhaseSchema,
  PrototypeElementSchema,
  PrototypeDatasetSchema,
  PrototypeFeedbackSchema,
  PrototypeScenarioSchema,
  PrototypeSchema,
  PrototypeScreenSchema,
  PrototypeTokensSchema,
  RepositoryInspectionSchema,
  RepositorySchema,
  ScopeSchema,
  ServiceContractSchema,
  StoryPlanEntrySchema,
  WorkItemKindSchema,
  WorkflowModeSchema,
  type AcceptablePhase,
  type Phase,
  type Prototype,
  type PrototypeElement,
  type PrototypeScreen,
  type StoryPlan,
  type StoryPlanEntry,
} from "./planning-schemas.js";
import { STORY_CAPABILITIES, StoryCapabilitySchema, UserStorySchema, type StoryCapability, type UserStory } from "./story.js";
import type { Requirement, WorkflowState } from "./workflow.js";

/**
 * Planning behaviour: scope and review of requirements, the prototype, the story plan, story editing, repositories,
 * change impact, the stage gates and the next step. Pure functions over the workflow state: the same command on the
 * same state gives the same result, and nothing here reads a file or the network.
 */

type Now = Date | undefined;
const iso = (now: Now) => (now ?? new Date()).toISOString();

export type PlanningResult = { state: WorkflowState; duplicate: boolean; result: unknown };

// --- fingerprints: what a user's acceptance is bound to -----------------------------------------------------------

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sorted(v)]),
    );
  }
  return value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex").slice(0, 16);

const activeRequirements = (state: WorkflowState) => state.requirements.filter((r) => r.status !== "superseded");
const inScope = (state: WorkflowState) => activeRequirements(state).filter((r) => r.scope === "in");
const activeStories = (state: WorkflowState) => state.stories.filter((s) => s.status !== "superseded" && s.status !== "excluded");

/** Content of the requirements a user reviews (not their review marks, so marking does not invalidate acceptance). */
export function requirementsFingerprint(state: WorkflowState): string {
  return hash(
    activeRequirements(state).map((r) => ({
      id: r.id,
      statement: r.statement,
      scope: r.scope,
      ac: r.acceptanceCriteria.map((c) => ({ id: c.id, statement: c.statement })),
    })),
  );
}

/** What the user agrees to when they agree a contract: its content, not its status. */
export function contractsFingerprint(state: WorkflowState): string {
  return hash(state.contracts.map(({ status: _s, agreement: _a, everAgreed: _e, ...content }) => content));
}

/**
 * Interaction fields added after alpha.49 default to empty. An empty value is dropped before hashing, so a prototype saved
 * before they existed keeps the fingerprint its acceptance was recorded with (no silent "changed since you accepted it").
 */
const EMPTY_ELEMENT_DEFAULTS: Record<string, unknown> = { options: [], filters: [], detailFields: [], tabs: [], related: [], required: false };
function withoutEmptyDefaults(prototype: Omit<Prototype, "feedback" | "history" | "status" | "revision">): unknown {
  const { datasets, scenarios, limitations, screens, ...rest } = prototype;
  const out: Record<string, unknown> = { ...rest };
  if (datasets?.length) out.datasets = datasets;
  if (scenarios?.length) out.scenarios = scenarios;
  if (limitations?.length) out.limitations = limitations;
  out.screens = screens.map((screen) => ({
    ...screen,
    elements: screen.elements.map((element) => {
      const kept: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(element)) {
        if (value === undefined) continue;
        const dflt = EMPTY_ELEMENT_DEFAULTS[key];
        if (key in EMPTY_ELEMENT_DEFAULTS && JSON.stringify(dflt) === JSON.stringify(value)) continue;
        kept[key] = value;
      }
      return kept;
    }),
  }));
  return out;
}

export function prototypeFingerprint(prototype: Prototype | undefined): string {
  if (!prototype) return "none";
  const { feedback: _f, history: _h, status: _s, revision: _r, ...content } = prototype;
  return hash(withoutEmptyDefaults(content));
}

export function storyPlanFingerprint(plan: StoryPlan | undefined): string {
  if (!plan) return "none";
  // Detailing a planned story does not change the plan the user agreed to; excluding one does.
  return hash(
    plan.entries.map(({ review: _r, status, excludedReason, ...entry }) => ({ ...entry, excluded: status === "excluded", ...(status === "excluded" && excludedReason !== undefined ? { excludedReason } : {}) })),
  );
}

export function storiesFingerprint(state: WorkflowState): string {
  return hash(
    activeStories(state).map((s) => ({
      id: s.id,
      revision: s.revision,
      requirementIds: s.requirementIds,
      narrative: s.narrative,
      ac: s.acceptanceCriteria,
      happyPath: s.happyPath,
      alternatives: s.alternatives,
      negative: s.negative,
      edgeCases: s.edgeCases,
      businessRules: s.businessRules,
      expectedResults: s.expectedResults,
    })),
  );
}

export function currentFingerprint(state: WorkflowState, phase: AcceptablePhase): string {
  if (phase === "requirements_review") return requirementsFingerprint(state);
  if (phase === "prototype") return prototypeFingerprint(state.prototype);
  if (phase === "story_plan") return storyPlanFingerprint(state.storyPlan);
  return storiesFingerprint(state);
}

/** An acceptance counts only while the artifact still has the content the user accepted. */
export function acceptanceStatus(state: WorkflowState, phase: AcceptablePhase): "missing" | "accepted" | "stale" {
  const acceptance = state.phaseAcceptance[phase] as (typeof state.phaseAcceptance)[string] | undefined;
  if (!acceptance) return "missing";
  return (acceptance as { fingerprint?: string }).fingerprint === currentFingerprint(state, phase) ? "accepted" : "stale";
}

function recordAcceptance(state: WorkflowState, phase: AcceptablePhase, via: "html-review" | "approved" | "chat" | "system", now: Now): WorkflowState {
  const revision =
    phase === "prototype" ? (state.prototype?.revision ?? 0) : phase === "story_plan" ? (state.storyPlan?.revision ?? 0) : state.workItem.revision;
  return {
    ...state,
    phaseAcceptance: {
      ...state.phaseAcceptance,
      [phase]: { revision, at: iso(now), via, fingerprint: currentFingerprint(state, phase) },
    },
  };
}

function touch(state: WorkflowState, now: Now, note?: string): WorkflowState {
  const revision = state.workItem.revision + 1;
  return {
    ...state,
    updatedAt: iso(now),
    workItem: { ...state.workItem, revision },
    history: note ? [...state.history, { revision, stage: state.stage, note }] : state.history,
  };
}

// --- capabilities: what a feature must let the user do -----------------------------------------------------------

const KEYWORDS: Array<[StoryCapability, RegExp]> = [
  ["view", /\b(view|display|show|see|list|browse|read|open|detail|preview|report)\w*/i],
  ["search", /\b(search|find|lookup|look up|query)\w*/i],
  ["filter", /\b(filter|sort|group by|facet)\w*/i],
  ["create", /\b(create|add|new|register|submit|import|upload|enter)\w*/i],
  ["edit", /\b(edit|update|change|modify|rename|reschedule|assign)\w*/i],
  ["delete", /\b(delete|remove|archive|cancel|discard)\w*/i],
  ["validation", /\b(valid|invalid|required field|format|constraint|duplicate|reject)\w*/i],
  ["error", /\b(error|fail|failure|unavailable|timeout|retry|exception)\w*/i],
  ["permissions", /\b(permission|role|access|authori[sz]\w*|forbidden|denied|admin|owner|read-only)\w*/i],
  ["states", /\b(loading|empty state|no results|spinner|skeleton|empty list)\w*/i],
];

export function inferCapabilities(text: string): StoryCapability[] {
  const found = new Set<StoryCapability>();
  for (const [capability, pattern] of KEYWORDS) if (pattern.test(text)) found.add(capability);
  return [...found];
}

/**
 * Words that are DATA, not an operation: what sits in quotes or guillemets, "key=value" / "?param" tokens, code spans, and the
 * option values of the prototype's enum fields ("New", "Cancelled" are statuses, not "create" and "delete").
 */
export function maskLiterals(text: string, dataValues: string[] = []): string {
  // an apostrophe inside a word (the customer's order) is not a quote
  let out = text
    .replace(/«[^»]*»|“[^”]*”|"[^"]*"|`[^`]*`|(?<![A-Za-z0-9])'[^']*'(?![A-Za-z0-9])/g, " ")
    .replace(/[?&]?\b[\w.-]+=\S*/g, " ")
    .replace(/\bhttps?:\/\/\S+/g, " ");
  // data values are matched with their own case: the option "Open" is data, the word "open" in a sentence is an operation
  for (const value of dataValues.filter((v) => v.length > 1)) out = out.replace(new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
  return out;
}

/** The operation words that fired, with the capability each one points at (shown next to a gap so the person can judge it). */
export function capabilityEvidence(text: string): Array<{ capability: StoryCapability; phrase: string }> {
  const found: Array<{ capability: StoryCapability; phrase: string }> = [];
  for (const [capability, pattern] of KEYWORDS) {
    const match = pattern.exec(text);
    if (match) found.push({ capability, phrase: match[0] });
  }
  return found;
}

/** What the requirement statement says a user CAN do: only the clause after "can / may / must / allows ..." counts, so descriptions and data around it do not. */
const MODAL = /\b(?:can|may|must|should|shall|able to|allows?|lets?|enables?|needs? to)\b([^.;:]{0,200})/gi;
export function statedOperations(statement: string, dataValues: string[] = []): Array<{ capability: StoryCapability; phrase: string }> {
  // "e.g." / "i.e." / "etc." end no sentence
  const masked = maskLiterals(statement, dataValues).replace(/\b(?:e\.g\.|i\.e\.|etc\.|vs\.)/gi, " ");
  const out: Array<{ capability: StoryCapability; phrase: string }> = [];
  for (const m of masked.matchAll(MODAL)) for (const hit of capabilityEvidence(m[1] ?? "")) if (!out.some((x) => x.capability === hit.capability)) out.push(hit);
  return out;
}

const storyText = (story: Pick<UserStory, "narrative" | "objective" | "happyPath" | "alternatives" | "negative" | "edgeCases" | "businessRules" | "acceptanceCriteria" | "title">) =>
  [story.title ?? "", story.narrative, story.objective, ...story.happyPath, ...story.alternatives, ...story.negative, ...story.edgeCases, ...story.businessRules, ...story.acceptanceCriteria.map((c) => `${c.given} ${c.when} ${c.then}`)].join(" ");

/** Declared capabilities plus what the story text shows. */
export function storyCapabilities(story: UserStory): StoryCapability[] {
  return [...new Set<StoryCapability>([...story.capabilities, ...inferCapabilities(storyText(story))])];
}

/**
 * What an element lets a user do. For elements whose kind already says it (a filter filters, a search searches, a table or a card shows
 * data) the kind wins: an `intent` that contradicts it (a filter tagged "search") must not turn into a second required story. For the
 * generic kinds (button, field, form, link) the author's `intent` is the only signal there is.
 */
function elementCapability(element: PrototypeElement): StoryCapability | null {
  switch (element.kind) {
    case "table":
    case "list":
    case "drawer":
    case "modal":
      return "view";
    case "search":
      return "search";
    case "filter":
      return "filter";
    case "tabs":
      return element.intent ?? "view";
    default:
      break;
  }
  if (element.intent) return element.intent;
  switch (element.kind) {
    case "form":
    case "field":
      return "create";
    default:
      return null;
  }
}

export type CoverageGap = { requirementId: string; expected: StoryCapability[]; covered: StoryCapability[]; missing: StoryCapability[]; reason: string; /** Per missing capability: which phrase or prototype element asked for it. */ because: Record<string, string> };

/** Values of enum fields in the prototype: statuses and the like are data. */
function dataValuesOf(state: WorkflowState): string[] {
  return (state.prototype?.mock ?? []).flatMap((c) => c.fields.flatMap((f) => f.options ?? []));
}

type Expectation = { required: StoryCapability[]; advisory: Array<{ capability: StoryCapability; because: string }>; because: Record<string, string> };

function expectationsFor(state: WorkflowState, requirement: Requirement): Expectation {
  const data = dataValuesOf(state);
  const because: Record<string, string> = {};
  const required = new Set<StoryCapability>();
  const need = (c: StoryCapability, why: string) => {
    required.add(c);
    because[c] ??= why;
  };
  // 1. what the requirement statement says a user can do (its own words, outside quotes and data values)
  for (const hit of statedOperations(requirement.statement, data)) need(hit.capability, `the statement says "${hit.phrase}"`);
  // 2. what the prototype built for this requirement does
  let uiLinked = false;
  for (const screen of state.prototype?.screens ?? []) {
    for (const element of screen.elements) {
      if (!element.requirementIds.includes(requirement.id)) continue;
      // An element that names the criteria it serves asks for its capability only from the requirements that own one of them: linking a
      // filter to a data-model requirement because one criterion mentions its values must not demand a filter story there.
      if (element.acIds.length > 0 && !requirement.acceptanceCriteria.some((c) => element.acIds.includes(c.id))) continue;
      uiLinked = true;
      const capability = elementCapability(element);
      if (capability) need(capability, `prototype element ${screen.id}#${element.id} (${element.intent ? `intent ${element.intent}` : element.kind})`);
      if (element.allowedRoles.length > 0) need("permissions", `prototype element ${screen.id}#${element.id} is limited to roles`);
    }
    if (screen.states.some((s) => s !== "default") && screen.elements.some((e) => e.requirementIds.includes(requirement.id))) {
      need("states", `prototype screen ${screen.id} has states besides default`);
      if (screen.states.includes("denied")) need("permissions", `prototype screen ${screen.id} has a denied state`);
    }
  }
  // 3. what the endpoints do, by HTTP method
  for (const endpoint of state.prototype?.endpoints ?? []) {
    if (!endpoint.requirementIds.includes(requirement.id)) continue;
    const why = `endpoint ${endpoint.method} ${endpoint.path}`;
    need(endpoint.method === "GET" ? "view" : endpoint.method === "DELETE" ? "delete" : endpoint.method === "POST" ? "create" : "edit", why);
    if (endpoint.auth) need("permissions", `${why} needs authorization`);
    if (endpoint.responses.some((r) => r.status >= 400)) need("error", `${why} has an error response`);
  }
  // The data a user creates or changes must be viewable: a feature of only "create" stories is incomplete.
  if ((required.has("create") || required.has("edit")) && !required.has("view")) need("view", `${required.has("create") ? "create" : "edit"} implies the result can be seen`);
  // A screen that can fail or be empty needs its states and an error path.
  if (uiLinked && required.has("view") && !required.has("states")) need("states", "the prototype shows this requirement on a screen");
  // 4. the criteria texts and the rest of the statement only SUGGEST: never a blocking gap, always with the phrase that fired
  const advisory: Expectation["advisory"] = [];
  const texts = [requirement.statement, ...requirement.acceptanceCriteria.map((c) => c.statement)];
  for (const text of texts) {
    for (const hit of capabilityEvidence(maskLiterals(text, data))) {
      if (required.has(hit.capability) || advisory.some((a) => a.capability === hit.capability)) continue;
      advisory.push({ capability: hit.capability, because: `the text says "${hit.phrase}"` });
    }
  }
  return { required: STORY_CAPABILITIES.filter((c) => c !== "other" && required.has(c)), advisory, because };
}

/** What a requirement implies the user must be able to do: its stated operations and what the prototype and endpoints built for it do. */
export function expectedCapabilities(state: WorkflowState, requirement: Requirement): StoryCapability[] {
  return expectationsFor(state, requirement).required;
}

export type CoverageReport = {
  ok: boolean;
  gaps: CoverageGap[];
  /** Suggestions from wording in the criteria: shown with the phrase that fired, never blocking, never needed to be waived. */
  advisories: CoverageGap[];
  requirementsWithoutStories: string[];
  criteriaWithoutStory: string[];
  waived: string[];
  /** Stories of requirements that are out of scope: these should be excluded. */
  storiesOutOfScope: string[];
};

export function analyzeStoryCoverage(state: WorkflowState): CoverageReport {
  const waivers = state.waivers;
  const waived = (kind: string, requirementId?: string) =>
    waivers.some((w) => w.kind === kind && (w.requirementId === undefined || w.requirementId === requirementId));
  const stories = activeStories(state);
  const planEntries = (state.storyPlan?.entries ?? []).filter((e) => e.status !== "excluded");
  const gaps: CoverageGap[] = [];
  const advisories: CoverageGap[] = [];
  const requirementsWithoutStories: string[] = [];
  const criteriaWithoutStory: string[] = [];
  const used: string[] = [];
  for (const requirement of inScope(state)) {
    const covering = stories.filter((s) => s.requirementIds.includes(requirement.id));
    const planned = planEntries.filter((e) => e.requirementIds.includes(requirement.id) && !covering.some((s) => s.id === e.id));
    const caps = new Set<StoryCapability>();
    for (const story of covering) for (const c of storyCapabilities(story)) caps.add(c);
    for (const entry of planned) {
      for (const c of entry.capabilities) caps.add(c);
      for (const c of inferCapabilities(`${entry.title} ${entry.implementation} ${entry.userGets}`)) caps.add(c);
    }
    if (covering.length + planned.length === 0 && !waived("requirement-without-story", requirement.id)) requirementsWithoutStories.push(requirement.id);
    const expectation = expectationsFor(state, requirement);
    const expected = expectation.required;
    const missing = expected.filter((c) => !caps.has(c) && !waived(c, requirement.id));
    if (missing.length > 0 && covering.length + planned.length > 0) {
      gaps.push({
        requirementId: requirement.id,
        expected,
        covered: [...caps],
        missing,
        reason: `${requirement.id} implies ${expected.join(", ")}; no story covers ${missing.join(", ")} (${missing.map((c) => `${c}: ${expectation.because[c]}`).join("; ")})`,
        because: Object.fromEntries(missing.map((c) => [c, expectation.because[c] ?? ""])),
      });
    }
    const suggested = expectation.advisory.filter((a) => !caps.has(a.capability) && !waived(a.capability, requirement.id));
    if (suggested.length > 0 && covering.length + planned.length > 0) {
      advisories.push({
        requirementId: requirement.id,
        expected: suggested.map((a) => a.capability),
        covered: [...caps],
        missing: suggested.map((a) => a.capability),
        reason: `${requirement.id}: the wording suggests ${suggested.map((a) => `${a.capability} (${a.because})`).join("; ")}. A suggestion, not a gap: nothing blocks on it.`,
        because: Object.fromEntries(suggested.map((a) => [a.capability, a.because])),
      });
    }
    for (const criterion of requirement.acceptanceCriteria) {
      const inStory = covering.some((s) => s.acceptanceCriteria.some((c) => c.id.startsWith(criterion.id)) || (s as unknown as { coversAcIds?: string[] }).coversAcIds?.includes(criterion.id));
      const inPlan = planEntries.some((e) => e.acIds.includes(criterion.id));
      // A requirement with stories but no explicit AC link is reported so the AC is not silently dropped.
      if (!inStory && !inPlan && covering.length + planned.length > 0) criteriaWithoutStory.push(criterion.id);
      used.push(criterion.id);
    }
  }
  const storiesOutOfScope = stories
    .filter((s) => s.requirementIds.every((id) => !inScope(state).some((r) => r.id === id)))
    .map((s) => s.id);
  return {
    ok: gaps.length === 0 && requirementsWithoutStories.length === 0 && storiesOutOfScope.length === 0,
    gaps,
    advisories,
    requirementsWithoutStories,
    criteriaWithoutStory,
    waived: waivers.map((w) => `${w.kind}${w.requirementId ? `:${w.requirementId}` : ""}`),
    storiesOutOfScope,
  };
}

// --- scope cascade -------------------------------------------------------------------------------------------------

function snapshot(story: UserStory) {
  return {
    narrative: story.narrative,
    objective: story.objective,
    acceptanceCriteria: story.acceptanceCriteria.map((c) => ({ ...c })),
    status: story.status,
    confirmedBehavior: story.confirmedBehavior,
  };
}

function pushHistory(state: WorkflowState, story: UserStory, kind: "edit" | "exclude" | "restore" | "split" | "merge" | "scope" | "requirement-change", summary: string, now: Now): WorkflowState {
  const entry = { storyId: story.id, revision: story.revision, at: iso(now), kind, summary, previous: snapshot(story) };
  return { ...state, storyHistory: [...state.storyHistory, entry].slice(-500) };
}

/** Stories and plan lines of requirements that left the scope are excluded; those whose requirement returned are restored for re-review. */
function cascadeScope(state: WorkflowState, now: Now): { state: WorkflowState; excluded: string[]; restored: string[] } {
  const live = new Set(inScope(state).map((r) => r.id as string));
  const excluded: string[] = [];
  const restored: string[] = [];
  let next = state;
  const stories = state.stories.map((story) => {
    if (story.status === "superseded") return story;
    const hasScope = story.requirementIds.some((id) => live.has(id));
    if (!hasScope && story.status !== "excluded") {
      excluded.push(story.id);
      next = pushHistory(next, story, "scope", "all of its requirements left the scope", now);
      return { ...story, status: "excluded" as const, excludedReason: "scope: all requirements are deferred or excluded", confirmedBehavior: false, revision: story.revision + 1 };
    }
    if (hasScope && story.status === "excluded" && story.excludedReason?.startsWith("scope:")) {
      restored.push(story.id);
      next = pushHistory(next, story, "restore", "a requirement returned to the scope", now);
      const { excludedReason: _e, ...rest } = story;
      return { ...rest, status: "proposed" as const, confirmedBehavior: false, revision: story.revision + 1 };
    }
    return story;
  });
  next = { ...next, stories };
  if (next.storyPlan) {
    const entries = next.storyPlan.entries.map((entry) => {
      const hasScope = entry.requirementIds.some((id) => live.has(id));
      if (!hasScope && entry.status !== "excluded") return { ...entry, status: "excluded" as const, excludedReason: "scope: all requirements are deferred or excluded" };
      if (hasScope && entry.status === "excluded" && entry.excludedReason?.startsWith("scope:")) {
        const { excludedReason: _e, ...rest } = entry;
        return { ...rest, status: restored.includes(entry.id) ? ("detailed" as const) : ("planned" as const) };
      }
      return entry;
    });
    next = { ...next, storyPlan: { ...next.storyPlan, entries } };
  }
  return { state: next, excluded, restored };
}

function dropDanglingRefs(state: WorkflowState): WorkflowState {
  const acIds = new Set(activeRequirements(state).flatMap((r) => r.acceptanceCriteria.map((c) => c.id)));
  let next = state;
  if (state.prototype) {
    const screens = state.prototype.screens.map((screen) => ({
      ...screen,
      elements: screen.elements.map((e) => ({ ...e, acIds: e.acIds.filter((id) => acIds.has(id)) })),
    }));
    const endpoints = state.prototype.endpoints.map((e) => ({ ...e, acIds: e.acIds.filter((id) => acIds.has(id)) }));
    next = { ...next, prototype: { ...state.prototype, screens, endpoints } };
  }
  if (next.storyPlan) {
    next = { ...next, storyPlan: { ...next.storyPlan, entries: next.storyPlan.entries.map((e) => ({ ...e, acIds: e.acIds.filter((id) => acIds.has(id)) })) } };
  }
  return next;
}

// --- commands ----------------------------------------------------------------------------------------------------

const Via = z.enum(["html-review", "approved", "chat", "system"]).default("chat");
const ReviewStatus = z.enum(["pending", "accepted", "rejected"]);

const AcDecision = z.object({
  id: z.string().min(1),
  status: ReviewStatus.optional(),
  comment: z.string().optional(),
  statement: z.string().min(1).refine((v) => v.trim().length > 0, "must not be blank").optional(),
});
const RequirementDecision = z.object({
  requirementId: RequirementIdSchema,
  statement: z.string().min(1).refine((v) => v.trim().length > 0, "must not be blank").optional(),
  scope: ScopeSchema.optional(),
  scopeNote: z.string().optional(),
  comment: z.string().optional(),
  acceptance: z.array(AcDecision).default([]),
  addAcceptance: z.array(z.object({ statement: z.string().min(1) })).default([]),
  removeAcceptance: z.array(z.string()).default([]),
});

const PrototypeInput = PrototypeSchema.omit({ revision: true, status: true, history: true, feedback: true }).partial({ id: true, styles: true });
const PrototypeOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set-meta"), title: z.string().min(1).optional(), notes: z.string().optional(), startScreen: z.string().optional(), roles: z.array(z.string()).optional(), limitations: z.array(z.string()).optional() }),
  z.object({ op: z.literal("set-dataset"), dataset: PrototypeDatasetSchema }),
  z.object({ op: z.literal("remove-dataset"), id: z.string() }),
  z.object({ op: z.literal("set-scenario"), scenario: PrototypeScenarioSchema }),
  z.object({ op: z.literal("remove-scenario"), id: z.string() }),
  z.object({ op: z.literal("add-screen"), screen: PrototypeScreenSchema }),
  z.object({ op: z.literal("update-screen"), id: z.string(), patch: PrototypeScreenSchema.omit({ id: true, elements: true }).partial() }),
  z.object({ op: z.literal("remove-screen"), id: z.string() }),
  z.object({ op: z.literal("add-element"), screenId: z.string(), element: PrototypeElementSchema, index: z.number().int().nonnegative().optional() }),
  z.object({ op: z.literal("update-element"), screenId: z.string(), id: z.string(), patch: PrototypeElementSchema.omit({ id: true }).partial() }),
  z.object({ op: z.literal("remove-element"), screenId: z.string(), id: z.string() }),
  z.object({ op: z.literal("set-mock"), collection: MockCollectionSchema }),
  z.object({ op: z.literal("remove-mock"), id: z.string() }),
  z.object({ op: z.literal("set-tokens"), styles: PrototypeTokensSchema }),
  z.object({ op: z.literal("set-endpoint"), endpoint: ApiEndpointSchema }),
  z.object({ op: z.literal("remove-endpoint"), id: z.string() }),
  z.object({ op: z.literal("link"), screenId: z.string(), elementId: z.string(), requirementIds: z.array(RequirementIdSchema).optional(), acIds: z.array(z.string()).optional() }),
]);

const PlanOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), entry: StoryPlanEntrySchema.omit({ status: true, review: true }) }),
  z.object({ op: z.literal("update"), id: StoryIdSchema, patch: StoryPlanEntrySchema.omit({ id: true, status: true, review: true }).partial() }),
  z.object({ op: z.literal("exclude"), id: StoryIdSchema, reason: z.string().min(1) }),
  z.object({ op: z.literal("restore"), id: StoryIdSchema }),
  z.object({ op: z.literal("review"), id: StoryIdSchema, status: ReviewStatus, comment: z.string().optional() }),
]);

const StoryPatch = z.object({
  title: z.string().optional(),
  actor: z.string().min(1).optional(),
  narrative: z.string().min(1).optional(),
  objective: z.string().min(1).optional(),
  userValue: z.string().min(1).optional(),
  preconditions: z.array(z.string()).optional(),
  happyPath: z.array(z.string()).min(1).optional(),
  alternatives: z.array(z.string()).optional(),
  negative: z.array(z.string()).optional(),
  edgeCases: z.array(z.string()).optional(),
  businessRules: z.array(z.string()).optional(),
  expectedResults: z.array(z.string()).min(1).optional(),
  dependencies: z.array(z.string()).optional(),
  requirementIds: z.array(RequirementIdSchema).min(1).optional(),
  capabilities: z.array(StoryCapabilitySchema).optional(),
  screenRefs: z.array(z.string()).optional(),
  repositoryIds: z.array(z.string()).optional(),
  serviceIds: z.array(z.string()).optional(),
});
const CriterionOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), id: z.string().min(1), given: z.string().min(1), when: z.string().min(1), then: z.string().min(1) }),
  z.object({ op: z.literal("add"), id: z.string().min(1).optional(), given: z.string().min(1), when: z.string().min(1), then: z.string().min(1) }),
  z.object({ op: z.literal("remove"), id: z.string().min(1) }),
]);
const NewStoryFromOriginal = StoryPatch.extend({
  id: StoryIdSchema,
  /** Acceptance criteria of the original that move to this story. */
  moveAcceptance: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.object({ id: z.string().min(1).optional(), given: z.string().min(1), when: z.string().min(1), then: z.string().min(1) })).default([]),
});

export const PlanningCommandSchemas = [
  z.object({ action: z.literal("review-requirements"), via: Via, decisions: z.array(RequirementDecision).min(1) }),
  /** Changes the text of single acceptance criteria by their stable id; nothing else is touched. */
  z.object({ action: z.literal("revise-acceptance"), edits: z.array(z.object({ id: z.string().min(1), statement: z.string().min(1).refine((v) => v.trim().length > 0, "must not be blank"), expectedRevision: z.number().int().positive().optional() })).min(1) }),
  z.object({ action: z.literal("accept-requirements"), via: Via, requirementIds: z.array(RequirementIdSchema).optional() }),
  z.object({ action: z.literal("set-requirement-scope"), requirementIds: z.array(RequirementIdSchema).min(1), scope: ScopeSchema, note: z.string().optional() }),
  z.object({ action: z.literal("set-prototype"), prototype: PrototypeInput, summary: z.string().optional() }),
  z.object({ action: z.literal("update-prototype"), operations: z.array(PrototypeOperation).min(1), summary: z.string().optional() }),
  z.object({ action: z.literal("prototype-feedback"), items: z.array(z.object({ target: z.string().min(1), comment: z.string().min(1) })).default([]), resolve: z.array(z.string()).default([]), via: Via }),
  z.object({ action: z.literal("accept-prototype"), via: Via }),
  z.object({ action: z.literal("set-story-plan"), entries: z.array(StoryPlanEntrySchema.omit({ status: true, review: true })).min(1) }),
  z.object({ action: z.literal("update-story-plan"), operations: z.array(PlanOperation).min(1), via: Via }),
  z.object({ action: z.literal("agree-story-plan"), via: Via }),
  z.object({ action: z.literal("update-story"), id: StoryIdSchema, patch: StoryPatch.default({}), criteria: z.array(CriterionOp).default([]), reason: z.string().optional() }),
  z.object({ action: z.literal("exclude-story"), id: StoryIdSchema, reason: z.string().min(1) }),
  z.object({ action: z.literal("restore-story"), id: StoryIdSchema }),
  z.object({ action: z.literal("split-story"), id: StoryIdSchema, into: z.array(NewStoryFromOriginal).min(2), reason: z.string().optional() }),
  z.object({ action: z.literal("merge-stories"), ids: z.array(StoryIdSchema).min(2), into: StoryPatch.extend({ id: StoryIdSchema }), reason: z.string().optional() }),
  z.object({
    action: z.literal("review-stories"),
    via: Via,
    items: z.array(z.object({ storyId: StoryIdSchema, revision: z.number().int().positive(), key: z.string().min(1), status: ReviewStatus, comment: z.string().optional() })).default([]),
    acceptStories: z.array(z.object({ storyId: StoryIdSchema, revision: z.number().int().positive() })).default([]),
  }),
  z.object({ action: z.literal("accept-stories"), via: Via }),
  z.object({ action: z.literal("register-repository"), repository: RepositorySchema.pick({ id: true, name: true }).extend({ role: z.string().default(""), localPath: z.string().optional(), remoteUrl: z.string().optional(), branch: z.string().optional(), notes: z.string().optional() }) }),
  z.object({ action: z.literal("assign-repositories"), repositoryIds: z.array(RepositoryIdSchema).min(1), storyIds: z.array(StoryIdSchema).default([]), requirementIds: z.array(RequirementIdSchema).default([]), serviceIds: z.array(z.string()).default([]) }),
  z.object({ action: z.literal("record-repository-inspection"), repositoryId: RepositoryIdSchema, inspection: RepositoryInspectionSchema }),
  z.object({ action: z.literal("set-contract"), via: Via, contract: ServiceContractSchema.omit({ agreement: true, everAgreed: true }) }),
  z.object({ action: z.literal("set-mode"), mode: WorkflowModeSchema, reason: z.string().optional() }),
  z.object({ action: z.literal("remove-contract"), via: Via, id: z.string().min(1) }),
  z.object({ action: z.literal("record-impact"), impact: ImpactSchema.omit({ revision: true, recordedAt: true }) }),
  z.object({ action: z.literal("advance-phase"), to: PhaseSchema, reason: z.string().optional() }),
  z.object({ action: z.literal("return-to-phase"), to: PhaseSchema, reason: z.string().min(1) }),
  z.object({ action: z.literal("log-session"), summary: z.string().min(1), nextAction: z.string().optional(), role: z.string().optional() }),
  z.object({ action: z.literal("waive-coverage"), kind: z.string().min(1), requirementId: RequirementIdSchema.optional(), reason: z.string().min(1) }),
  z.object({ action: z.literal("set-work-item-kind"), kind: WorkItemKindSchema }),
] as const;

export const PLANNING_ACTIONS: ReadonlySet<string> = new Set(PlanningCommandSchemas.map((schema) => schema.shape.action.value));
export type PlanningCommand = z.infer<(typeof PlanningCommandSchemas)[number]>;

const missing = (code: string, message: string, details?: Record<string, unknown>) => new WorkflowError(code, message, details);
const requirementOf = (state: WorkflowState, id: string) => {
  const found = activeRequirements(state).find((r) => r.id === id);
  if (!found) throw missing("MISSING_REQUIREMENT", `requirement ${id} not found`);
  return found;
};

// --- requirement review ----------------------------------------------------------------------------------------

/** Keeps what a revision replaces. Prototype snapshots are the most recent ten; the rest are capped together. */
function keepArtifact(state: WorkflowState, kind: "requirement" | "prototype" | "story-plan", id: string, revision: number, value: unknown, now: Now): WorkflowState {
  const kept = state.artifactHistory;
  const entry = { kind, id, revision, at: iso(now), snapshot: JSON.stringify(value) };
  const all = [...kept, entry];
  const protos = all.filter((h) => h.kind === "prototype");
  const drop = new Set(protos.slice(0, Math.max(0, protos.length - 10)));
  let kept2 = all.filter((h) => !drop.has(h)).slice(-150);
  // bounded by size as well as by count: oldest snapshots go first once the history passes 1 MB
  let bytes = kept2.reduce((n, h) => n + h.snapshot.length, 0);
  while (bytes > 1_000_000 && kept2.length > 1) {
    bytes -= kept2[0].snapshot.length;
    kept2 = kept2.slice(1);
  }
  return { ...state, artifactHistory: kept2 };
}

function applyRequirementDecisions(state: WorkflowState, command: Extract<PlanningCommand, { action: "review-requirements" }>, now: Now, approvedRewording = false): PlanningResult {
  let next = state;
  const changed: string[] = [];
  const summary: string[] = [];
  const acceptanceChanges: Array<Record<string, unknown>> = [];
  let contentChanged = false;
  for (const decision of command.decisions) {
    const current = requirementOf(next, decision.requirementId);
    let requirement: Requirement = { ...current, acceptanceCriteria: current.acceptanceCriteria.map((c) => ({ ...c })) };
    let revised = false;
    if (decision.statement !== undefined && decision.statement !== requirement.statement) {
      requirement = { ...requirement, statement: decision.statement };
      revised = true;
    }
    if (decision.scope !== undefined && decision.scope !== requirement.scope) {
      requirement = { ...requirement, scope: decision.scope, scopeNote: decision.scopeNote ?? requirement.scopeNote };
      revised = true;
      summary.push(`${requirement.id} scope ${current.scope} -> ${decision.scope}`);
    } else if (decision.scopeNote !== undefined) {
      if (decision.scopeNote !== (requirement.scopeNote ?? "")) summary.push(`${requirement.id} scope note changed`);
      requirement = { ...requirement, scopeNote: decision.scopeNote };
    }
    if (decision.comment !== undefined) {
      const next = decision.comment === "" ? undefined : decision.comment;
      if (next !== requirement.comment) summary.push(`${requirement.id} comment ${next === undefined ? "cleared" : "changed"}`);
      const { comment: _old, ...rest } = requirement;
      requirement = next === undefined ? rest : { ...rest, comment: next };
    }
    for (const ac of decision.acceptance) {
      const index = requirement.acceptanceCriteria.findIndex((c) => c.id === ac.id);
      if (index < 0) throw missing("MISSING_ACCEPTANCE_CRITERION", `${ac.id} is not an acceptance criterion of ${requirement.id}`);
      let criterion = requirement.acceptanceCriteria[index];
      const before = criterion;
      if (ac.statement !== undefined && ac.statement.trim() !== criterion.statement.trim()) {
        const old = criterion.review;
        if (command.via === "chat" && !approvedRewording && old.status === "accepted") {
          throw new WorkflowError("USER_DECISION_REQUIRED", `${ac.id} is accepted by the user; an agent does not reword it through review-requirements. Use revise-acceptance: the user is asked to approve the new wording in the client's dialog.`);
        }
        // the decision the text had stays readable (with its reason) after the text is revised and the item goes back to pending
        const previous = old.status !== "pending" || old.comment ? { status: old.status, ...(old.comment ? { comment: old.comment } : {}), ...(old.at ? { at: old.at } : {}), ...(old.via ? { via: old.via } : {}), revision: criterion.revision } : old.previous;
        criterion = { ...criterion, statement: ac.statement.trim(), revision: criterion.revision + 1, review: { status: "pending", ...(previous ? { previous } : {}) } };
        revised = true;
        summary.push(`${ac.id} edited`);
        acceptanceChanges.push({
          id: ac.id,
          requirementId: requirement.id,
          before: { statement: before.statement, revision: before.revision, status: old.status, ...(old.comment ? { comment: old.comment } : {}) },
          after: { statement: ac.statement.trim(), revision: criterion.revision, status: "pending" },
          previousKept: Boolean(previous),
        });
      }
      if (ac.status !== undefined || ac.comment !== undefined) {
        const old = criterion.review;
        const statusChanged = ac.status !== undefined && ac.status !== old.status;
        const nextComment = ac.comment !== undefined ? (ac.comment === "" ? undefined : ac.comment) : old.comment;
        const commentChanged = ac.comment !== undefined && nextComment !== old.comment;
        if (commentChanged && command.via === "chat" && old.comment && (old.commentVia === "html-review" || old.commentVia === "approved" || (old.commentVia === undefined && old.via !== undefined && old.via !== "chat"))) {
          throw new WorkflowError("USER_DECISION_REQUIRED", `${ac.id} carries a remark the user wrote; only the user changes or clears it (in the review page). Propose a new text for the criterion instead.`);
        }
        // `at`/`via` describe the STATUS decision: they move only when the status moves, never because a comment was edited
        const decided = statusChanged ? { at: iso(now), via: command.via } : { ...(old.at ? { at: old.at } : {}), ...(old.via ? { via: old.via } : {}) };
        const commented = commentChanged ? { commentAt: iso(now), commentVia: command.via } : { ...(old.commentAt ? { commentAt: old.commentAt } : {}), ...(old.commentVia ? { commentVia: old.commentVia } : {}) };
        criterion = {
          ...criterion,
          review: {
            status: ac.status ?? old.status,
            ...(nextComment !== undefined ? { comment: nextComment } : {}),
            ...decided,
            ...commented,
            ...(old.previous ? { previous: old.previous } : {}),
          },
        };
        if (statusChanged) summary.push(`${ac.id} ${ac.status}`);
        if (commentChanged) summary.push(`${ac.id} comment ${nextComment === undefined ? "cleared" : "changed"}`);
      }
      requirement.acceptanceCriteria[index] = criterion;
    }
    for (const statement of decision.addAcceptance) {
      // a retired id is never handed out again: a result recorded for the removed criterion must not count for a new one
      const used = [...requirement.acceptanceCriteria.map((c) => c.id), ...(requirement.retiredCriteria ?? []), ...next.coverage.filter((e) => e.requirementId === requirement.id).map((e) => e.acceptanceCriterionId)].map((id) => Number(id.match(/-AC-(\d{1,6})$/)?.[1] ?? 0));
      const nextNumber = Math.max(0, ...used) + 1;
      requirement.acceptanceCriteria.push({
        id: `${requirement.id}-AC-${String(nextNumber).padStart(2, "0")}`,
        requirementId: requirement.id as Requirement["id"],
        statement: statement.statement,
        revision: 1,
        review: { status: "pending" },
      });
      revised = true;
      summary.push(`${requirement.id} AC added`);
    }
    for (const id of decision.removeAcceptance) {
      if (!requirement.acceptanceCriteria.some((c) => c.id === id)) throw missing("MISSING_ACCEPTANCE_CRITERION", `${id} is not an acceptance criterion of ${requirement.id}`);
      if (command.via === "chat" && requirement.acceptanceCriteria.find((c) => c.id === id)!.review.status === "accepted") {
        throw new WorkflowError("USER_DECISION_REQUIRED", `${id} is accepted by the user; an agent does not remove it. The user removes it in the review page.`);
      }
      requirement.acceptanceCriteria = requirement.acceptanceCriteria.filter((c) => c.id !== id);
      requirement.retiredCriteria = [...new Set([...(requirement.retiredCriteria ?? []), id])];
      revised = true;
      summary.push(`${id} removed`);
    }
    if (revised) {
      next = keepArtifact(next, "requirement", current.id, current.revision, current, now);
      requirement = { ...requirement, revision: current.revision + 1, status: "proposed" };
      contentChanged = true;
      changed.push(requirement.id);
      next = markDownstreamStale(next, requirement.id, now);
    }
    next = { ...next, requirements: next.requirements.map((r) => (r === current ? requirement : r)) };
  }
  if (contentChanged) {
    next = dropDanglingRefs(next);
    next = cascadeScope(next, now).state;
  }
  if (summary.length === 0 && !contentChanged) {
    // nothing differs from what is stored: no revision, no history line, no new state
    return { state, duplicate: true, result: { changedRequirementIds: [], noChange: true, reviewProgress: reviewProgress(state), accepted: acceptanceStatus(state, "requirements_review") === "accepted" } };
  }
  next = touch(next, now, `requirements reviewed (${command.via}): ${summary.join("; ")}`);
  // The user ticking every criterion IS the acceptance of the review: no second checkbox is needed.
  const marked = command.decisions.some((d) => d.acceptance.some((a) => a.status !== undefined));
  if (marked && (command.via === "html-review" || command.via === "approved") && reviewProgress(next).complete && acceptanceStatus(next, "requirements_review") !== "accepted") {
    next = recordAcceptance(next, "requirements_review", command.via, now);
    next = { ...next, requirements: next.requirements.map((r) => (r.scope === "in" && r.status !== "superseded" ? { ...r, status: "approved" as const } : r)) };
  }
  return { state: next, duplicate: false, result: { changedRequirementIds: changed, ...(acceptanceChanges.length ? { acceptanceChanges } : {}), reviewProgress: reviewProgress(next), accepted: acceptanceStatus(next, "requirements_review") === "accepted" } };
}

/** Verdicts, implementation units and stories that rest on a requirement are stale once it changes. */
function markDownstreamStale(state: WorkflowState, requirementId: string, now: Now): WorkflowState {
  let next = state;
  const stories = state.stories.map((story) => {
    if (!story.requirementIds.includes(requirementId as Requirement["id"]) || story.status === "superseded") return story;
    next = pushHistory(next, story, "requirement-change", `${requirementId} changed`, now);
    return { ...story, stale: true, revision: story.revision + 1, confirmedBehavior: false, status: story.status === "confirmed" ? ("proposed" as const) : story.status };
  });
  return {
    ...next,
    stories,
    verdicts: state.verdicts.map((v) => (v.requirementIds.includes(requirementId as Requirement["id"]) ? { ...v, stale: true, invalidatedBy: requirementId } : v)),
    implementationUnits: state.implementationUnits.map((u) => (u.requirementIds.includes(requirementId as Requirement["id"]) ? { ...u, stale: true } : u)),
  };
}

export function reviewProgress(state: WorkflowState) {
  const reqs = inScope(state);
  const criteria = reqs.flatMap((r) => r.acceptanceCriteria);
  const count = (status: string) => criteria.filter((c) => c.review.status === status).length;
  return {
    requirements: reqs.length,
    deferred: activeRequirements(state).filter((r) => r.scope === "deferred").length,
    excluded: activeRequirements(state).filter((r) => r.scope === "excluded").length,
    criteria: criteria.length,
    accepted: count("accepted"),
    rejected: count("rejected"),
    pending: count("pending"),
    complete: criteria.length > 0 && criteria.every((c) => c.review.status === "accepted") && reqs.every((r) => r.acceptanceCriteria.length > 0),
  };
}

// --- prototype -------------------------------------------------------------------------------------------------

/** The prototype is stored as written (mock rows and API examples need names like password or Authorization), so a value that looks like a real secret is refused instead. */
const REAL_SECRET = /(Bearer\s+[A-Za-z0-9._~+\/-]{20,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
function assertNoRealSecrets(value: unknown, where: string): void {
  if (typeof value === "string") {
    if (REAL_SECRET.test(value)) throw missing("PROTOTYPE_SECRET", `${where} contains something that looks like a real secret or token; use an obviously fake value`);
  } else if (Array.isArray(value)) value.forEach((v, i) => assertNoRealSecrets(v, `${where}[${i}]`));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) assertNoRealSecrets(v, `${where}.${k}`);
}

function validatePrototype(state: WorkflowState, prototype: Prototype): void {
  assertNoRealSecrets(prototype, "the prototype");
  const screenIds = new Set<string>();
  for (const screen of prototype.screens) {
    if (screenIds.has(screen.id)) throw missing("PROTOTYPE_INVALID", `duplicate screen id ${screen.id}`);
    screenIds.add(screen.id);
  }
  const collections = new Set(prototype.mock.map((c) => c.id));
  const reqIds = new Set(activeRequirements(state).map((r) => r.id as string));
  const acIds = new Set(activeRequirements(state).flatMap((r) => r.acceptanceCriteria.map((c) => c.id)));
  for (const screen of prototype.screens) {
    const elementIds = new Set<string>();
    for (const element of screen.elements) {
      if (elementIds.has(element.id)) throw missing("PROTOTYPE_INVALID", `duplicate element id ${element.id} on ${screen.id}`);
      elementIds.add(element.id);
      if (element.navigatesTo && !screenIds.has(element.navigatesTo)) throw missing("PROTOTYPE_INVALID", `${screen.id}#${element.id} opens unknown screen ${element.navigatesTo}`);
      if (element.collection && !collections.has(element.collection)) throw missing("PROTOTYPE_INVALID", `${screen.id}#${element.id} uses unknown mock collection ${element.collection}`);
      for (const id of element.requirementIds) if (!reqIds.has(id)) throw missing("PROTOTYPE_INVALID", `${screen.id}#${element.id} links unknown requirement ${id}`);
      for (const id of element.acIds) if (!acIds.has(id)) throw missing("PROTOTYPE_INVALID", `${screen.id}#${element.id} links unknown acceptance criterion ${id}`);
    }
  }
  for (const endpoint of prototype.endpoints) {
    for (const id of endpoint.requirementIds) if (!reqIds.has(id)) throw missing("PROTOTYPE_INVALID", `endpoint ${endpoint.id} links unknown requirement ${id}`);
    for (const id of endpoint.acIds) if (!acIds.has(id)) throw missing("PROTOTYPE_INVALID", `endpoint ${endpoint.id} links unknown acceptance criterion ${id}`);
  }
  if (prototype.startScreen && !screenIds.has(prototype.startScreen)) throw missing("PROTOTYPE_INVALID", `start screen ${prototype.startScreen} does not exist`);
  if (prototype.kind === "ui" && prototype.screens.length === 0) throw missing("PROTOTYPE_INVALID", "a ui prototype needs at least one screen; for a backend-only task use kind api");
  if (prototype.kind === "api" && prototype.endpoints.length === 0) throw missing("PROTOTYPE_INVALID", "an api prototype needs at least one endpoint with request and response examples");
  for (const collection of prototype.mock) {
    const keys = new Set(collection.fields.map((f) => f.key));
    for (const row of collection.rows) for (const key of Object.keys(row)) if (!keys.has(key)) throw missing("PROTOTYPE_INVALID", `mock collection ${collection.id} has a row with unknown field ${key}`);
  }
  validatePrototypeBehaviour(prototype, reqIds, acIds);
}

/** The interactive parts must point at things that exist, otherwise the reviewer clicks a control that silently does nothing. */
function validatePrototypeBehaviour(prototype: Prototype, reqIds: Set<string>, acIds: Set<string>): void {
  const fieldsOf = new Map(prototype.mock.map((c) => [c.id, new Set(c.fields.map((f) => f.key))]));
  const screenElements = new Map(prototype.screens.map((s) => [s.id, new Map(s.elements.map((e) => [e.id, e]))]));
  for (const screen of prototype.screens) {
    for (const element of screen.elements) {
      const where = `${screen.id}#${element.id}`;
      const keys = element.collection ? fieldsOf.get(element.collection) : undefined;
      const needField = (field: string, what: string) => {
        if (!element.collection) throw missing("PROTOTYPE_INVALID", `${where} uses ${what} "${field}" but has no mock collection`);
        if (keys && !keys.has(field)) throw missing("PROTOTYPE_INVALID", `${where} ${what} "${field}" is not a field of mock collection ${element.collection}`);
      };
      if (element.kind === "filter" && !element.param) throw missing("PROTOTYPE_INVALID", `${where} is a filter and needs a param (the URL query parameter it sets)`);
      if (element.kind === "tabs" && element.tabs.length === 0) throw missing("PROTOTYPE_INVALID", `${where} is tabs and needs tabs`);
      if ((element.kind === "drawer" || element.kind === "modal") && element.param) {
        if (element.detailFields.length && !element.collection) throw missing("PROTOTYPE_INVALID", `${where} shows record fields but has no mock collection to look the record up in`);
        for (const d of element.detailFields) needField(d.field, "detail field");
      }
      for (const f of element.filters) needField(f.field, "filter field");
      for (const c of element.columns) if (keys && !keys.has(c)) throw missing("PROTOTYPE_INVALID", `${where} column "${c}" is not a field of mock collection ${element.collection}`);
      if (element.idField && element.collection) needField(element.idField, "id field");
      if (element.withinTable) {
        const t = screenElements.get(screen.id)?.get(element.withinTable);
        if (!t || !(t.kind === "table" || t.kind === "list") || t.collection !== element.collection)
          throw missing("PROTOTYPE_INVALID", `${where} withinTable ${element.withinTable} must be a table on the same screen over the same collection`);
      }
      for (const rel of element.related) {
        const rk = fieldsOf.get(rel.collection);
        if (!rk) throw missing("PROTOTYPE_INVALID", `${where} related collection ${rel.collection} does not exist`);
        for (const f of [rel.matchField, ...rel.columns]) if (!rk.has(f)) throw missing("PROTOTYPE_INVALID", `${where} related field "${f}" is not a field of ${rel.collection}`);
      }
      if (element.rowOpens) {
        const target = screenElements.get(screen.id)?.get(element.rowOpens);
        if (!target || !(target.kind === "drawer" || target.kind === "modal")) throw missing("PROTOTYPE_INVALID", `${where} rowOpens ${element.rowOpens}, which is not a drawer or modal on the same screen`);
        if (!target.param) throw missing("PROTOTYPE_INVALID", `${where} opens ${element.rowOpens}, which needs a param to know which record to show`);
      }
      if (element.showWhen && element.showWhen.equals === undefined && element.showWhen.notEquals === undefined && element.showWhen.present === undefined)
        throw missing("PROTOTYPE_INVALID", `${where} showWhen needs equals, notEquals or present`);
    }
  }
  // parameters a screen can actually set: filters, tabs, drawers/modals and search boxes
  const settable = new Map(prototype.screens.map((sc) => [sc.id, new Set(sc.elements.filter((e) => e.param && ["filter", "tabs", "drawer", "modal", "search"].includes(e.kind)).map((e) => e.param as string))]));
  for (const screen of prototype.screens) {
    const known = settable.get(screen.id)!;
    for (const element of screen.elements) {
      const where = `${screen.id}#${element.id}`;
      if ((element.kind === "drawer" || element.kind === "modal") && !element.param) throw missing("PROTOTYPE_INVALID", `${where} is a ${element.kind} and needs a param, otherwise nothing can open it`);
      if (element.onMissing === "close" && !element.collection) throw missing("PROTOTYPE_INVALID", `${where} onMissing "close" needs a collection to look the record up in`);
      if (element.kind === "tabs" && new Set(element.tabs.map((t) => t.id)).size !== element.tabs.length) throw missing("PROTOTYPE_INVALID", `${where} has duplicate tab ids`);
      if (element.showWhen && !known.has(element.showWhen.param)) throw missing("PROTOTYPE_INVALID", `${where} showWhen uses "${element.showWhen.param}", which no filter, tabs, drawer or search on ${screen.id} sets`);
      for (const f of element.filters) if (!known.has(f.param)) throw missing("PROTOTYPE_INVALID", `${where} filters by "${f.param}", which no filter or tabs on ${screen.id} sets`);
      for (const k of element.emptyAction?.clear ?? []) if (!known.has(k)) throw missing("PROTOTYPE_INVALID", `${where} emptyAction clears "${k}", which nothing on ${screen.id} sets`);
      if (element.kind === "field" && element.collection && element.field && !fieldsOf.get(element.collection)?.has(element.field)) throw missing("PROTOTYPE_INVALID", `${where} field "${element.field}" is not a field of ${element.collection}`);
      if (prototype.roles.length) for (const r of element.allowedRoles) if (!prototype.roles.includes(r)) throw missing("PROTOTYPE_INVALID", `${where} allows role "${r}", which the prototype does not define`);
    }
  }
  const datasetIds = new Set<string>();
  for (const dataset of prototype.datasets) {
    if (datasetIds.has(dataset.id)) throw missing("PROTOTYPE_INVALID", `duplicate dataset id ${dataset.id}`);
    datasetIds.add(dataset.id);
    for (const [collectionId, rows] of Object.entries(dataset.rows)) {
      const keys = fieldsOf.get(collectionId);
      if (!keys) throw missing("PROTOTYPE_INVALID", `dataset ${dataset.id} has rows for unknown mock collection ${collectionId}`);
      for (const row of rows) for (const key of Object.keys(row)) if (!keys.has(key)) throw missing("PROTOTYPE_INVALID", `dataset ${dataset.id}: a ${collectionId} row has unknown field ${key}`);
    }
  }
  const scenarioIds = new Set<string>();
  for (const scenario of prototype.scenarios) {
    if (scenarioIds.has(scenario.id)) throw missing("PROTOTYPE_INVALID", `duplicate scenario id ${scenario.id}`);
    scenarioIds.add(scenario.id);
    const screen = scenario.screen ?? prototype.startScreen ?? prototype.screens[0]?.id;
    if (scenario.screen && !screenElements.has(scenario.screen)) throw missing("PROTOTYPE_INVALID", `scenario ${scenario.id} uses unknown screen ${scenario.screen}`);
    if (scenario.dataset && !datasetIds.has(scenario.dataset)) throw missing("PROTOTYPE_INVALID", `scenario ${scenario.id} uses unknown dataset ${scenario.dataset}`);
    if (scenario.role && !prototype.roles.includes(scenario.role)) throw missing("PROTOTYPE_INVALID", `scenario ${scenario.id} uses unknown role ${scenario.role}`);
    const elements = screen ? screenElements.get(screen) : undefined;
    const known = (screen && settable.get(screen)) || new Set<string>();
    for (const r of scenario.expect?.rows ?? []) {
      const e = elements?.get(r.element);
      if (!e) throw missing("PROTOTYPE_INVALID", `scenario ${scenario.id} expects rows of unknown element ${r.element} on ${screen}`);
      if (e.kind !== "table" && e.kind !== "list") throw missing("PROTOTYPE_INVALID", `scenario ${scenario.id} expects rows of ${r.element}, which is not a table or list`);
    }
    for (const o of scenario.expect?.overlay ?? []) {
      const e = elements?.get(o.element);
      if (!e) throw missing("PROTOTYPE_INVALID", `scenario ${scenario.id} expects overlay of unknown element ${o.element} on ${screen}`);
      if (e.kind !== "drawer" && e.kind !== "modal") throw missing("PROTOTYPE_INVALID", `scenario ${scenario.id} expects an overlay state of ${o.element}, which is not a drawer or modal`);
    }
    for (const k of [...Object.keys(scenario.query), ...Object.keys(scenario.expect?.query ?? {}), ...(scenario.expect?.noQuery ?? [])])
      if (!known.has(k)) throw missing("PROTOTYPE_INVALID", `scenario ${scenario.id} uses query parameter "${k}", which nothing on ${screen} reads or sets`);
    for (const id of scenario.requirementIds) if (!reqIds.has(id)) throw missing("PROTOTYPE_INVALID", `scenario ${scenario.id} links unknown requirement ${id}`);
    for (const id of scenario.acIds) if (!acIds.has(id)) throw missing("PROTOTYPE_INVALID", `scenario ${scenario.id} links unknown acceptance criterion ${id}`);
  }
}

function withPrototype(state: WorkflowState, prototype: Prototype, summary: string, now: Now): WorkflowState {
  validatePrototype(state, prototype);
  const revision = (state.prototype?.revision ?? 0) + 1;
  const next: Prototype = {
    ...prototype,
    revision,
    status: "draft",
    history: [...(state.prototype?.history ?? []), { revision, at: iso(now), summary }].slice(-100),
  };
  const kept = state.prototype ? keepArtifact(state, "prototype", state.prototype.id, state.prototype.revision, state.prototype, now) : state;
  return touch({ ...kept, prototype: next }, now, `prototype r${revision}: ${summary}`);
}

function applyPrototypeOps(state: WorkflowState, operations: z.infer<typeof PrototypeOperation>[]): Prototype {
  const current = state.prototype;
  if (!current) throw missing("PROTOTYPE_MISSING", "there is no prototype yet: use set-prototype first");
  let p: Prototype = { ...current, screens: current.screens.map((s) => ({ ...s, elements: [...s.elements] })), mock: [...current.mock], endpoints: [...current.endpoints] };
  const screen = (id: string) => {
    const found = p.screens.find((s) => s.id === id);
    if (!found) throw missing("PROTOTYPE_INVALID", `unknown screen ${id}`);
    return found;
  };
  for (const op of operations) {
    switch (op.op) {
      case "set-meta":
        p = { ...p, ...(op.title !== undefined ? { title: op.title } : {}), ...(op.notes !== undefined ? { notes: op.notes } : {}), ...(op.startScreen !== undefined ? { startScreen: op.startScreen } : {}), ...(op.roles !== undefined ? { roles: op.roles } : {}), ...(op.limitations !== undefined ? { limitations: op.limitations } : {}) };
        break;
      case "set-dataset":
        p = { ...p, datasets: [...p.datasets.filter((d) => d.id !== op.dataset.id), op.dataset] };
        break;
      case "remove-dataset":
        p = { ...p, datasets: p.datasets.filter((d) => d.id !== op.id) };
        break;
      case "set-scenario":
        p = { ...p, scenarios: [...p.scenarios.filter((d) => d.id !== op.scenario.id), op.scenario] };
        break;
      case "remove-scenario":
        p = { ...p, scenarios: p.scenarios.filter((d) => d.id !== op.id) };
        break;
      case "add-screen":
        if (p.screens.some((s) => s.id === op.screen.id)) throw missing("PROTOTYPE_INVALID", `screen ${op.screen.id} already exists`);
        p = { ...p, screens: [...p.screens, op.screen] };
        break;
      case "update-screen":
        screen(op.id);
        p = { ...p, screens: p.screens.map((s) => (s.id === op.id ? { ...s, ...op.patch } : s)) };
        break;
      case "remove-screen":
        screen(op.id);
        p = { ...p, screens: p.screens.filter((s) => s.id !== op.id).map((s) => ({ ...s, elements: s.elements.map((e) => (e.navigatesTo === op.id ? { ...e, navigatesTo: undefined } : e)) })) };
        if (p.startScreen === op.id) p = { ...p, startScreen: undefined };
        break;
      case "add-element": {
        const target = screen(op.screenId);
        if (target.elements.some((e) => e.id === op.element.id)) throw missing("PROTOTYPE_INVALID", `element ${op.element.id} already exists on ${op.screenId}`);
        const elements = [...target.elements];
        elements.splice(op.index ?? elements.length, 0, op.element);
        p = { ...p, screens: p.screens.map((s) => (s.id === op.screenId ? { ...s, elements } : s)) };
        break;
      }
      case "update-element": {
        const target = screen(op.screenId);
        if (!target.elements.some((e) => e.id === op.id)) throw missing("PROTOTYPE_INVALID", `unknown element ${op.screenId}#${op.id}`);
        p = { ...p, screens: p.screens.map((s) => (s.id === op.screenId ? { ...s, elements: s.elements.map((e) => (e.id === op.id ? { ...e, ...op.patch } : e)) } : s)) };
        break;
      }
      case "remove-element": {
        const target = screen(op.screenId);
        if (!target.elements.some((e) => e.id === op.id)) throw missing("PROTOTYPE_INVALID", `unknown element ${op.screenId}#${op.id}`);
        p = { ...p, screens: p.screens.map((s) => (s.id === op.screenId ? { ...s, elements: s.elements.filter((e) => e.id !== op.id) } : s)) };
        break;
      }
      case "set-mock":
        p = { ...p, mock: [...p.mock.filter((c) => c.id !== op.collection.id), op.collection] };
        break;
      case "remove-mock":
        p = { ...p, mock: p.mock.filter((c) => c.id !== op.id) };
        break;
      case "set-tokens":
        p = { ...p, styles: op.styles };
        break;
      case "set-endpoint":
        p = { ...p, endpoints: [...p.endpoints.filter((e) => e.id !== op.endpoint.id), op.endpoint] };
        break;
      case "remove-endpoint":
        p = { ...p, endpoints: p.endpoints.filter((e) => e.id !== op.id) };
        break;
      case "link": {
        const target = screen(op.screenId);
        const el = target.elements.find((e) => e.id === op.elementId);
        if (!el) throw missing("PROTOTYPE_INVALID", `unknown element ${op.screenId}#${op.elementId}`);
        p = {
          ...p,
          screens: p.screens.map((s) =>
            s.id === op.screenId
              ? { ...s, elements: s.elements.map((e) => (e.id === op.elementId ? { ...e, requirementIds: op.requirementIds ?? e.requirementIds, acIds: op.acIds ?? e.acIds } : e)) }
              : s,
          ),
        };
        break;
      }
    }
  }
  return p;
}

// --- story plan ----------------------------------------------------------------------------------------------------

function validatePlan(state: WorkflowState, entries: StoryPlanEntry[]): void {
  const ids = new Set<string>();
  const reqIds = new Set(activeRequirements(state).map((r) => r.id as string));
  const acIds = new Set(activeRequirements(state).flatMap((r) => r.acceptanceCriteria.map((c) => c.id)));
  const repoIds = new Set(state.repositories.map((r) => r.id));
  for (const entry of entries) {
    if (ids.has(entry.id)) throw missing("PLAN_INVALID", `duplicate plan entry ${entry.id}`);
    ids.add(entry.id);
  }
  for (const entry of entries) {
    for (const id of entry.requirementIds) if (!reqIds.has(id)) throw missing("PLAN_INVALID", `${entry.id} covers unknown requirement ${id}`);
    for (const id of entry.acIds) if (!acIds.has(id)) throw missing("PLAN_INVALID", `${entry.id} covers unknown acceptance criterion ${id}`);
    for (const id of entry.repositoryIds) if (!repoIds.has(id)) throw missing("PLAN_INVALID", `${entry.id} names repository ${id}, which is not registered`);
    for (const id of entry.dependsOn) if (!ids.has(id)) throw missing("PLAN_INVALID", `${entry.id} depends on ${id}, which is not in the plan`);
    if (state.prototype) {
      for (const ref of entry.screenRefs) {
        const [screenId, elementId] = ref.split("#");
        const screen = state.prototype.screens.find((s) => s.id === screenId);
        const endpoint = state.prototype.endpoints.find((e) => e.id === ref);
        if (!screen && !endpoint) throw missing("PLAN_INVALID", `${entry.id} covers unknown prototype screen or endpoint ${ref}`);
        if (screen && elementId && !screen.elements.some((e) => e.id === elementId)) throw missing("PLAN_INVALID", `${entry.id} covers unknown prototype element ${ref}`);
      }
    }
  }
  // dependency cycles
  const visiting = new Set<string>();
  const done = new Set<string>();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const visit = (id: string, path: string[]) => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw missing("PLAN_INVALID", `dependency cycle: ${[...path, id].join(" -> ")}`);
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep, [...path, id]);
    visiting.delete(id);
    done.add(id);
  };
  for (const entry of entries) visit(entry.id, []);
}

function withPlan(state: WorkflowState, entries: StoryPlanEntry[], summary: string, now: Now): WorkflowState {
  validatePlan(state, entries);
  const revision = (state.storyPlan?.revision ?? 0) + 1;
  const plan: StoryPlan = {
    revision,
    status: "draft",
    entries,
    history: [...(state.storyPlan?.history ?? []), { revision, at: iso(now), summary }].slice(-100),
  };
  const kept = state.storyPlan ? keepArtifact(state, "story-plan", "plan", state.storyPlan.revision, state.storyPlan, now) : state;
  return touch({ ...kept, storyPlan: plan }, now, `story plan r${revision}: ${summary}`);
}

// --- story editing -------------------------------------------------------------------------------------------------

function storyOf(state: WorkflowState, id: string): UserStory {
  const story = state.stories.find((s) => s.id === id && s.status !== "superseded");
  if (!story) throw missing("STORY_NOT_FOUND", `story ${id} is not in this workflow`);
  return story;
}

const PATCH_ITEM_KEYS: Record<string, string> = { happyPath: "step", alternatives: "alt", negative: "neg", edgeCases: "edge", businessRules: "rule", expectedResults: "result" };

/** Marks for items whose text changed are dropped; marks for untouched items survive an edit. */
function resetChangedMarks(story: UserStory, patch: z.infer<typeof StoryPatch>, changedAc: Set<string>): UserStory["review"] {
  const review = { ...story.review };
  for (const [field, prefix] of Object.entries(PATCH_ITEM_KEYS)) {
    const next = (patch as Record<string, string[] | undefined>)[field];
    if (!next) continue;
    const previous = (story as unknown as Record<string, string[]>)[field];
    const keys = Object.keys(review).filter((k) => k.startsWith(`${prefix}:`));
    for (const key of keys) {
      const index = Number(key.slice(prefix.length + 1));
      if (previous[index] !== next[index]) delete review[key];
    }
  }
  for (const id of changedAc) delete review[`ac:${id}`];
  return review;
}

function editStory(state: WorkflowState, command: Extract<PlanningCommand, { action: "update-story" }>, now: Now): PlanningResult {
  const story = storyOf(state, command.id);
  const patch = command.patch;
  let acceptanceCriteria = story.acceptanceCriteria.map((c) => ({ ...c }));
  const changedAc = new Set<string>();
  for (const op of command.criteria) {
    if (op.op === "set") {
      const index = acceptanceCriteria.findIndex((c) => c.id === op.id);
      if (index < 0) throw missing("MISSING_ACCEPTANCE_CRITERION", `${op.id} is not a criterion of ${story.id}`);
      acceptanceCriteria[index] = { id: op.id, given: op.given, when: op.when, then: op.then };
      changedAc.add(op.id);
    } else if (op.op === "add") {
      const used = acceptanceCriteria.map((c) => Number(c.id.match(/-AC-(\d+)$/)?.[1] ?? 0));
      const id = op.id ?? `${story.id}-AC-${String(Math.max(0, ...used) + 1).padStart(2, "0")}`;
      if (acceptanceCriteria.some((c) => c.id === id)) throw missing("DUPLICATE_ACCEPTANCE_CRITERION", `${id} already exists in ${story.id}`);
      acceptanceCriteria.push({ id, given: op.given, when: op.when, then: op.then });
      changedAc.add(id);
    } else {
      if (!acceptanceCriteria.some((c) => c.id === op.id)) throw missing("MISSING_ACCEPTANCE_CRITERION", `${op.id} is not a criterion of ${story.id}`);
      acceptanceCriteria = acceptanceCriteria.filter((c) => c.id !== op.id);
      changedAc.add(op.id);
    }
  }
  if (acceptanceCriteria.length < 1) throw missing("STORY_NEEDS_CRITERIA", `${story.id} must keep at least one acceptance criterion; exclude the story instead`);
  const edited: UserStory = {
    ...story,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    acceptanceCriteria,
    revision: story.revision + 1,
    confirmedBehavior: false,
    status: story.status === "confirmed" ? "proposed" : story.status,
    stale: false,
    review: resetChangedMarks(story, patch, changedAc),
  };
  const parsed = UserStorySchema.parse(edited);
  let next = pushHistory(state, story, "edit", command.reason ?? "edited", now);
  next = { ...next, stories: next.stories.map((s) => (s === story ? parsed : s)) };
  next = invalidateStoryEvidence(next, parsed);
  next = touch(next, now, `story ${story.id} edited to r${parsed.revision}${command.reason ? `: ${command.reason}` : ""}; confirmation and Quality evidence for the old revision no longer count`);
  return { state: next, duplicate: false, result: { storyId: parsed.id, revision: parsed.revision, confirmedBehavior: false, reviewMarksKept: Object.keys(parsed.review).length } };
}

/** Quality evidence and verdicts for a story's old revision stop counting. */
function invalidateStoryEvidence(state: WorkflowState, story: UserStory): WorkflowState {
  return {
    ...state,
    verdicts: state.verdicts.map((v) => (v.requirementIds.some((id) => story.requirementIds.includes(id)) ? { ...v, stale: true, invalidatedBy: story.id } : v)),
    implementationUnits: state.implementationUnits,
  };
}

function setPlanStatusFor(state: WorkflowState, storyId: string, status: "detailed" | "planned" | "excluded", reason?: string): WorkflowState {
  if (!state.storyPlan) return state;
  return {
    ...state,
    storyPlan: {
      ...state.storyPlan,
      // excludedReason belongs to the excluded state only: it is cleared when the entry leaves it
      entries: state.storyPlan.entries.map((e) => {
        if (e.id !== storyId) return e;
        const { excludedReason: _drop, ...rest } = e;
        return { ...rest, status, ...(status === "excluded" && reason ? { excludedReason: reason } : {}) };
      }),
    },
  };
}

// --- repositories and impact -----------------------------------------------------------------------------------

function registerRepository(state: WorkflowState, command: Extract<PlanningCommand, { action: "register-repository" }>, now: Now): PlanningResult {
  const input = command.repository;
  const existing = state.repositories.find((r) => r.id === input.id);
  const repository = RepositorySchema.parse({
    ...(existing ?? {}),
    ...input,
    registeredAt: existing?.registeredAt ?? iso(now),
    status: existing?.status ?? "registered",
  });
  const unchanged = existing && JSON.stringify(sorted(existing)) === JSON.stringify(sorted(repository));
  if (unchanged) return { state, duplicate: true, result: { repositoryId: repository.id, registered: true } };
  const repositories = existing ? state.repositories.map((r) => (r.id === repository.id ? repository : r)) : [...state.repositories, repository];
  return { state: touch({ ...state, repositories }, now, `repository ${repository.id} registered (${repository.role || "no role"})`), duplicate: false, result: { repositoryId: repository.id, registered: true } };
}

function assertRepos(state: WorkflowState, ids: string[]) {
  for (const id of ids) if (!state.repositories.some((r) => r.id === id)) throw missing("REPOSITORY_NOT_REGISTERED", `repository ${id} is not registered; register it first`);
}

// --- phases and gates ------------------------------------------------------------------------------------------

export function phaseIndex(phase: Phase): number {
  return PHASES.indexOf(phase);
}

export type GateResult = { ok: boolean; missing: string[]; warnings: string[] };

/** What must be true before the work item may enter `to`. Gates are enforced in guided mode and reported in classic mode. */
/** Services that can never be ordered because they depend on each other. */
function implementationOrderOf(state: WorkflowState): string[] {
  const ids = state.services.map((s) => s.id);
  const done = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const s of state.services) {
      if (!done.has(s.id) && s.dependsOn.filter((d) => ids.includes(d)).every((d) => done.has(d))) {
        done.add(s.id);
        progressed = true;
      }
    }
  }
  return ids.filter((id) => !done.has(id));
}

export function phaseGates(state: WorkflowState, to: Phase): GateResult {
  const missingItems: string[] = [];
  const warnings: string[] = [];
  const reqs = inScope(state);
  const need = (condition: boolean, text: string) => {
    if (!condition) missingItems.push(text);
  };
  const kind = state.workItem.kind;
  const STALE_LABEL: Record<string, string> = { requirements_review: "the requirements", prototype: "the prototype", story_plan: "the story plan", stories_review: "the stories" };
  // an acceptance the user gave stands only while the content is the same: a later change must be accepted again before work moves on
  const upstreamFresh = (phases: AcceptablePhase[]) => {
    for (const phase of phases) need(acceptanceStatus(state, phase) !== "stale", `${STALE_LABEL[phase]} changed after you accepted ${phase === "story_plan" ? "it" : "them"}: review and accept again`);
  };
  // Reviewing a story and confirming its behaviour are two decisions: Quality compares the code with the CONFIRMED behaviour. A story
  // edited after its confirmation is unconfirmed again, so this is checked at every later gate, not only the first.
  const confirmedStories = () => {
    const unconfirmed = activeStories(state).filter((st) => !st.confirmedBehavior);
    need(unconfirmed.length === 0, `every story confirmed by the user (confirm-story): ${unconfirmed.map((st) => st.id).join(", ")} still ${unconfirmed.length === 1 ? "needs" : "need"} it`);
  };
  switch (to) {
    case "requirements_review":
      need(reqs.length > 0, "at least one in-scope requirement");
      need(reqs.every((r) => r.acceptanceCriteria.length > 0), "every in-scope requirement needs acceptance criteria");
      break;
    case "prototype":
      need(acceptanceStatus(state, "requirements_review") === "accepted", "requirements accepted by the user (every criterion) and unchanged since");
      // a criterion the user rejected or reopened after accepting keeps the gate shut (marks are not content, so the fingerprint does not show it)
      need(reviewProgress(state).complete, `every criterion accepted (${reviewProgress(state).rejected} rejected, ${reviewProgress(state).pending} pending)`);
      if (kind !== "feature") need(state.impact !== undefined, `${kind} work needs the existing behaviour and impact recorded first (record-impact)`);
      break;
    case "story_plan":
      need(acceptanceStatus(state, "requirements_review") === "accepted", "requirements accepted and unchanged since");
      need(reviewProgress(state).complete, "every criterion accepted (one was rejected or reopened since)");
      need(acceptanceStatus(state, "prototype") === "accepted" || state.waivers.some((w) => w.kind === "prototype"), "prototype accepted (or an explicit waiver with a reason)");
      break;
    case "stories_review": {
      need(acceptanceStatus(state, "story_plan") === "accepted", "story plan agreed and unchanged since");
      const plan = state.storyPlan?.entries.filter((e) => e.status !== "excluded") ?? [];
      const detailed = plan.filter((e) => activeStories(state).some((s) => s.id === e.id));
      need(plan.length > 0 && detailed.length === plan.length, `every planned story needs detailed content (${plan.length - detailed.length} still planned)`);
      break;
    }
    case "architecture": {
      need(acceptanceStatus(state, "stories_review") === "accepted", "stories reviewed and accepted, unchanged since");
      upstreamFresh(["requirements_review", "prototype", "story_plan"]);
      confirmedStories();
      const coverage = analyzeStoryCoverage(state);
      need(coverage.ok, `coverage gaps: ${coverage.gaps.map((g) => g.reason).concat(coverage.requirementsWithoutStories.map((id) => `${id} has no story`)).join("; ")}`);
      break;
    }
    case "development":
      upstreamFresh(["requirements_review", "prototype", "story_plan", "stories_review"]);
      confirmedStories();
      need(state.services.length > 0, "at least one service (set-service)");
      for (const service of state.services) {
        const repo = service.repositoryId ? state.repositories.find((r) => r.id === service.repositoryId) : undefined;
        need(Boolean(service.repositoryId && repo) || Boolean(service.localPath || service.remoteUrl), `service ${service.id} needs a registered repository or a path`);
        if (repo && repo.status !== "inspected") warnings.push(`repository ${repo.id} has not been inspected`);
      }
      for (const service of state.services) for (const dep of service.dependsOn) if (!state.services.some((s) => s.id === dep)) missingItems.push(`service ${service.id} depends on unknown ${dep}`);
      for (const contract of state.contracts) need(contract.status === "agreed", `contract ${contract.id} (${contract.name}) is not agreed by the user: implementation across services waits for it`);
      const cyc = implementationOrderOf(state);
      need(cyc.length === 0, `services depend on each other in a cycle: ${cyc.join(", ")}`);
      for (const repo of state.repositories) {
        const assigned = activeStories(state).some((s) => s.repositoryIds.includes(repo.id)) || activeRequirements(state).some((r) => r.repositoryIds.includes(repo.id));
        need(!assigned || state.services.some((s) => s.repositoryId === repo.id), `repository ${repo.id} has stories or requirements assigned but no service (set-service with repositoryId): nothing would be implemented there`);
      }
      break;
    case "quality": {
      upstreamFresh(["requirements_review", "prototype", "story_plan", "stories_review"]);
      confirmedStories();
      for (const contract of state.contracts) need(contract.status === "agreed", `contract ${contract.id} (${contract.name}) is not agreed by the user (it was changed after implementation started?)`);
      for (const service of state.services) need(state.implementationUnits.some((u) => u.serviceId === service.id && !u.stale), `service ${service.id} has no current implementation record`);
      break;
    }
    case "delivery":
      for (const contract of state.contracts) need(contract.status === "agreed", `contract ${contract.id} (${contract.name}) is not agreed by the user`);
      need(state.verdicts.some((v) => v.scope === "feature" && v.verdict !== "FAIL" && !v.stale), "a current feature verdict that is not FAIL");
      // a recorded verdict is a snapshot: delivery is judged on what the evidence says NOW (a criterion revised or a result that was only attested since changes it)
      const evidence = evaluateEvidence(state);
      need(evidence.totals.attested === 0, `every passing criterion has an independently executed result (${evidence.totals.attested} rest on an agent's own record or on a record from before provenance existed: run verify-stories)`);
      need(evidence.verdict !== "FAIL", `the evidence for the current criteria and stories is complete and passing${evidence.gaps.length ? `: ${evidence.gaps.slice(0, 4).join("; ")}${evidence.gaps.length > 4 ? "; ..." : ""}` : ""}`);
      // A feature verdict is only as good as the services under it: each one needs its own implementation and a passing verdict.
      for (const service of state.services) {
        need(state.implementationUnits.some((u) => u.serviceId === service.id && !u.stale), `service ${service.id} has no current implementation record`);
        need(service.status === "approved" || service.status === "completed" || state.verdicts.some((v) => v.scope === "service" && v.scopeId === service.id && v.verdict !== "FAIL" && !v.stale), `service ${service.id} has no current non-FAIL verdict`);
      }
      break;
    default:
      break;
  }
  return { ok: missingItems.length === 0, missing: missingItems, warnings };
}

function advancePhase(state: WorkflowState, command: Extract<PlanningCommand, { action: "advance-phase" }>, now: Now): PlanningResult {
  const from = state.phase;
  if (phaseIndex(command.to) <= phaseIndex(from)) throw missing("PHASE_NOT_FORWARD", `${command.to} is not after ${from}; use return-to-phase to go back`);
  // The steps in between must hold too: a gate is not skipped by jumping over it.
  const failures: Array<{ phase: Phase; missing: string[] }> = [];
  const warnings: string[] = [];
  for (let i = phaseIndex(from) + 1; i <= phaseIndex(command.to); i += 1) {
    const gate = phaseGates(state, PHASES[i]);
    warnings.push(...gate.warnings);
    if (!gate.ok) failures.push({ phase: PHASES[i], missing: gate.missing });
  }
  if (failures.length > 0 && state.mode === "guided") {
    throw missing("PHASE_GATE", `cannot enter ${command.to}: ${failures.map((f) => `${f.phase} needs ${f.missing.join("; ")}`).join(" | ")}`, { failures });
  }
  const entry = { at: iso(now), kind: "advance" as const, from, to: command.to, reason: command.reason ?? "", invalidated: [] };
  let next = touch({ ...state, phase: command.to, phaseHistory: [...state.phaseHistory, entry].slice(-200) }, now, `phase ${from} -> ${command.to}`);
  // The session log is what a new chat reads first: moving between stages is always worth a line in it.
  next = { ...next, sessionLog: [...next.sessionLog, { at: iso(now), summary: `moved from ${from} to ${command.to}${command.reason ? `: ${command.reason}` : ""}`, nextAction: nextStep(next).summary }].slice(-200) };
  return { state: next, duplicate: false, result: { phase: command.to, gatesMissing: failures, warnings: [...new Set(warnings)], enforced: state.mode === "guided" } };
}

function returnToPhase(state: WorkflowState, command: Extract<PlanningCommand, { action: "return-to-phase" }>, now: Now): PlanningResult {
  const from = state.phase;
  if (phaseIndex(command.to) >= phaseIndex(from)) throw missing("PHASE_NOT_BACKWARD", `${command.to} is not before ${from}`);
  const invalidated = ACCEPTABLE_PHASES.filter((p) => phaseIndex(p) > phaseIndex(command.to) && state.phaseAcceptance[p] !== undefined);
  const phaseAcceptance = { ...state.phaseAcceptance };
  for (const phase of invalidated) delete phaseAcceptance[phase];
  const entry = { at: iso(now), kind: "return" as const, from, to: command.to, reason: command.reason, invalidated: [...invalidated] };
  const note = { at: iso(now), summary: `returned to ${command.to}: ${command.reason}`, nextAction: `redo ${command.to}; later acceptances were invalidated: ${invalidated.join(", ") || "none"}` };
  const next = touch(
    { ...state, phase: command.to, phaseAcceptance, phaseHistory: [...state.phaseHistory, entry].slice(-200), sessionLog: [...state.sessionLog, note].slice(-200) },
    now,
    `returned from ${from} to ${command.to}: ${command.reason}`,
  );
  return { state: next, duplicate: false, result: { phase: command.to, invalidated } };
}

// --- next step -----------------------------------------------------------------------------------------------------

export type NextStep = {
  phase: Phase;
  role: "ba" | "architect" | "developer" | "quality";
  action: string;
  summary: string;
  tools: string[];
  skills: string[];
  /** The user has to decide or review something here. */
  userDecision: boolean;
  blockers: string[];
};

/** Deterministic: the same state always gives the same next step. */
export function nextStep(state: WorkflowState): NextStep {
  const phase = state.phase;
  const progress = reviewProgress(state);
  const open = state.openQuestions;
  const base = { phase, blockers: [...state.blockers] };
  switch (phase) {
    case "request":
    case "discovery":
      return {
        ...base,
        role: "ba",
        action: open.length > 0 ? "answer-open-questions" : state.requirements.length === 0 ? "write-requirements" : "advance-to-review",
        summary: open.length > 0 ? `Answer ${open.length} open question(s), then record the requirements.` : state.requirements.length === 0 ? "Gather the input, then record requirements with acceptance criteria." : "Requirements exist: open the HTML review.",
        tools: ["praxis_workflow_preview", "praxis_workflow_apply"],
        skills: ["praxis-ba:local-workflow"],
        userDecision: open.length > 0,
      };
    case "requirements":
      return { ...base, role: "ba", action: "finish-requirements", summary: "Complete requirements and acceptance criteria, then open the review.", tools: ["praxis_workflow_apply"], skills: ["praxis-ba:local-workflow"], userDecision: false };
    case "requirements_review":
      return {
        ...base,
        role: "ba",
        action: progress.complete && acceptanceStatus(state, "requirements_review") === "accepted" ? "advance-to-prototype" : "review-requirements",
        summary: progress.complete && acceptanceStatus(state, "requirements_review") === "accepted" ? "All criteria are accepted: move to the prototype." : progress.complete ? "Every criterion is marked, but the review is not recorded as accepted: ask the user to open the review again and accept." : `Review requirements in HTML: ${progress.accepted}/${progress.criteria} criteria accepted, ${progress.pending} pending, ${progress.rejected} rejected.`,
        tools: ["praxis_review_render", "praxis_review_apply"],
        skills: ["praxis-ba:requirements-review"],
        userDecision: !(progress.complete && acceptanceStatus(state, "requirements_review") === "accepted"),
      };
    case "prototype":
      return {
        ...base,
        role: "ba",
        action: !state.prototype ? "build-prototype" : acceptanceStatus(state, "prototype") === "accepted" ? "advance-to-story-plan" : "review-prototype",
        summary: !state.prototype ? "Inspect the frontend (or the API) and build the prototype on mock data." : acceptanceStatus(state, "prototype") === "accepted" ? "Prototype accepted: plan the stories." : `Review prototype r${state.prototype.revision}; ${state.prototype.feedback.filter((f) => !f.resolved).length} open feedback item(s).`,
        tools: ["praxis_frontend_discover", "praxis_workflow_apply", "praxis_review_render"],
        skills: ["praxis-ba:prototype"],
        userDecision: Boolean(state.prototype) && acceptanceStatus(state, "prototype") !== "accepted",
      };
    case "story_plan":
      return {
        ...base,
        role: "ba",
        action: !state.storyPlan ? "write-story-plan" : acceptanceStatus(state, "story_plan") !== "accepted" ? "review-story-plan" : state.storyPlan.entries.every((e) => e.status !== "planned") ? "advance-to-stories-review" : "detail-stories",
        summary: !state.storyPlan ? "Write a short story plan: one line per story, what it covers, which REQ and AC." : acceptanceStatus(state, "story_plan") !== "accepted" ? "Review and agree the story plan." : state.storyPlan.entries.every((e) => e.status !== "planned") ? "Every planned story is detailed: move on to the stories review." : `Plan agreed: write the detailed stories (${state.storyPlan.entries.filter((e) => e.status === "planned").length} left).`,
        tools: ["praxis_workflow_apply", "praxis_review_render"],
        skills: ["praxis-ba:story-plan"],
        userDecision: Boolean(state.storyPlan) && acceptanceStatus(state, "story_plan") !== "accepted",
      };
    case "stories_review": {
      const coverage = analyzeStoryCoverage(state);
      return {
        ...base,
        role: "ba",
        action: coverage.ok ? (acceptanceStatus(state, "stories_review") === "accepted" ? "advance-to-architecture" : "review-stories") : "fix-coverage",
        summary: coverage.ok ? "Review the stories in HTML, item by item." : `Coverage gaps: ${[...coverage.gaps.map((g) => g.reason), ...coverage.requirementsWithoutStories.map((id) => `${id} has no story`)].join("; ")}`,
        tools: ["praxis_review_render", "praxis_workflow_inspect"],
        skills: ["praxis-ba:stories-review"],
        userDecision: coverage.ok,
        blockers: [...state.blockers, ...(coverage.ok ? [] : ["coverage gaps"])],
      };
    }
    case "architecture": {
      const proposed = state.contracts.filter((c) => c.status !== "agreed");
      return { ...base, role: "architect", action: proposed.length ? "agree-contracts" : "design-services", summary: proposed.length ? `Ask the user to agree ${proposed.length} contract(s) (${proposed.map((c) => c.id).join(", ")}) in the contracts review; implementation waits for it.` : "Map requirements to services and repositories, propose cross-service contracts and implementation order.", tools: proposed.length ? ["praxis_review_render", "praxis_review_apply"] : ["praxis_workflow_apply", "praxis_repository_inspect"], skills: ["praxis-architect:local-workflow"], userDecision: true };
    }
    case "development": {
      const pending = state.services.filter((s) => !state.implementationUnits.some((u) => u.serviceId === s.id && !u.stale));
      return { ...base, role: "developer", action: pending.length ? "implement-service" : "advance-to-quality", summary: pending.length ? `Implement in order; pending: ${pending.map((s) => s.id).join(", ")}.` : "All services have implementation records: hand over to Quality.", tools: ["praxis_repository_brief", "praxis_workflow_apply"], skills: ["praxis-developer:local-workflow"], userDecision: false };
    }
    case "quality":
      return { ...base, role: "quality", action: "verify", summary: "Verify each service and then the whole feature; return findings to Development if needed.", tools: ["praxis_workflow_apply", "praxis_quality_review"], skills: ["praxis-quality:local-workflow"], userDecision: false };
    case "delivery":
      return { ...base, role: "developer", action: "deliver", summary: "Prepare the Git delivery (commit, push, merge request) through the protected tools.", tools: ["praxis_developer_git_preview"], skills: ["praxis-developer:present-plan"], userDecision: true };
  }
}

// --- the dispatcher --------------------------------------------------------------------------------------------

/**
 * Where a decision came from. The user's own click in a review page served by the Runtime ("html-review"), or a batch of
 * decisions the user approved in the client's dialog ("approved"). Nothing an agent puts in a command can stand in for
 * either: the command's own via field is replaced by what the Runtime verified.
 */
export type ReviewChannel = { via: "html-review" } | { via: "approved"; approval: UserApproval; batch: ReadonlyArray<Record<string, unknown>> };

export const REVIEW_DECISION_ACTION = "review-decisions";

function withoutVia(command: Record<string, unknown>): Record<string, unknown> {
  // "sequence" is added by the workflow store after the user approved an open command
  const { via: _via, sequence: _sequence, ...rest } = command;
  return rest;
}

/** What the user approves when the decisions come through the client's dialog: the exact commands, canonical. */
export function reviewBatchSubject(batch: ReadonlyArray<Record<string, unknown>>): string {
  return canonicalText(batch.map(withoutVia));
}

/** What the user is asked when the decisions of a review come through the client's dialog. */
export function reviewApprovalRequest(batch: ReadonlyArray<Record<string, unknown>>, summary: string): ApprovalRequest {
  return {
    action: REVIEW_DECISION_ACTION,
    kind: "requirement_acceptance",
    summary,
    description: batch.map((c) => `- ${String(c.action)}${c.decisions ? ` (${(c.decisions as unknown[]).length} requirement(s))` : ""}`).join("\n"),
    subject: reviewBatchSubject(batch),
    risks: ["These decisions record that you accepted or rejected the reviewed items; later stages rely on them."],
  };
}

/** Commands that record what the USER decided. An agent can propose and edit; it cannot record that the user accepted. */
export function isUserDecision(command: { action: string } & Record<string, unknown>): boolean {
  switch (command.action) {
    case "accept-requirements":
    case "accept-prototype":
    case "agree-story-plan":
    case "accept-stories":
    case "review-stories":
    case "waive-coverage":
      return true;
    // An agreed contract lets implementation start: only the user can agree it. Proposing one is the agent's.
    case "set-contract":
      return (command.contract as { status?: string }).status === "agreed";
    // Leaving guided mode switches the gates off: the user's call. Entering it only adds protection.
    case "set-mode":
      return command.mode === "classic";
    case "review-requirements":
      return (command.decisions as Array<{ acceptance?: Array<{ status?: unknown }> }>).some((d) => (d.acceptance ?? []).some((a) => a.status !== undefined));
    case "update-story-plan":
      return (command.operations as Array<{ op: string }>).some((o) => o.op === "review");
    default:
      return false;
  }
}

function verifiedVia(command: PlanningCommand, channel: ReviewChannel | undefined): "html-review" | "approved" | null {
  if (!channel) return null;
  if (channel.via === "html-review") return "html-review";
  verifyUserApproval(channel.approval, { action: REVIEW_DECISION_ACTION, subject: reviewBatchSubject(channel.batch) });
  const mine = canonicalText(withoutVia(command as unknown as Record<string, unknown>));
  if (!channel.batch.some((item) => canonicalText(withoutVia(item)) === mine)) {
    throw new WorkflowError("USER_DECISION_REQUIRED", "this decision is not part of what the user approved");
  }
  return "approved";
}

/** Whether the user's own channel stands behind this command (page click, or a batch they approved). null when there is none. */
export function verifyUserChannel(command: Record<string, unknown>, channel: ReviewChannel | undefined): "html-review" | "approved" | null {
  return verifiedVia(command as unknown as PlanningCommand, channel);
}

/**
 * What changes, and what does not, when a work item changes mode. Nothing is ever deleted or rewritten: only the gates change.
 * classic -> guided: existing artifacts stay valid; from now on new stories need an agreed plan line and a stage is entered only
 * when its conditions hold. guided -> classic: the stage is still recorded, nothing is enforced.
 */
export function modeSwitchReport(state: WorkflowState, to: "classic" | "guided") {
  const planIds = new Set((state.storyPlan?.entries ?? []).map((e) => e.id));
  const stagesWithoutAcceptance = ACCEPTABLE_PHASES.filter((phase) => {
    const exists = phase === "requirements_review" ? activeRequirements(state).length > 0 : phase === "prototype" ? Boolean(state.prototype) : phase === "story_plan" ? Boolean(state.storyPlan) : activeStories(state).length > 0;
    return exists && acceptanceStatus(state, phase) !== "accepted";
  });
  return {
    from: state.mode,
    to,
    phase: state.phase,
    dataKept: { requirements: activeRequirements(state).length, stories: activeStories(state).length, services: state.services.length, implementationRecords: state.implementationUnits.length, verdicts: state.verdicts.length },
    ...(to === "guided"
      ? {
          storiesWithoutPlanLine: activeStories(state).filter((s) => !planIds.has(s.id)).map((s) => s.id),
          stagesWithoutUserAcceptance: stagesWithoutAcceptance,
          gatesAtCurrentPhase: phaseGates(state, state.phase),
          notes: [
            "Nothing is deleted or rewritten; existing requirements, stories, services and records stay valid.",
            "New stories need an agreed story plan and a plan line. Moving to the next stage needs its conditions: stages listed above have no acceptance by the user yet and will ask for it when you move on.",
          ],
        }
      : { notes: ["The stage is still recorded; gates, plan-before-stories and coverage checks are no longer enforced. Nothing is deleted."] }),
  };
}

export function applyPlanningCommand(state: WorkflowState, rawCommand: PlanningCommand, options: { now?: Date; channel?: ReviewChannel; /** Set by the contract once the user's approval of a rewording was verified. */ approvedRewording?: boolean } = {}): PlanningResult {
  const now = options.now;
  const verified = verifiedVia(rawCommand, options.channel);
  if (isUserDecision(rawCommand as never) && !verified) {
    throw new WorkflowError(
      "USER_DECISION_REQUIRED",
      `${rawCommand.action} records that the user accepted or rejected something. It cannot come from the agent: the user decides in the HTML review (praxis_review_render), or approves the decisions in the client's dialog (praxis_review_apply).`,
    );
  }
  const command = ("via" in rawCommand ? { ...rawCommand, via: verified ?? "chat" } : rawCommand) as PlanningCommand;
  switch (command.action) {
    case "review-requirements":
      return applyRequirementDecisions(state, command, now);
    case "revise-acceptance": {
      if (!options.approvedRewording) throw new WorkflowError("APPROVAL_REQUIRED", "revise-acceptance runs only through applyWorkflowCommand, after the user's approval was verified");
      const seen = new Set<string>();
      const byRequirement = new Map<string, Array<{ id: string; statement: string }>>();
      for (const edit of command.edits) {
        if (seen.has(edit.id)) throw new WorkflowError("DUPLICATE_ACCEPTANCE_EDIT", `${edit.id} is edited twice in one command; send one edit per criterion`);
        seen.add(edit.id);
        const owner = activeRequirements(state).find((r) => r.acceptanceCriteria.some((c) => c.id === edit.id));
        if (!owner) throw missing("MISSING_ACCEPTANCE_CRITERION", `${edit.id} is not an acceptance criterion of any active requirement`);
        const criterion = owner.acceptanceCriteria.find((c) => c.id === edit.id)!;
        if (edit.expectedRevision !== undefined && edit.expectedRevision !== criterion.revision) {
          throw new WorkflowError("ACCEPTANCE_REVISION_CONFLICT", `${edit.id} is at revision ${criterion.revision}, not ${edit.expectedRevision}: it changed after you read it. Read it again (praxis_workflow_inspect, view requirements) and propose the edit again.`);
        }
        byRequirement.set(owner.id, [...(byRequirement.get(owner.id) ?? []), { id: edit.id, statement: edit.statement }]);
      }
      const decisions = [...byRequirement].map(([requirementId, acceptance]) => ({ requirementId, acceptance, addAcceptance: [], removeAcceptance: [] })) as Array<z.input<typeof RequirementDecision>>;
      return applyRequirementDecisions(state, { action: "review-requirements", via: "chat", decisions: decisions.map((d) => RequirementDecision.parse(d)) }, now, true);
    }
    case "accept-requirements": {
      const ids = command.requirementIds ?? inScope(state).map((r) => r.id as string);
      for (const id of ids) requirementOf(state, id);
      let next = state;
      next = {
        ...next,
        requirements: next.requirements.map((r) =>
          ids.includes(r.id) && r.scope === "in" && r.status !== "superseded"
            ? { ...r, status: "approved" as const, acceptanceCriteria: r.acceptanceCriteria.map((c) => (c.review.status === "pending" ? { ...c, review: { ...c.review, status: "accepted" as const, at: iso(now), via: command.via } } : c)) }
            : r,
        ),
      };
      const progress = reviewProgress(next);
      if (progress.complete) next = recordAcceptance(next, "requirements_review", command.via, now);
      next = touch(next, now, `requirements accepted (${command.via}); ${progress.accepted}/${progress.criteria} criteria`);
      return { state: next, duplicate: false, result: { reviewProgress: progress, accepted: progress.complete } };
    }
    case "set-requirement-scope": {
      let next = state;
      for (const id of command.requirementIds) requirementOf(next, id);
      next = {
        ...next,
        requirements: next.requirements.map((r) =>
          command.requirementIds.includes(r.id) && r.status !== "superseded" ? { ...r, scope: command.scope, ...(command.note !== undefined ? { scopeNote: command.note } : {}), revision: r.scope === command.scope ? r.revision : r.revision + 1 } : r,
        ),
      };
      const same = command.requirementIds.every((id) => {
        const before = state.requirements.find((r) => r.id === id)!;
        const after = next.requirements.find((r) => r.id === id)!;
        return before.status === "superseded" || (before.scope === after.scope && before.scopeNote === after.scopeNote);
      });
      if (same) return { state, duplicate: true, result: { scope: command.scope, noChange: true, excludedStories: [], restoredStories: [], reviewProgress: reviewProgress(state) } };
      const cascade = cascadeScope(next, now);
      next = touch(cascade.state, now, `scope ${command.scope}: ${command.requirementIds.join(", ")}${command.note ? ` (${command.note})` : ""}`);
      return { state: next, duplicate: false, result: { scope: command.scope, excludedStories: cascade.excluded, restoredStories: cascade.restored, reviewProgress: reviewProgress(next) } };
    }
    case "set-prototype": {
      const { prototype } = command;
      const parsed = PrototypeSchema.omit({ revision: true, status: true, history: true, feedback: true }).parse({ id: "PROTO-1", styles: { colors: {}, fonts: {}, sources: [] }, ...prototype });
      const next = withPrototype(state, { ...parsed, feedback: state.prototype?.feedback ?? [], history: [], revision: 1, status: "draft" } as Prototype, command.summary ?? "prototype set", now);
      return { state: next, duplicate: false, result: { revision: next.prototype!.revision, screens: next.prototype!.screens.length } };
    }
    case "update-prototype": {
      const p = applyPrototypeOps(state, command.operations);
      const next = withPrototype(state, p, command.summary ?? `${command.operations.length} change(s)`, now);
      return { state: next, duplicate: false, result: { revision: next.prototype!.revision } };
    }
    case "prototype-feedback": {
      if (!state.prototype) throw missing("PROTOTYPE_MISSING", "there is no prototype to comment on");
      const start = state.prototype.feedback.length;
      const added = command.items.map((item, index) => PrototypeFeedbackSchema.parse({ id: `FB-${String(start + index + 1).padStart(3, "0")}`, target: item.target, comment: item.comment, at: iso(now), resolved: false }));
      const feedback = [...state.prototype.feedback, ...added].map((f) => (command.resolve.includes(f.id) ? { ...f, resolved: true } : f));
      for (const id of command.resolve) if (!state.prototype.feedback.some((f) => f.id === id)) throw missing("MISSING_FEEDBACK", `feedback ${id} not found`);
      return { state: touch({ ...state, prototype: { ...state.prototype, feedback } }, now, `prototype feedback: ${added.length} added, ${command.resolve.length} resolved`), duplicate: false, result: { added: added.map((f) => f.id), open: feedback.filter((f) => !f.resolved).length } };
    }
    case "accept-prototype": {
      if (!state.prototype) throw missing("PROTOTYPE_MISSING", "there is no prototype to accept");
      let next = recordAcceptance(state, "prototype", command.via, now);
      next = { ...next, prototype: { ...state.prototype, status: "accepted" } };
      return { state: touch(next, now, `prototype r${state.prototype.revision} accepted`), duplicate: false, result: { accepted: true, revision: state.prototype.revision, openFeedback: state.prototype.feedback.filter((f) => !f.resolved).length } };
    }
    case "set-story-plan": {
      const entries = command.entries.map((e) => StoryPlanEntrySchema.parse({ ...e, status: "planned", review: { status: "pending" } }));
      const next = withPlan(state, entries, `${entries.length} stories planned`, now);
      return { state: next, duplicate: false, result: { revision: next.storyPlan!.revision, entries: entries.length } };
    }
    case "update-story-plan": {
      if (!state.storyPlan) throw missing("PLAN_MISSING", "there is no story plan yet: use set-story-plan");
      let entries = state.storyPlan.entries.map((e) => ({ ...e }));
      const marksOnly = command.operations.every((op) => op.op === "review");
      for (const op of command.operations) {
        const find = (id: string) => {
          const index = entries.findIndex((e) => e.id === id);
          if (index < 0) throw missing("PLAN_ENTRY_NOT_FOUND", `plan entry ${id} not found`);
          return index;
        };
        if (op.op === "add") {
          if (entries.some((e) => e.id === op.entry.id)) throw missing("PLAN_INVALID", `plan entry ${op.entry.id} already exists`);
          entries.push(StoryPlanEntrySchema.parse({ ...op.entry, status: "planned", review: { status: "pending" } }));
        } else if (op.op === "update") {
          const i = find(op.id);
          entries[i] = StoryPlanEntrySchema.parse({ ...entries[i], ...Object.fromEntries(Object.entries(op.patch).filter(([, v]) => v !== undefined)), review: { status: "pending" } });
        } else if (op.op === "exclude") {
          const i = find(op.id);
          entries[i] = { ...entries[i], status: "excluded", excludedReason: op.reason };
        } else if (op.op === "restore") {
          const i = find(op.id);
          const { excludedReason: _e, ...rest } = entries[i];
          entries[i] = { ...rest, status: state.stories.some((s) => s.id === op.id && s.status !== "superseded" && s.status !== "excluded") ? "detailed" : "planned" };
        } else {
          const i = find(op.id);
          entries[i] = { ...entries[i], review: { status: op.status, ...(op.comment !== undefined ? { comment: op.comment } : {}), at: iso(now), via: command.via } };
        }
      }
      validatePlan(state, entries);
      let next: WorkflowState;
      if (marksOnly) next = touch({ ...state, storyPlan: { ...state.storyPlan, entries } }, now, "story plan reviewed");
      else next = withPlan(state, entries, `${command.operations.length} change(s)`, now);
      // excluding or restoring a plan entry follows its detailed story
      for (const op of command.operations) {
        if (op.op === "exclude" && next.stories.some((s) => s.id === op.id && s.status !== "superseded" && s.status !== "excluded")) {
          const story = storyOf(next, op.id);
          next = pushHistory(next, story, "exclude", op.reason, now);
          next = { ...next, stories: next.stories.map((s) => (s === story ? { ...s, status: "excluded" as const, excludedReason: op.reason, confirmedBehavior: false, revision: s.revision + 1 } : s)) };
        }
        if (op.op === "restore") {
          const story = next.stories.find((s) => s.id === op.id && s.status === "excluded");
          if (story) {
            next = pushHistory(next, story, "restore", "restored with the plan entry", now);
            const { excludedReason: _e, ...rest } = story;
            next = { ...next, stories: next.stories.map((s) => (s === story ? { ...rest, status: "proposed" as const, confirmedBehavior: false, revision: story.revision + 1 } : s)) };
          }
        }
      }
      return { state: next, duplicate: false, result: { revision: next.storyPlan!.revision, status: next.storyPlan!.status, entries: next.storyPlan!.entries.length } };
    }
    case "agree-story-plan": {
      if (!state.storyPlan) throw missing("PLAN_MISSING", "there is no story plan to agree");
      const live = state.storyPlan.entries.filter((e) => e.status !== "excluded");
      if (live.length === 0) throw missing("PLAN_EMPTY", "the story plan has no stories");
      const coverage = analyzeStoryCoverage(state);
      if (state.mode === "guided" && !coverage.ok) {
        throw missing("PLAN_COVERAGE_GAPS", `the plan does not cover what the requirements imply: ${[...coverage.gaps.map((g) => g.reason), ...coverage.requirementsWithoutStories.map((id) => `${id} has no story`)].join("; ")}. Add stories or waive a gap with a reason.`, { coverage });
      }
      const rejected = live.filter((e) => e.review.status === "rejected").map((e) => e.id);
      if (rejected.length > 0) throw missing("PLAN_HAS_REJECTED", `plan entries rejected by the reviewer: ${rejected.join(", ")}`);
      let next: WorkflowState = { ...state, storyPlan: { ...state.storyPlan, status: "agreed" } };
      next = recordAcceptance(next, "story_plan", command.via, now);
      return { state: touch(next, now, `story plan r${state.storyPlan.revision} agreed`), duplicate: false, result: { agreed: true, revision: state.storyPlan.revision, coverage } };
    }
    case "update-story":
      return editStory(state, command, now);
    case "exclude-story": {
      const story = storyOf(state, command.id);
      if (story.status === "excluded") return { state, duplicate: true, result: { storyId: story.id, excluded: true } };
      let next = pushHistory(state, story, "exclude", command.reason, now);
      next = { ...next, stories: next.stories.map((s) => (s === story ? { ...s, status: "excluded" as const, excludedReason: command.reason, confirmedBehavior: false, revision: s.revision + 1 } : s)) };
      next = setPlanStatusFor(next, story.id, "excluded", command.reason);
      next = touch(next, now, `story ${story.id} excluded: ${command.reason}`);
      return { state: next, duplicate: false, result: { storyId: story.id, excluded: true, coverage: analyzeStoryCoverage(next) } };
    }
    case "restore-story": {
      const story = state.stories.find((s) => s.id === command.id && s.status === "excluded");
      if (!story) throw missing("STORY_NOT_EXCLUDED", `story ${command.id} is not excluded`);
      const stillIn = story.requirementIds.some((id) => inScope(state).some((r) => r.id === id));
      if (!stillIn) throw missing("STORY_OUT_OF_SCOPE", `story ${command.id} covers only requirements that are out of scope; return a requirement to scope first`);
      let next = pushHistory(state, story, "restore", "restored", now);
      const { excludedReason: _e, ...rest } = story;
      next = { ...next, stories: next.stories.map((s) => (s === story ? UserStorySchema.parse({ ...rest, status: "proposed", confirmedBehavior: false, revision: story.revision + 1 }) : s)) };
      next = setPlanStatusFor(next, story.id, "detailed");
      next = touch(next, now, `story ${story.id} restored; it needs review and confirmation again`);
      return { state: next, duplicate: false, result: { storyId: story.id, restored: true, revision: story.revision + 1 } };
    }
    case "split-story": {
      const original = storyOf(state, command.id);
      const taken = new Set<string>();
      const created: UserStory[] = [];
      for (const part of command.into) {
        if (state.stories.some((s) => s.id === part.id) || created.some((s) => s.id === part.id)) throw missing("DUPLICATE_STORY", `story ${part.id} already exists`);
        const moved = part.moveAcceptance.map((id) => {
          const found = original.acceptanceCriteria.find((c) => c.id === id);
          if (!found) throw missing("MISSING_ACCEPTANCE_CRITERION", `${id} is not a criterion of ${original.id}`);
          if (taken.has(id)) throw missing("SPLIT_DUPLICATE_AC", `${id} is allocated to two stories`);
          taken.add(id);
          return { ...found };
        });
        const own = part.acceptanceCriteria.map((c, i) => ({ id: c.id ?? `${part.id}-AC-${String(i + 1).padStart(2, "0")}`, given: c.given, when: c.when, then: c.then }));
        const acceptanceCriteria = [...moved, ...own];
        if (acceptanceCriteria.length === 0) throw missing("SPLIT_NEEDS_CRITERIA", `${part.id} needs acceptance criteria (moveAcceptance or acceptanceCriteria)`);
        const { id, moveAcceptance: _m, acceptanceCriteria: _a, ...patch } = part;
        created.push(
          UserStorySchema.parse({
            ...original,
            ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
            id,
            acceptanceCriteria,
            revision: 1,
            status: "proposed",
            confirmedBehavior: false,
            stale: false,
            review: {},
          }),
        );
      }
      const unallocated = original.acceptanceCriteria.filter((c) => !taken.has(c.id)).map((c) => c.id);
      if (unallocated.length > 0) throw missing("SPLIT_UNALLOCATED_AC", `acceptance criteria of ${original.id} not allocated to a new story: ${unallocated.join(", ")}`);
      let next = pushHistory(state, original, "split", command.reason ?? `split into ${created.map((s) => s.id).join(", ")}`, now);
      next = { ...next, stories: [...next.stories.map((s) => (s === original ? { ...s, status: "superseded" as const, confirmedBehavior: false } : s)), ...created] };
      if (next.storyPlan) {
        const entry = next.storyPlan.entries.find((e) => e.id === original.id);
        if (entry) {
          const replacement = created.map((s) => StoryPlanEntrySchema.parse({ ...entry, id: s.id, title: s.title ?? entry.title, implementation: entry.implementation, requirementIds: s.requirementIds, status: "detailed", review: { status: "pending" } }));
          next = { ...next, storyPlan: { ...next.storyPlan, revision: next.storyPlan.revision + 1, status: "draft", entries: [...next.storyPlan.entries.filter((e) => e.id !== original.id), ...replacement] } };
        }
      }
      next = touch(next, now, `story ${original.id} split into ${created.map((s) => s.id).join(", ")}`);
      return { state: next, duplicate: false, result: { superseded: original.id, created: created.map((s) => s.id) } };
    }
    case "merge-stories": {
      const originals = command.ids.map((id) => storyOf(state, id));
      if (state.stories.some((s) => s.id === command.into.id)) throw missing("DUPLICATE_STORY", `story ${command.into.id} already exists`);
      const first = originals[0];
      const criteria: UserStory["acceptanceCriteria"] = [];
      const seen = new Set<string>();
      for (const story of originals) for (const c of story.acceptanceCriteria) {
        let id = c.id;
        if (seen.has(id)) id = `${command.into.id}-${id.split("-AC-").pop() ? `AC-${id.split("-AC-").pop()}` : id}`;
        seen.add(id);
        criteria.push({ ...c, id });
      }
      const union = <T,>(pick: (s: UserStory) => T[]) => [...new Set(originals.flatMap(pick))];
      const { id, ...patch } = command.into;
      const merged = UserStorySchema.parse({
        ...first,
        id,
        requirementIds: union((s) => s.requirementIds),
        happyPath: union((s) => s.happyPath),
        alternatives: union((s) => s.alternatives),
        negative: union((s) => s.negative),
        edgeCases: union((s) => s.edgeCases),
        businessRules: union((s) => s.businessRules),
        expectedResults: union((s) => s.expectedResults),
        preconditions: union((s) => s.preconditions),
        dependencies: union((s) => s.dependencies).filter((d) => !command.ids.includes(d as never)),
        capabilities: union((s) => s.capabilities),
        screenRefs: union((s) => s.screenRefs),
        repositoryIds: union((s) => s.repositoryIds),
        serviceIds: union((s) => s.serviceIds),
        acceptanceCriteria: criteria,
        ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
        revision: 1,
        status: "proposed",
        confirmedBehavior: false,
        stale: false,
        review: {},
      });
      let next = state;
      for (const story of originals) next = pushHistory(next, story, "merge", `merged into ${merged.id}`, now);
      next = { ...next, stories: [...next.stories.map((s) => (originals.includes(s) ? { ...s, status: "superseded" as const, confirmedBehavior: false } : s)), merged] };
      if (next.storyPlan) {
        const plan = next.storyPlan.entries.filter((e) => !command.ids.includes(e.id as never));
        const base = next.storyPlan.entries.find((e) => e.id === first.id);
        if (base) {
          plan.push(StoryPlanEntrySchema.parse({ ...base, id: merged.id, title: merged.title ?? base.title, requirementIds: merged.requirementIds, status: "detailed", dependsOn: base.dependsOn.filter((d) => !command.ids.includes(d as never)), review: { status: "pending" } }));
          next = { ...next, storyPlan: { ...next.storyPlan, revision: next.storyPlan.revision + 1, status: "draft", entries: plan.map((e) => ({ ...e, dependsOn: e.dependsOn.map((d) => (command.ids.includes(d as never) ? merged.id : d)) })) } };
        }
      }
      next = touch(next, now, `stories ${command.ids.join(", ")} merged into ${merged.id}`);
      return { state: next, duplicate: false, result: { merged: merged.id, superseded: command.ids } };
    }
    case "review-stories": {
      let next = state;
      const skipped: Array<{ storyId: string; key: string; reason: string }> = [];
      const mark = (story: UserStory, key: string, status: "pending" | "accepted" | "rejected", comment?: string) => ({
        ...story,
        review: { ...story.review, [key]: { status, ...(comment !== undefined ? { comment } : {}), at: iso(now), via: command.via } },
      });
      const keyFor = (story: UserStory, key: string) => {
        const [kind, rest] = [key.split(":")[0], key.slice(key.indexOf(":") + 1)];
        if (kind === "ac") return story.acceptanceCriteria.some((c) => c.id === rest);
        const list: Record<string, string[]> = { step: story.happyPath, alt: story.alternatives, neg: story.negative, edge: story.edgeCases, rule: story.businessRules, result: story.expectedResults };
        return Boolean(list[kind]) && Number.isInteger(Number(rest)) && Number(rest) >= 0 && Number(rest) < list[kind].length;
      };
      const allKeys = (story: UserStory) => [
        ...story.acceptanceCriteria.map((c) => `ac:${c.id}`),
        ...story.happyPath.map((_, i) => `step:${i}`),
        ...story.alternatives.map((_, i) => `alt:${i}`),
        ...story.negative.map((_, i) => `neg:${i}`),
        ...story.edgeCases.map((_, i) => `edge:${i}`),
        ...story.businessRules.map((_, i) => `rule:${i}`),
        ...story.expectedResults.map((_, i) => `result:${i}`),
      ];
      for (const item of command.items) {
        const story = next.stories.find((s) => s.id === item.storyId && s.status !== "superseded");
        if (!story) { skipped.push({ storyId: item.storyId, key: item.key, reason: "story not found" }); continue; }
        if (story.revision !== item.revision) { skipped.push({ storyId: item.storyId, key: item.key, reason: `story is now revision ${story.revision}, the review was of ${item.revision}` }); continue; }
        if (!keyFor(story, item.key)) { skipped.push({ storyId: item.storyId, key: item.key, reason: "no such item" }); continue; }
        next = { ...next, stories: next.stories.map((s) => (s === story ? mark(story, item.key, item.status, item.comment) : s)) };
      }
      for (const accept of command.acceptStories) {
        const story = next.stories.find((s) => s.id === accept.storyId && s.status !== "superseded");
        if (!story) { skipped.push({ storyId: accept.storyId, key: "*", reason: "story not found" }); continue; }
        if (story.revision !== accept.revision) { skipped.push({ storyId: accept.storyId, key: "*", reason: `story is now revision ${story.revision}` }); continue; }
        let updated = story;
        for (const key of allKeys(story)) if ((updated.review[key]?.status ?? "pending") === "pending") updated = mark(updated, key, "accepted");
        next = { ...next, stories: next.stories.map((s) => (s === story ? updated : s)) };
      }
      next = touch(next, now, `stories reviewed (${command.via}): ${command.items.length} item mark(s), ${command.acceptStories.length} bulk accept(s)`);
      return { state: next, duplicate: false, result: { skipped, progress: storyReviewProgress(next) } };
    }
    case "accept-stories": {
      const progress = storyReviewProgress(state);
      if (!progress.complete) throw missing("STORIES_NOT_REVIEWED", `stories are not fully reviewed: ${progress.accepted}/${progress.items} items accepted, ${progress.rejected} rejected, ${progress.pending} pending`, { progress });
      const coverage = analyzeStoryCoverage(state);
      if (state.mode === "guided" && !coverage.ok) throw missing("STORIES_COVERAGE_GAPS", `coverage gaps remain: ${[...coverage.gaps.map((g) => g.reason), ...coverage.requirementsWithoutStories.map((id) => `${id} has no story`), ...coverage.storiesOutOfScope.map((id) => `${id} is out of scope`)].join("; ")}`, { coverage });
      const next = recordAcceptance(state, "stories_review", command.via, now);
      return { state: touch(next, now, "stories accepted by the reviewer"), duplicate: false, result: { accepted: true, progress, coverage } };
    }
    case "register-repository":
      return registerRepository(state, command, now);
    case "assign-repositories": {
      assertRepos(state, command.repositoryIds);
      let next = state;
      for (const id of command.storyIds) storyOf(next, id);
      for (const id of command.requirementIds) requirementOf(next, id);
      for (const id of command.serviceIds) if (!next.services.some((s) => s.id === id)) throw missing("SERVICE_NOT_FOUND", `service ${id} not found`);
      const merge = (list: string[]) => [...new Set([...list, ...command.repositoryIds])];
      next = {
        ...next,
        stories: next.stories.map((s) => (command.storyIds.includes(s.id) ? { ...s, repositoryIds: merge(s.repositoryIds) } : s)),
        requirements: next.requirements.map((r) => (command.requirementIds.includes(r.id) ? { ...r, repositoryIds: merge(r.repositoryIds) } : r)),
        services: next.services.map((s) => (command.serviceIds.includes(s.id) ? { ...s, repositoryId: s.repositoryId ?? command.repositoryIds[0] } : s)),
        storyPlan: next.storyPlan ? { ...next.storyPlan, entries: next.storyPlan.entries.map((e) => (command.storyIds.includes(e.id) ? { ...e, repositoryIds: merge(e.repositoryIds) } : e)) } : next.storyPlan,
      };
      return { state: touch(next, now, `repositories ${command.repositoryIds.join(", ")} assigned`), duplicate: false, result: { assigned: command.repositoryIds } };
    }
    case "record-repository-inspection": {
      assertRepos(state, [command.repositoryId]);
      const repositories = state.repositories.map((r) => (r.id === command.repositoryId ? { ...r, status: "inspected" as const, inspection: command.inspection } : r));
      return { state: touch({ ...state, repositories }, now, `repository ${command.repositoryId} inspected`), duplicate: false, result: { repositoryId: command.repositoryId, headSha: command.inspection.headSha ?? null } };
    }
    case "set-contract": {
      const { contract } = command;
      if (!state.services.some((s) => s.id === contract.providerServiceId)) throw missing("SERVICE_NOT_FOUND", `provider service ${contract.providerServiceId} not found`);
      for (const id of contract.consumerServiceIds) if (!state.services.some((s) => s.id === id)) throw missing("SERVICE_NOT_FOUND", `consumer service ${id} not found`);
      const previous = state.contracts.find((c) => c.id === contract.id);
      const stripped = (c: { status?: string; agreement?: unknown; everAgreed?: boolean }) => { const { status: _s, agreement: _a, everAgreed: _e, ...rest } = c; return hash(rest); };
      // A user agreement belongs to the content they agreed to: a changed contract is proposed again.
      const agreedNow = contract.status === "agreed";
      const kept = previous?.status === "agreed" && !agreedNow && stripped(previous) === stripped(contract);
      const next1 = { ...contract, ...(agreedNow || previous?.everAgreed ? { everAgreed: true } : {}), status: agreedNow || kept ? ("agreed" as const) : ("proposed" as const), ...(agreedNow ? { agreement: { at: iso(now), via: command.via === "approved" ? ("approved" as const) : ("html-review" as const) } } : kept && previous?.agreement ? { agreement: previous.agreement } : {}) };
      const contracts = [...state.contracts.filter((c) => c.id !== contract.id), next1];
      return { state: touch({ ...state, contracts }, now, `contract ${contract.id} set`), duplicate: false, result: { contractId: contract.id } };
    }
    case "remove-contract": {
      const doomed = state.contracts.find((c) => c.id === command.id);
      if (!doomed) throw missing("CONTRACT_NOT_FOUND", `contract ${command.id} not found`);
      // Removing what the user agreed would let implementation continue with nothing agreed: that is the user's call.
      if ((doomed.status === "agreed" || doomed.everAgreed) && !verified) throw new WorkflowError("USER_DECISION_REQUIRED", `contract ${command.id} was agreed by the user; removing it is their decision, not the agent's`);
      return { state: touch({ ...state, contracts: state.contracts.filter((c) => c.id !== command.id) }, now, `contract ${command.id} removed`), duplicate: false, result: { removed: command.id } };
    }
    case "record-impact": {
      for (const behavior of command.impact.baseline.behaviors) assertRepos(state, behavior.evidence.map((e) => e.repositoryId));
      assertRepos(state, command.impact.affected.map((a) => a.repositoryId));
      const impact = ImpactSchema.parse({ ...command.impact, revision: (state.impact?.revision ?? 0) + 1, recordedAt: iso(now) });
      return { state: touch({ ...state, impact }, now, `impact r${impact.revision}: ${impact.affected.length} affected area(s), ${impact.regressionChecks.length} regression check(s)`), duplicate: false, result: { revision: impact.revision } };
    }
    case "advance-phase":
      return advancePhase(state, command, now);
    case "return-to-phase":
      return returnToPhase(state, command, now);
    case "log-session": {
      const note = { at: iso(now), summary: command.summary, ...(command.nextAction ? { nextAction: command.nextAction } : {}), ...(command.role ? { role: command.role } : {}) };
      return { state: { ...state, updatedAt: iso(now), sessionLog: [...state.sessionLog, note].slice(-200) }, duplicate: false, result: { logged: true, entries: Math.min(200, state.sessionLog.length + 1) } };
    }
    case "waive-coverage": {
      if (command.requirementId) requirementOf(state, command.requirementId);
      const waiver = CoverageWaiverSchema.parse({ id: `W-${String(state.waivers.length + 1).padStart(3, "0")}`, kind: command.kind, requirementId: command.requirementId, reason: command.reason, at: iso(now), decidedVia: verified ?? "chat", ...(command.requirementId ? { gap: analyzeStoryCoverage(state).gaps.find((g) => g.requirementId === command.requirementId)?.because[command.kind] || undefined } : {}) });
      return { state: touch({ ...state, waivers: [...state.waivers, waiver] }, now, `waived ${command.kind}${command.requirementId ? ` for ${command.requirementId}` : ""}: ${command.reason}`), duplicate: false, result: { waiverId: waiver.id } };
    }
    case "set-mode": {
      if (state.mode === command.mode) return { state, duplicate: true, result: { mode: state.mode, unchanged: true } };
      const report = modeSwitchReport(state, command.mode);
      const note = { at: iso(now), summary: `mode changed from ${state.mode} to ${command.mode}${command.reason ? `: ${command.reason}` : ""}`, nextAction: nextStep({ ...state, mode: command.mode }).summary };
      const next = touch({ ...state, mode: command.mode, sessionLog: [...state.sessionLog, note].slice(-200) }, now, `mode ${state.mode} -> ${command.mode}`);
      return { state: next, duplicate: false, result: { from: state.mode, to: command.mode, report } };
    }
    case "set-work-item-kind":
      return { state: touch({ ...state, workItem: { ...state.workItem, kind: command.kind } }, now, `work item kind: ${command.kind}`), duplicate: state.workItem.kind === command.kind, result: { kind: command.kind } };
  }
}

export function storyReviewProgress(state: WorkflowState) {
  let items = 0;
  let accepted = 0;
  let rejected = 0;
  for (const story of activeStories(state)) {
    const keys = [
      ...story.acceptanceCriteria.map((c) => `ac:${c.id}`),
      ...story.happyPath.map((_, i) => `step:${i}`),
      ...story.alternatives.map((_, i) => `alt:${i}`),
      ...story.negative.map((_, i) => `neg:${i}`),
      ...story.edgeCases.map((_, i) => `edge:${i}`),
      ...story.businessRules.map((_, i) => `rule:${i}`),
      ...story.expectedResults.map((_, i) => `result:${i}`),
    ];
    for (const key of keys) {
      items += 1;
      const status = story.review[key]?.status ?? "pending";
      if (status === "accepted") accepted += 1;
      if (status === "rejected") rejected += 1;
    }
  }
  const pending = items - accepted - rejected;
  return { stories: activeStories(state).length, items, accepted, rejected, pending, complete: items > 0 && accepted === items };
}

// --- migration from contract 1.0.0 -------------------------------------------------------------------------------

/** The phase a 1.0.0 state is most likely in, from what it already holds. */
export function inferPhase(state: WorkflowState): Phase {
  if (state.verdicts.some((v) => v.scope === "feature")) return "delivery";
  if (state.verdicts.length > 0) return "quality";
  if (state.implementationUnits.length > 0) return "development";
  if (state.services.length > 0) return "architecture";
  if (state.stories.length > 0) return "stories_review";
  if (state.requirements.length > 0) return "requirements";
  return "request";
}

/**
 * Brings a saved state to the current contract. Nothing is dropped: ids, revisions, decisions, stories, handoffs,
 * verdicts and coverage are kept; new fields take their defaults. Requirements approved before the review existed keep
 * their approval as accepted criteria, so an upgrade does not ask the user to review everything again.
 */
export function migrateWorkflowState<T extends WorkflowState>(state: T): T {
  if (state.version === "1.1.0") return state;
  const requirements = state.requirements.map((r) => ({
    ...r,
    acceptanceCriteria: r.acceptanceCriteria.map((c) =>
      r.status === "approved" && c.review.status === "pending" ? { ...c, review: { status: "accepted" as const, via: "system" as const } } : c,
    ),
  }));
  const migrated = { ...state, version: "1.1.0" as const, requirements } as T;
  return { ...migrated, phase: inferPhase(migrated) };
}

export { PHASES };
