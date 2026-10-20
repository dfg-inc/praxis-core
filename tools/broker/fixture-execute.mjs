/**
 * Controlled fixture filesystem mutation. Not a general shell or path writer.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const FIXTURE_ACCEPTED_CONTENT = "accepted-by-operator\n";

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveContainedTarget(repository, target) {
  if (typeof repository !== "string" || !repository) {
    throw new Error("approved repository is required");
  }
  if (typeof target !== "string" || !target) {
    throw new Error("approved target is required");
  }
  if (target.includes("\0") || repository.includes("\0")) {
    throw new Error("nul in path rejected");
  }
  if (!existsSync(repository)) {
    throw new Error("approved repository does not exist");
  }
  const repoStat = lstatSync(repository);
  if (repoStat.isSymbolicLink()) {
    throw new Error("repository must not be a symlink");
  }
  if (!repoStat.isDirectory()) {
    throw new Error("approved repository is not a directory");
  }
  const repoDeclared = resolve(repository);
  const repoReal = realpathSync(repository);
  const requestedDeclared = isAbsolute(target) ? resolve(target) : resolve(repoDeclared, target);
  const rel = relative(repoDeclared, requestedDeclared);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("target is outside the approved repository");
  }
  const requested = resolve(repoReal, rel);
  const parts = rel.split(sep);
  let current = repoReal;
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      throw new Error("path traversal rejected");
    }
    const next = resolve(current, part);
    if (existsSync(next)) {
      const st = lstatSync(next);
      if (st.isSymbolicLink()) {
        const real = realpathSync(next);
        if (!isInside(repoReal, real)) {
          throw new Error("symlink escape rejected");
        }
      }
    }
    current = next;
  }
  if (existsSync(requested)) {
    const finalReal = realpathSync(requested);
    if (!isInside(repoReal, finalReal)) {
      throw new Error("resolved target escapes the approved repository");
    }
  }
  return requested;
}

export function writeApprovedFixtureFile(absolutePath, content) {
  const parent = dirname(absolutePath);
  mkdirSync(parent, { recursive: true });
  const tmp = `${absolutePath}.praxis-exec-${process.pid}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf8", flag: "w" });
  renameSync(tmp, absolutePath);
  const written = readFileSync(absolutePath, "utf8");
  if (written !== content) {
    throw new Error("fixture write verification failed");
  }
  return { path: absolutePath, bytes: Buffer.byteLength(content, "utf8") };
}
