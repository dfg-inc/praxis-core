import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseStrict, parseWorkflowCommand, unknownParameters } from "./index.js";

const keys = (schema: z.ZodTypeAny, value: unknown, tolerate = true) => unknownParameters(schema, value, tolerate).map((u) => `${u.path}:${u.key}`);

describe("strict parameters reach every kind of nested schema", () => {
  const Inner = z.object({ id: z.string(), note: z.string().optional() });

  it("objects inside arrays, optionals, defaults, tuples and records are checked", () => {
    const schema = z.object({
      list: z.array(Inner).default([]),
      maybe: Inner.optional(),
      pair: z.tuple([Inner, z.string()]).optional(),
      byKey: z.record(z.string(), Inner).optional(),
    });
    expect(keys(schema, { list: [{ id: "a", extra: 1 }], maybe: { id: "b", bad: 1 }, pair: [{ id: "c", worse: 1 }, "x"], byKey: { anyName: { id: "d", nope: 1 } } })).toEqual(["list[0]:extra", "maybe:bad", "pair[0]:worse", "byKey.anyName:nope"]);
    expect(keys(schema, { byKey: { whatever: { id: "d" } } })).toEqual([]); // record keys are data
  });

  it("branded, piped, transformed and refined schemas are looked through", () => {
    const branded = z.object({ x: Inner.brand<"X">() });
    const piped = z.object({ y: Inner.transform((v) => v).pipe(z.object({ id: z.string() }).passthrough()) });
    const refined = z.object({ z: Inner.refine(() => true) });
    expect(keys(branded, { x: { id: "a", e: 1 } })).toEqual(["x:e"]);
    expect(keys(piped, { y: { id: "a", e: 1 } })).toEqual(["y:e"]);
    expect(keys(refined, { z: { id: "a", e: 1 } })).toEqual(["z:e"]);
  });

  it("an intersection accepts a key either side declares and refuses one neither declares", () => {
    const schema = z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() }));
    expect(keys(schema, { a: "1", b: "2" })).toEqual([]);
    expect(keys(schema, { a: "1", b: "2", c: "3" })).toEqual([":c"]);
  });

  it("a plain union is judged by the option that fits best, not the first that parses", () => {
    const schema = z.object({ v: z.union([z.object({ a: z.string() }), z.object({ a: z.string(), b: z.string() })]) });
    expect(keys(schema, { v: { a: "1", b: "2" } })).toEqual([]); // the first option parses too (it strips b) but the second accepts it
    expect(keys(schema, { v: { a: "1", c: "2" } })).toEqual(["v:c"]);
  });

  it("authority-shaped keys are tolerated only where asked", () => {
    const schema = z.object({ id: z.string() });
    expect(keys(schema, { id: "x", approved: true })).toEqual([]);
    expect(keys(schema, { id: "x", approved: true }, false)).toEqual([":approved"]);
    expect(() => parseStrict(schema, { id: "x", approved: true }, { tolerate: false })).toThrow(/"approved" is not a parameter/);
  });
});

describe("real commands: a stray key deep inside is refused, nothing is silently dropped", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["a story's criterion", { action: "add-story", id: "US-A-001", requirementIds: ["REQ-A-001"], actor: "m", narrative: "As a m, I want x, so that y.", objective: "o", userValue: "v", happyPath: ["a"], acceptanceCriteria: [{ id: "US-A-001-AC-01", given: "g", when: "w", then: "t", accepted: true }], expectedResults: ["e"], confirmedBehavior: false }, /"accepted" is not a parameter of acceptanceCriteria\[0\]/],
    ["a service", { action: "set-service", service: { id: "s", name: "s", kind: "module", responsibilities: ["x"], requirementIds: ["REQ-A-001"], dependsOn: [], status: "in_progress", approvedBy: "user" } }, /"approvedBy" is not a parameter of service/],
    ["a decision field", { action: "record-decision", id: "D", statement: "s", confirmedBy: "user" }, /"confirmedBy" is not a parameter/],
    ["a story plan line", { action: "set-story-plan", entries: [{ id: "US-A-001", title: "t", implementation: "i", userGets: "u", requirementIds: ["REQ-A-001"], review: { status: "accepted" } }] }, /"review" is not a parameter of entries\[0\]/],
    ["a review decision's criterion", { action: "review-requirements", via: "chat", decisions: [{ requirementId: "REQ-A-001", acceptance: [{ id: "REQ-A-001-AC-01", status: "accepted", accepted_by: "user" }] }] }, /"accepted_by" is not a parameter of decisions\[0\]\.acceptance\[0\]/],
    ["a contract", { action: "set-contract", contract: { id: "C", name: "c", providerServiceId: "s", consumerServiceIds: [], status: "agreed", agreedBy: "user" } }, /"agreedBy" is not a parameter of contract/],
    ["a revise-acceptance edit", { action: "revise-acceptance", edits: [{ id: "REQ-A-001-AC-01", statement: "x", status: "accepted" }] }, /"status" is not a parameter of edits\[0\]/],
  ];
  for (const [name, command, message] of cases) {
    it(name, () => {
      expect(() => parseWorkflowCommand(command)).toThrow(message);
    });
  }

  it("fields the schema does accept are unaffected, and echoed server-owned contract fields are still dropped", () => {
    const parsed = parseWorkflowCommand({ action: "set-contract", contract: { id: "C", name: "c", providerServiceId: "s", consumerServiceIds: [], status: "proposed", everAgreed: true, agreement: { via: "approved" } } }) as { contract: Record<string, unknown> };
    expect(parsed.contract.everAgreed).toBeUndefined();
    expect(parsed.contract.agreement).toBeUndefined();
  });
});

