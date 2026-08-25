import { describe, expect, it, vi } from "vitest";
import { JiraClient } from "../src/index.js";

function mockFetchSequence(
  handlers: Array<(url: string, init?: RequestInit) => Promise<Response> | Response>,
) {
  let i = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const handler = handlers[i++];
    if (!handler) throw new Error(`Unexpected fetch #${i} to ${url}`);
    return handler(url, init);
  }) as unknown as typeof fetch;
}

const baseConfig = {
  baseUrl: "https://jira.example.com",
  token: "tok",
  projectKey: "PRAX",
};

describe("JiraClient human gate", () => {
  it("preview-no-write on reject", async () => {
    const fetchImpl = mockFetchSequence([]);
    const client = new JiraClient({ config: baseConfig, fetchImpl });
    const result = await client.createFeature(
      { summary: "Feat A" },
      async () => false,
    );
    expect(result).toEqual({ executed: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("writes on approve", async () => {
    const fetchImpl = mockFetchSequence([
      async (_url, init) => {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        expect(body.fields.summary).toBe("Feat A");
        expect(body.fields.project.key).toBe("PRAX");
        return new Response(JSON.stringify({ key: "PRAX-1" }), { status: 201 });
      },
    ]);
    const client = new JiraClient({ config: baseConfig, fetchImpl });
    const result = await client.createFeature(
      { summary: "Feat A" },
      async (preview) => {
        expect(preview.path).toBe("/rest/api/2/issue");
        return true;
      },
    );
    expect(result).toEqual({ executed: true, result: { key: "PRAX-1" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("verifyConnection hits /myself", async () => {
    const fetchImpl = mockFetchSequence([
      async (url) => {
        expect(url).toBe("https://jira.example.com/rest/api/2/myself");
        return new Response(JSON.stringify({ displayName: "Ada" }), {
          status: 200,
        });
      },
    ]);
    const client = new JiraClient({ config: baseConfig, fetchImpl });
    await expect(client.verifyConnection()).resolves.toEqual({
      ok: true,
      displayName: "Ada",
    });
  });

  it("readFeatureStatuses is read-only", async () => {
    const fetchImpl = mockFetchSequence([
      async (url) => {
        expect(url).toContain("/rest/api/2/issue/PRAX-1");
        return new Response(
          JSON.stringify({
            key: "PRAX-1",
            fields: {
              status: { name: "In Progress" },
              issuelinks: [
                {
                  type: { name: "Relates" },
                  outwardIssue: {
                    key: "PRAX-2",
                    fields: { status: { name: "Open" } },
                  },
                },
              ],
            },
          }),
          { status: 200 },
        );
      },
    ]);
    const client = new JiraClient({ config: baseConfig, fetchImpl });
    const statuses = await client.readFeatureStatuses("PRAX-1");
    expect(statuses.status).toBe("In Progress");
    expect(statuses.linked[0]?.key).toBe("PRAX-2");
  });

  it("atomic package: reject runs no executors", async () => {
    const fetchImpl = mockFetchSequence([]);
    const client = new JiraClient({ config: baseConfig, fetchImpl });
    const p1 = client.createFeaturePreview({ summary: "F" });
    let ran = false;
    const rejected = await client.confirmAndExecutePackage(
      "package",
      [p1],
      async () => false,
      [
        async () => {
          ran = true;
          return { key: "X" };
        },
      ],
    );
    expect(rejected).toEqual({ executed: false });
    expect(ran).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("atomic package: approve runs all executors in order", async () => {
    const client = new JiraClient({
      config: baseConfig,
      fetchImpl: mockFetchSequence([]),
    });
    const p1 = client.createFeaturePreview({ summary: "F" });
    const p2 = client.createStoryPreview({
      summary: "S",
      acceptanceCriteria: "given a when b then c",
    });
    const calls: string[] = [];
    const approved = await client.confirmAndExecutePackage(
      "package",
      [p1, p2],
      async (pkg) => {
        expect(pkg.mutations).toHaveLength(2);
        return true;
      },
      [
        async () => {
          calls.push("a");
          return { key: "A" };
        },
        async () => {
          calls.push("b");
          return { key: "B" };
        },
      ],
    );
    expect(approved).toEqual({
      executed: true,
      results: [{ key: "A" }, { key: "B" }],
    });
    expect(calls).toEqual(["a", "b"]);
  });

  it("decision link prefers permalink", () => {
    const client = new JiraClient({
      config: baseConfig,
      fetchImpl: mockFetchSequence([]),
    });
    const preview = client.attachDecisionLinkPreview({
      issueKey: "PRAX-1",
      decisionPath: "architecture/ADR-1.md",
      revision: "abc123",
      permalink: "https://git.example/blob/abc123/architecture/ADR-1.md",
    });
    expect(String((preview.body as { body: string }).body)).toContain(
      "https://git.example/blob/abc123/architecture/ADR-1.md",
    );
  });
});
