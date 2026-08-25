import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type CatalogPlugin = {
  name: string;
  package: string;
  version: string;
  license: string;
};

export type Catalog = {
  schemaVersion: number;
  updated: string;
  plugins: CatalogPlugin[];
};

const here = dirname(fileURLToPath(import.meta.url));

export function catalogPath(root = join(here, "..")): string {
  return join(root, "catalog.json");
}

export function readCatalog(path = catalogPath()): Catalog {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Catalog;
  if (!Array.isArray(raw.plugins)) {
    throw new Error("catalog.json missing plugins[]");
  }
  return raw;
}

export function getPluginVersion(
  name: string,
  catalog = readCatalog(),
): string | undefined {
  return catalog.plugins.find((p) => p.name === name)?.version;
}
