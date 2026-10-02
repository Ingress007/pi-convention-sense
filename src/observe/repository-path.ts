import { relative, resolve, sep } from "node:path";
import { isPathInside } from "../runtime/paths.js";

function slashed(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/**
 * Structural classifiers match segments such as `/src/main/`, `/generated/` or `/views/`. They must
 * only see the repository-relative part of a path: directories above the repository (`D:\build\app`,
 * `~/test/app`) say nothing about a file's role or whether it is generated or test code.
 *
 * Returns forward slashes with a leading `/` so patterns anchor at the repository root. Without a
 * usable root (or for a path outside it) the given path is returned with normalized separators.
 *
 * This runs for every indexed file on every analysis, so the common case (both paths normalized and
 * spelled alike) is a literal prefix test; `relative()` is only needed when the spelling differs.
 */
export function classificationPath(path: string, repositoryRoot?: string): string {
  if (repositoryRoot) {
    const root = resolve(repositoryRoot);
    const absolute = resolve(path);
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (absolute.startsWith(prefix) && absolute.length > prefix.length) {
      return `/${slashed(absolute.slice(prefix.length))}`;
    }
    if (isPathInside(root, absolute)) return `/${slashed(relative(root, absolute))}`;
  }
  return path.replaceAll("\\", "/");
}
