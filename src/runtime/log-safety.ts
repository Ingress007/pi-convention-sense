import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isPathInside } from "./paths.js";

export function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false; // A path that does not exist yet cannot be a link.
  }
}

/**
 * True when appending to `logFile` could land outside the project: the file itself is a symlink, or
 * an existing directory between the project root and the file is a symlink or junction. Repository
 * content is untrusted input and git can commit symlinks.
 */
export function logTargetTravelsThroughLink(projectRoot: string, logFile: string): boolean {
  if (isSymbolicLink(logFile)) return true;
  const root = resolve(projectRoot);
  let current = dirname(resolve(logFile));
  while (isPathInside(root, current)) {
    if (isSymbolicLink(current)) return true;
    current = dirname(current);
  }
  return false;
}
