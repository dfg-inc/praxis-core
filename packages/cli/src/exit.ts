import { PraxisOpError } from "./operations.js";

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

const CODE_EXIT: Record<string, ExitCode> = {
  INVALID_INPUT: EXIT.USAGE,
  CONFIRMATION_REQUIRED: EXIT.CONFIRM,
  WORKFLOW_BLOCKED: EXIT.BLOCKED,
  EXTERNAL_SERVICE_ERROR: EXIT.EXTERNAL,
  CONFLICT: EXIT.CONFLICT,
  LOCAL_RUNTIME_UNAVAILABLE: EXIT.LOCAL_UNAVAILABLE,
  PRAXIS_RUNTIME_UNAVAILABLE: EXIT.LOCAL_UNAVAILABLE,
  VALIDATION_FAILED: EXIT.VALIDATION,
  REPOSITORY_UNAVAILABLE: EXIT.USAGE,
  JIRA_CONFIG_UNAVAILABLE: EXIT.USAGE,
  WORK_PACKAGE_NOT_FOUND: EXIT.USAGE,
  WORK_PACKAGE_OUT_OF_SCOPE: EXIT.USAGE,
  WORK_PACKAGE_SCOPE_AMBIGUOUS: EXIT.USAGE,
  WORK_PACKAGE_SUPERSEDED: EXIT.BLOCKED,
  WORK_PACKAGE_INVALID_STATE: EXIT.BLOCKED,
  WORK_PACKAGE_TITLE_INVALID: EXIT.VALIDATION,
  JIRA_TRANSITION_ID_INVALID: EXIT.VALIDATION,
  JIRA_TRANSITION_NOT_AVAILABLE: EXIT.BLOCKED,
  WORK_PACKAGE_ALREADY_CLAIMED: EXIT.CONFLICT,
};

export function exitFromError(err: unknown): ExitCode {
  if (err instanceof PraxisOpError) {
    return CODE_EXIT[err.code] ?? EXIT.USAGE;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/LOCAL_RUNTIME_UNAVAILABLE/i.test(msg)) return EXIT.LOCAL_UNAVAILABLE;
  if (/requires --confirm|confirmation required|confirmation=YES/i.test(msg)) return EXIT.CONFIRM;
  if (/claim denied|claim race|migration conflict|previewFingerprint mismatch/i.test(msg)) {
    return EXIT.CONFLICT;
  }
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
