export const EXIT = {
  OK: 0,
  USAGE: 2,
  CONFIRM: 3,
  BLOCKED: 4,
  EXTERNAL: 5,
  CONFLICT: 6,
  LOCAL_UNAVAILABLE: 7,
  VALIDATION: 8,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export function exitFromError(err: unknown): ExitCode {
  const msg = err instanceof Error ? err.message : String(err);
  if (/LOCAL_RUNTIME_UNAVAILABLE/i.test(msg)) return EXIT.LOCAL_UNAVAILABLE;
  if (/requires --confirm|confirmation required/i.test(msg)) return EXIT.CONFIRM;
  if (/claim denied|claim race|migration conflict/i.test(msg)) return EXIT.CONFLICT;
  if (
    /BA_REMOTE_APPLY_INCOMPLETE|ARCHITECT_DESIGN_MISSING|BA_PROPOSAL_MISSING|workflow blocked|gate not satisfied/i.test(
      msg,
    )
  ) {
    return EXIT.BLOCKED;
  }
  if (/Jira .+ failed|HTTP 5\d\d|UND_ERR_|ECONNRESET|ETIMEDOUT|external service/i.test(msg)) {
    return EXIT.EXTERNAL;
  }
  if (/invalid|schema|validation|JSON parse/i.test(msg)) return EXIT.VALIDATION;
  if (/Missing |unknown command|usage:/i.test(msg)) return EXIT.USAGE;
  return EXIT.USAGE;
}
