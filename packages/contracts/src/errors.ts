export class WorkflowError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    if (details) this.details = details;
  }
}
