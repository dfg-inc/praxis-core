export type PreviewTraceOp = "ba-preview" | "architect-preview";

export type PreviewTraceEvent = {
  op: PreviewTraceOp;
  stage: string;
  phase: "start" | "done" | "error";
  durationMs?: number;
};

export type PreviewTrace = {
  op: PreviewTraceOp;
  stages: Record<string, number>;
  log: (event: PreviewTraceEvent) => void;
};

function prefix(op: PreviewTraceOp): string {
  return op === "ba-preview" ? "praxis-ba-preview" : "praxis-architect-preview";
}

export function createPreviewTrace(op: PreviewTraceOp): PreviewTrace {
  const stages: Record<string, number> = {};
  return {
    op,
    stages,
    log(event) {
      const tag = prefix(event.op);
      if (event.phase === "start") {
        console.error(`[${tag}] stage=${event.stage} start`);
        return;
      }
      const durationMs = event.durationMs ?? 0;
      if (event.phase === "done") stages[event.stage] = durationMs;
      console.error(`[${tag}] stage=${event.stage} ${event.phase} durationMs=${durationMs}`);
    },
  };
}

export async function traced<T>(
  trace: PreviewTrace | undefined,
  stage: string,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  trace?.log({ op: trace.op, stage, phase: "start" });
  try {
    const out = await fn();
    trace?.log({
      op: trace.op,
      stage,
      phase: "done",
      durationMs: Date.now() - t0,
    });
    return out;
  } catch (err) {
    trace?.log({
      op: trace.op,
      stage,
      phase: "error",
      durationMs: Date.now() - t0,
    });
    throw err;
  }
}
