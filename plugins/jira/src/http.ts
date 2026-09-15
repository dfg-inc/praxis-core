export type JsonParseSuccess<T> = { ok: true; value: T };
export type JsonParseFailure = {
  ok: false;
  message: string;
};

/**
 * Parse a successful (2xx) Jira HTTP body.
 * Empty/whitespace bodies are success with `undefined` — including 200/201/202
 * with `Content-Type: application/json`. Never JSON.parse("").
 */
export function parseJiraSuccessBody<T = unknown>(opts: {
  method: string;
  path: string;
  status: number;
  contentType: string;
  bodyText: string;
}): JsonParseSuccess<T | undefined> | JsonParseFailure {
  const { method, path, status, contentType, bodyText } = opts;
  if (status === 204 || status === 205) {
    return { ok: true, value: undefined };
  }
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return { ok: true, value: undefined };
  }
  const json =
    contentType.toLowerCase().includes("json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[");
  if (!json) {
    return { ok: true, value: trimmed as T };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) as T };
  } catch {
    return {
      ok: false,
      message: `Jira response JSON parse failed: method=${method} path=${path} status=${status}`,
    };
  }
}

export async function readJiraResponseJson<T>(
  res: Response,
  method: string,
  path: string,
): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Jira ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 400)}`,
    );
  }
  if (res.status === 204 || res.status === 205) {
    return undefined as T;
  }
  const text = await res.text();
  const parsed = parseJiraSuccessBody<T>({
    method,
    path,
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    bodyText: text,
  });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value as T;
}
