import { resolve } from "node:path";

/** Windows and macOS file systems are case-insensitive by default; Linux is case-sensitive. */
export function isCaseInsensitivePlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/**
 * Identity of a file for ledgers, caches and comparisons. Display paths keep the spelling the file
 * system or the tool reported; only this key is case-folded, so `D:\Repo\A.java` and `d:/repo/a.java`
 * are one file on Windows but stay distinct on Linux.
 */
export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = resolve(platform === "win32" ? stripExtendedPathPrefix(path) : path);
  return isCaseInsensitivePlatform(platform) ? resolved.toLowerCase() : resolved;
}

const EXTENDED_UNC_PREFIX = /^\\\\\?\\UNC\\/i;
const EXTENDED_DRIVE_PREFIX = /^\\\\\?\\(?=[A-Za-z]:)/;

/**
 * Windows tools print `\\?\D:\repo\A.java` and `\\?\UNC\server\share\a.java` for long paths; they name the same
 * files as `D:\repo\A.java` and `\\server\share\a.java`. Other `\\?\` namespaces (volume GUIDs, devices) are
 * left alone. Only apply this on Windows: on POSIX a backslash is an ordinary file-name character.
 */
export function stripExtendedPathPrefix(path: string): string {
  if (EXTENDED_UNC_PREFIX.test(path)) return `\\\\${path.slice(8)}`;
  return path.replace(EXTENDED_DRIVE_PREFIX, "");
}

/** True when two paths name the same file (case-folded on case-insensitive platforms). */
export function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

/** Case-fold a path segment or name for comparison; unchanged on case-sensitive platforms. */
export function foldPathCase(value: string, platform: NodeJS.Platform = process.platform): string {
  return isCaseInsensitivePlatform(platform) ? value.toLowerCase() : value;
}

/**
 * A set of file paths matched by `pathKey`. Iteration yields the first spelling that was added, so
 * checkpoints and logs never contain case-folded paths.
 */
export class PathSet implements ReadonlySet<string> {
  private readonly spellings = new Map<string, string>();

  constructor(paths: Iterable<string> = []) {
    for (const path of paths) this.add(path);
  }

  get size(): number {
    return this.spellings.size;
  }

  has(path: string): boolean {
    return this.spellings.has(pathKey(path));
  }

  add(path: string): this {
    const key = pathKey(path);
    if (!this.spellings.has(key)) this.spellings.set(key, path);
    return this;
  }

  delete(path: string): boolean {
    return this.spellings.delete(pathKey(path));
  }

  clear(): void {
    this.spellings.clear();
  }

  forEach(callback: (value: string, value2: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
    for (const path of this.spellings.values()) callback.call(thisArg, path, path, this);
  }

  values(): SetIterator<string> {
    return this.spellings.values();
  }

  keys(): SetIterator<string> {
    return this.spellings.values();
  }

  entries(): SetIterator<[string, string]> {
    return new Set(this.spellings.values()).entries();
  }

  [Symbol.iterator](): SetIterator<string> {
    return this.spellings.values();
  }
}
