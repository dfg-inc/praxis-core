import { z } from "zod";
import { WorkflowError } from "./errors.js";

/**
 * Parsing strips keys a schema does not know, so a misspelt or invented parameter (`editAcceptance`) used to vanish and the
 * command ran as something else. This walks the schema with the raw value and names every key the schema does not accept.
 */
export type UnknownParameter = { path: string; key: string; accepted: string[] };

const HINTS: Array<[RegExp, string]> = [
  [/^(editAcceptance|editAcceptanceCriteria|editAc|updateAcceptance|reviseAcceptance|acceptanceEdits|acId|acceptanceId|criterionId)$/i, "to change the text of one acceptance criterion use {\"action\":\"revise-acceptance\",\"edits\":[{\"id\":\"REQ-XXX-001-AC-01\",\"statement\":\"new text\"}]}"],
];

/**
 * State-only fields an agent legitimately echoes back when it copies a stored object into a command (set-contract with a
 * contract read from the state). They are still never stored from the command; only the refusal is waived.
 */
const ECHOED_STATE_FIELDS: Record<string, string[]> = {
  contract: ["agreement", "everAgreed"],
  // keys that would claim the user's authority are never read from a command; they are dropped, and the command still needs the user's real channel
  "": ["via", "approval", "userApproval", "channel", "userApproved", "authorization", "grant", "approved"],
};

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (let i = 0; i < 16; i += 1) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) current = current.unwrap();
    else if (current instanceof z.ZodDefault) current = current.removeDefault();
    else if (current instanceof z.ZodEffects) current = current.innerType();
    else if (current instanceof z.ZodLazy) current = current.schema;
    else if (current instanceof z.ZodBranded) current = current.unwrap();
    else if (current instanceof z.ZodReadonly) current = current._def.innerType;
    else if (current instanceof z.ZodCatch) current = current._def.innerType;
    else if (current instanceof z.ZodPipeline) current = current._def.in;
    else break;
  }
  return current;
}

function walk(schema: z.ZodTypeAny, value: unknown, path: string, out: UnknownParameter[], tolerate: boolean): void {
  const node = unwrap(schema);
  if (node instanceof z.ZodObject) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const shape = node.shape as Record<string, z.ZodTypeAny>;
    const accepted = Object.keys(shape);
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!(key in shape)) {
        if (item !== undefined && !(tolerate && ECHOED_STATE_FIELDS[path]?.includes(key))) out.push({ path, key, accepted });
        continue;
      }
      walk(shape[key], item, path ? `${path}.${key}` : key, out, tolerate);
    }
    return;
  }
  if (node instanceof z.ZodArray) {
    if (Array.isArray(value)) value.forEach((item, index) => walk(node.element, item, `${path}[${index}]`, out, tolerate));
    return;
  }
  if (node instanceof z.ZodTuple) {
    if (Array.isArray(value)) (node.items as z.ZodTypeAny[]).forEach((item, index) => walk(item, value[index], `${path}[${index}]`, out, tolerate));
    return;
  }
  if (node instanceof z.ZodRecord) {
    // the keys of a record are data; what it holds is checked
    if (typeof value === "object" && value !== null && !Array.isArray(value)) for (const [key, item] of Object.entries(value as Record<string, unknown>)) walk(node.valueSchema, item, path ? `${path}.${key}` : key, out, tolerate);
    return;
  }
  if (node instanceof z.ZodIntersection) {
    // a key is unknown only when neither side accepts it
    const left: UnknownParameter[] = [];
    const right: UnknownParameter[] = [];
    walk(node._def.left, value, path, left, tolerate);
    walk(node._def.right, value, path, right, tolerate);
    const rightKeys = new Set(right.map((u) => `${u.path}\u0000${u.key}`));
    for (const u of left) if (rightKeys.has(`${u.path}\u0000${u.key}`)) out.push(u);
    return;
  }
  if (node instanceof z.ZodDiscriminatedUnion || node instanceof z.ZodUnion) {
    // every option the value satisfies is tried; the value is judged by the one that leaves the fewest unknown keys
    const matches = (node.options as z.ZodTypeAny[]).filter((option) => option.safeParse(value).success);
    let best: UnknownParameter[] | null = null;
    for (const option of matches) {
      const found: UnknownParameter[] = [];
      walk(option, value, path, found, tolerate);
      if (best === null || found.length < best.length) best = found;
    }
    if (best) out.push(...best);
  }
}

export function unknownParameters(schema: z.ZodTypeAny, value: unknown, tolerate = true): UnknownParameter[] {
  const out: UnknownParameter[] = [];
  walk(schema, value, "", out, tolerate);
  return out;
}

/** Parse, and refuse (UNKNOWN_COMMAND_PARAMETER) a command that carries a key its action does not accept. */
export function parseStrict<S extends z.ZodTypeAny>(schema: S, raw: unknown, options: { tolerate?: boolean } = {}): z.infer<S> {
  const parsed = schema.parse(raw);
  const unknown = unknownParameters(schema, raw, options.tolerate ?? true);
  if (unknown.length > 0) {
    const action = typeof (raw as { action?: unknown })?.action === "string" ? (raw as { action: string }).action : undefined;
    const lines = unknown.slice(0, 6).map((item) => {
      const hint = HINTS.find(([pattern]) => pattern.test(item.key))?.[1];
      const where = item.path ? `${item.path}` : action ? `command ${action}` : "the command";
      return `"${item.key}" is not a parameter of ${where} (accepted: ${item.accepted.join(", ") || "none"})${hint ? `; ${hint}` : ""}`;
    });
    throw new WorkflowError("UNKNOWN_COMMAND_PARAMETER", `${lines.join(". ")}. Nothing was changed. praxis_workflow_commands lists every action with its fields and an example.`, { unknown: unknown.map((u) => ({ path: u.path, key: u.key })) });
  }
  return parsed;
}
