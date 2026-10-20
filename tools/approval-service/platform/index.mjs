import { platform } from "node:os";
import * as darwin from "./darwin.mjs";
import * as linux from "./linux.mjs";
import * as win32 from "./win32.mjs";

export const ADAPTERS = { darwin, linux, win32 };

export function adapterFor(os = platform()) {
  const adapter = ADAPTERS[os];
  if (!adapter) throw new Error(`no approval-service adapter for platform ${os}`);
  return adapter;
}
