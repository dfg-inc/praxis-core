import { describe, expect, it } from "vitest";
import { defaultServiceEndpoint, parseServiceRequest, serviceDelegationActive } from "./approval-service.js";

const P = "praxis.approval-service.v1";

describe("approval service protocol", () => {
  it("accepts exactly submit, status, execute and health", () => {
    expect(parseServiceRequest({ protocol: P, op: "health" }).ok).toBe(true);
    expect(parseServiceRequest({ protocol: P, op: "status", requestId: "git-git-commit-abc" }).ok).toBe(true);
    expect(parseServiceRequest({ protocol: P, op: "execute", requestId: "git-git-push-abc" }).ok).toBe(true);
    expect(parseServiceRequest({ protocol: P, op: "submit", operation: "git_commit", repository: "/r", workItemId: "WI-1", params: { message: "m", paths: ["a.txt"] } }).ok).toBe(true);
  });

  it.each(["approve", "reject", "sign", "enroll", "set-config", "exec", "shell", "grant", "write", ""])("refuses %j as an unknown operation: the agent side cannot approve, sign or configure", (op) => {
    const result = parseServiceRequest({ protocol: P, op });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNKNOWN_OPERATION");
  });

  it("is strict: extra fields, wrong protocol, hostile ids and refs are refused", () => {
    const base = { protocol: P, op: "submit", operation: "git_commit", repository: "/r", workItemId: "WI-1" };
    expect(parseServiceRequest({ ...base, params: { message: "m", authorization: "x" } }).ok).toBe(false);
    expect(parseServiceRequest({ ...base, params: { message: "m", branch: "--upload-pack=evil" } }).ok).toBe(false);
    expect(parseServiceRequest({ ...base, params: { message: "m", branch: "a/../b" } }).ok).toBe(false);
    expect(parseServiceRequest({ ...base, params: { message: "m", branch: "-x" } }).ok).toBe(false);
    expect(parseServiceRequest({ ...base, extra: 1, params: { message: "m" } }).ok).toBe(false);
    expect(parseServiceRequest({ protocol: "other", op: "health" }).ok).toBe(false);
    expect(parseServiceRequest({ protocol: P, op: "status", requestId: "../../etc/passwd" }).ok).toBe(false);
    expect(parseServiceRequest({ protocol: P, op: "execute", requestId: "a/b" }).ok).toBe(false);
    expect(parseServiceRequest({ ...base, operation: "merge", params: {} }).ok).toBe(false);
    expect(parseServiceRequest({ ...base, operation: "release", params: {} }).ok).toBe(false);
    expect(parseServiceRequest(null).ok).toBe(false);
  });

  it("has a default endpoint per platform and delegates only when an endpoint is configured or present", () => {
    expect(defaultServiceEndpoint("win32")).toBe("\\\\.\\pipe\\praxis-approval-service");
    expect(defaultServiceEndpoint("darwin")).toContain("/Library/Application Support/Praxis/ApprovalService/run/");
    expect(defaultServiceEndpoint("linux")).toBe("/run/praxis-approval/service.sock");
    expect(serviceDelegationActive({ PRAXIS_APPROVAL_SERVICE_ENDPOINT: "/tmp/x.sock" })).toBe(true);
  });
});