describe("audit: no agent-facing command schema has an ambiguous object union", () => {
  // The strict walk judges a plain union by the option that leaves the fewest unknown keys, while zod parses with the first
  // option that matches. They differ only for a union of overlapping object-like options. None exists in a command; this keeps it so.
  const strip = (schema: z.ZodTypeAny): z.ZodTypeAny => {
    let current = schema;
    for (let i = 0; i < 16; i += 1) {
      if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) current = current.unwrap();
      else if (current instanceof z.ZodDefault) current = current.removeDefault();
      else if (current instanceof z.ZodEffects) current = current.innerType();
      else if (current instanceof z.ZodBranded) current = current.unwrap();
      else if (current instanceof z.ZodReadonly || current instanceof z.ZodCatch) current = current._def.innerType;
      else if (current instanceof z.ZodPipeline) current = current._def.in;
      else if (current instanceof z.ZodLazy) current = current.schema;
      else break;
    }
    return current;
  };
  const objectLike = (schema: z.ZodTypeAny): boolean => {
    const node = strip(schema);
    return node instanceof z.ZodObject || node instanceof z.ZodRecord || node instanceof z.ZodIntersection || node instanceof z.ZodTuple || node instanceof z.ZodArray;
  };

  it("every non-discriminated union reachable from WorkflowCommandSchema has at most one object-like option; z.unknown / z.any fields are listed", async () => {
    const { WorkflowCommandSchema } = await import("./index.js");
    const seen = new Set<unknown>();
    const offenders: string[] = [];
    const open: string[] = [];
    const visit = (schema: z.ZodTypeAny, path: string): void => {
      if (!schema || seen.has(schema)) return;
      seen.add(schema);
      const node = strip(schema);
      if (node !== schema) visit(node, path);
      if (node instanceof z.ZodUnion && (node.options as z.ZodTypeAny[]).filter(objectLike).length > 1) offenders.push(path);
      if (node instanceof z.ZodUnknown || node instanceof z.ZodAny) open.push(path);
      const def = (node as { _def: Record<string, unknown> })._def;
      for (const [key, value] of Object.entries(def)) {
        const list = Array.isArray(value) ? value : [value];
        list.forEach((item, i) => {
          if (item instanceof z.ZodType) visit(item, `${path}/${key}${list.length > 1 ? i : ""}`);
          else if (typeof item === "function") {
            try {
              const out = (item as () => unknown)();
              if (out && typeof out === "object") for (const [k, v] of Object.entries(out as Record<string, unknown>)) if (v instanceof z.ZodType) visit(v, `${path}.${k}`);
            } catch {
              /* not a shape getter */
            }
          }
        });
      }
    };
    visit(WorkflowCommandSchema, "command");
    expect(offenders).toEqual([]);
    expect(seen.size).toBeGreaterThan(100); // the walk really went through the schema
    // free-form fields accept any keys by design; a new one must be reviewed on purpose
    // today: the example request and response bodies of a prototype API endpoint (free-form JSON on purpose)
    expect(open.every((path) => /prototype\.endpoints\/type\.(request|responses\/type\.example)$/.test(path))).toBe(true);
  });

  it("the audit itself catches an ambiguous union, a lazy one and a wrapped one", () => {
    const A = z.object({ id: z.string() });
    const B = z.object({ id: z.string(), extra: z.string() });
    const ambiguous = z.object({ v: z.union([A, B.optional().unwrap()]) });
    expect((ambiguous.shape.v as z.ZodUnion<[typeof A, typeof B]>).options.filter(objectLike)).toHaveLength(2);
    const wrapped = z.union([A.default({ id: "x" }), B.transform((v) => v)]);
    expect(wrapped.options.filter(objectLike)).toHaveLength(2);
    const lazy = z.union([z.lazy(() => A), z.lazy(() => B)]);
    expect(lazy.options.filter(objectLike)).toHaveLength(2);
  });
});
