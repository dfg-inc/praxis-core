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

export function isTransientHttp(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

export const DEFAULT_JIRA_REQUEST_TIMEOUT_MS = 8000;

export function jiraRequestTimeoutMs(): number {
  const n = Number(process.env.PRAXIS_JIRA_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_JIRA_REQUEST_TIMEOUT_MS;
}

export function isAbortError(err: unknown): boolean {
  const name =
    err && typeof err === "object" && "name" in err
      ? String((err as { name?: string }).name ?? "")
      : "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /AbortError|TimeoutError|The operation was aborted|aborted due to timeout/i.test(
    msg,
  );
}

export function isHttpNotFound(err: unknown): boolean {
  return /HTTP 404\b/.test(err instanceof Error ? err.message : String(err));
}

export function mergeAbortSignals(
  signals: Array<AbortSignal | undefined>,
): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => Boolean(s));
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  const any = (
    AbortSignal as typeof AbortSignal & {
      any?: (input: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof any === "function") return any(live);
  const ac = new AbortController();
  for (const s of live) {
    if (s.aborted) {
      ac.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

export function isTransientError(err: unknown): boolean {
  if (isAbortError(err)) return false;
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: string }).code ?? "")
      : "";
  const cause =
    err && typeof err === "object" && "cause" in err
      ? (err as { cause?: { code?: string; message?: string } }).cause
      : undefined;
  const msg = `${code} ${cause?.code ?? ""} ${cause?.message ?? ""} ${err instanceof Error ? err.message : String(err)}`;
  return /UND_ERR_SOCKET|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed|fetch failed/i.test(
    msg,
  );
}

export async function sleepBackoff(
  attempt: number,
  retryAfter: string | null | undefined,
): Promise<void> {
  if (process.env.PRAXIS_JIRA_RETRY_BACKOFF_MS === "0") return;
  const fromHeader = retryAfter ? Number(retryAfter) * 1000 : NaN;
  const base = Number.isFinite(fromHeader) ? fromHeader : 200 * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * 50);
  await new Promise((r) => setTimeout(r, Math.min(base + jitter, 4000)));
}

export function contextualTransportError(
  err: unknown,
  ctx: { provider: string; method: string; path: string; attempt: number },
): Error {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: string }).code)
      : "";
  const msg = err instanceof Error ? err.message : String(err);
  const safe = msg
    .replace(/Authorization:\s*\S+/gi, "Authorization=<redacted>")
    .replace(/PRAXIS_JIRA_TOKEN=\S+/g, "PRAXIS_JIRA_TOKEN=<redacted>")
    .replace(/Bearer\s+\S+/g, "Bearer <redacted>");
  return new Error(
    `Jira ${ctx.provider} ${ctx.method} ${ctx.path} failed after ${ctx.attempt} attempt(s)${code ? ` code=${code}` : ""}: ${safe}`,
  );
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
