import { describe, expect, it } from "vitest";
import { assertNever } from "./index.js";

describe("assertNever", () => {
  it("throws", () => {
    expect(() => assertNever("x" as never)).toThrow(/unexpected/);
  });
});
