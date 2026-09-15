import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type JsonReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "missing" | "empty" | "invalid-json"; message: string };

export function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, filePath);
}

export function readJsonFile<T>(
  filePath: string,
  artifactType: string,
): JsonReadResult<T> {
  if (!existsSync(filePath)) {
    return {
      ok: false,
      reason: "missing",
      message: `${artifactType} unavailable (${filePath})`,
    };
  }
  const raw = readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return {
      ok: false,
      reason: "empty",
      message: `${artifactType} at ${filePath} is empty`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch {
    return {
      ok: false,
      reason: "invalid-json",
      message: `${artifactType} at ${filePath} is not valid JSON`,
    };
  }
}
