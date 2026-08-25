/** Shared test helpers for Phase 1 harnesses. */
export function assertNever(x: never): never {
  throw new Error(`unexpected value: ${String(x)}`);
}
