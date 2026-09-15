import { describe, expect, it } from "vitest";
import { parseJiraSuccessBody, readJiraResponseJson } from "../src/http.js";

function parse(status: number, body: string, ct = "application/json") {
  return parseJiraSuccessBody({
    method: "PUT",
    path: "/rest/api/3/issue/PRX-3/properties/praxis.artifactId",
    status,
    contentType: ct,
    bodyText: body,
  });
}

describe("parseJiraSuccessBody", () => {
  it("200 application/json empty is success", () => {
    const r = parse(200, "");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeUndefined();
  });
  it("200 application/json whitespace is success", () => {
    const r = parse(200, "  \n");
    expect(r.ok).toBe(true);
  });
  it("201 empty is success", () => {
    expect(parse(201, "").ok).toBe(true);
  });
  it("202 empty is success", () => {
    expect(parse(202, "").ok).toBe(true);
  });
  it("204 is success without payload", () => {
    expect(parse(204, "").ok).toBe(true);
  });
  it("205 is success without payload", () => {
    expect(parse(205, "").ok).toBe(true);
  });
  it("200 valid JSON parses", () => {
    const r = parse(200, '{"value":1}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ value: 1 });
  });
  it("200 invalid nonempty JSON is contextual error", () => {
    const r = parse(200, "{not-json");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/JSON parse failed/);
      expect(r.message).toMatch(/status=200/);
      expect(r.message).not.toMatch(/Authorization/);
      expect(r.message).not.toMatch(/token/i);
    }
  });
});

describe("readJiraResponseJson", () => {
  it("400 empty is error not success", async () => {
    await expect(
      readJiraResponseJson(
        new Response("", { status: 400 }),
        "PUT",
        "/issue/PRX-3",
      ),
    ).rejects.toThrow(/HTTP 400/);
  });
  it("500 empty is error", async () => {
    await expect(
      readJiraResponseJson(
        new Response("", { status: 500 }),
        "PUT",
        "/issue/PRX-3",
      ),
    ).rejects.toThrow(/HTTP 500/);
  });
});
