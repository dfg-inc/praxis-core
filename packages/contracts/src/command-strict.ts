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

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (let i = 0; i < 12; i += 1) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) current = current.unwrap();
    else if (current instanceof z.ZodDefault) current = current.removeDefault();
    else if (current instanceof z.ZodEffects) current = current.innerType();
    else if (current instanceof z.ZodLazy) current = current.schema;
    else break;
  }
  return current;
}

/**
 * State-only fields an agent legitimately echoes back when it copies a stored object into a command (set-contract with a
 * contract read from the state). They are still never stored from the command; only the refusal is waived.
 */
const ECHOED_STATE_FIELDS: Record<string, string[]> = {
  contract: ["agreement", "everAgreed"],
  // keys that would claim the user's authority are never read from a command; they are dropped, and the command still needs the user's real channel
  "": ["via", "approval", "userApproval", "channel", "userApproved"],
};

function walk(schema: z.ZodTypeAny, value: unknown, path: string, out: UnknownParameter[]): void {
  const node = unwrap(schema);
  if (node instanceof z.ZodObject) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const shape = node.shape as Record<string, z.ZodTypeAny>;
    const accepted = Object.keys(shape);
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!(key in shape)) {
        if (item !== undefined && !ECHOED_STATE_FIELDS[path]?.includes(key)) out.push({ path, key, accepted });
        continue;
      }
      walk(shape[key], item, path ? `${path}.${key}` : key, out);
    }
    return;
  }
  if (node instanceof z.ZodArray) {
    if (Array.isArray(value)) value.forEach((item, index) => walk(node.element, item, `${path}[${index}]`, out));
    return;
  }
  if (node instanceof z.ZodDiscriminatedUnion || node instanceof z.ZodUnion) {
    const options = node.options as z.ZodTypeAny[];
    const match = options.find((option) => option.safeParse(value).success);
    if (match) walk(match, value, path, out);
  }
}

export function unknownParameters(schema: z.ZodTypeAny, value: unknown): UnknownParameter[] {
  const out: UnknownParameter[] = [];
  walk(schema, value, "", out);
  return out;
}

/** Parse, and refuse (UNKNOWN_COMMAND_PARAMETER) a command that carries a key its action does not accept. */
export function parseStrict<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.parse(raw);
  const unknown = unknownParameters(schema, raw);
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
