export const JSON_CONTRACT = "praxis.cli.envelope";

export type CliEnvelope = {
  ok: boolean;
  command: string;
  contract: string;
  version: string;
  data: unknown;
  warnings: string[];
  errors: string[];
};

export function envelope(opts: {
  ok: boolean;
  command: string;
  version: string;
  data?: unknown;
  warnings?: string[];
  errors?: string[];
}): CliEnvelope {
  return {
    ok: opts.ok,
    command: opts.command,
    contract: JSON_CONTRACT,
    version: opts.version,
    data: opts.data ?? {},
    warnings: opts.warnings ?? [],
    errors: opts.errors ?? [],
  };
}

export function isCliEnvelope(value: unknown): value is CliEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ok === "boolean" &&
    typeof v.command === "string" &&
    v.contract === JSON_CONTRACT &&
    typeof v.version === "string" &&
    Array.isArray(v.warnings) &&
    Array.isArray(v.errors)
  );
}
