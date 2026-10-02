import { Minimatch } from "minimatch";

export interface GlobOptions {
  dot?: boolean;
  nocase?: boolean;
}

// Patterns come from config and Profile files, so the set is small; the cap is only a safety net.
const MAX_CACHED_MATCHERS = 500;
// Minimatch throws on patterns past 64 KiB and compiles each path segment to a regular expression whose cost grows
// exponentially with the number of `*` runs (`*a*a*a*a*a*a*a*b` needs seconds on a 60-character name). Real patterns
// stay far below these limits; anything above them is refused instead of being allowed to freeze the agent.
const MAX_PATTERN_LENGTH = 512;
const MAX_STAR_RUNS_PER_SEGMENT = 5;
const MAX_EXTGLOB_GROUPS_PER_SEGMENT = 3;

const matchers = new Map<string, Minimatch | undefined>();

export function isSupportedGlob(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) return false;
  return pattern.split("/").every(
    (segment) =>
      (segment.match(/\*+/g)?.length ?? 0) <= MAX_STAR_RUNS_PER_SEGMENT &&
      (segment.match(/[*+?@!]\(/g)?.length ?? 0) <= MAX_EXTGLOB_GROUPS_PER_SEGMENT,
  );
}

function compile(pattern: string, options: GlobOptions): Minimatch | undefined {
  if (!isSupportedGlob(pattern)) return undefined;
  try {
    return new Minimatch(pattern, { dot: options.dot === true, nocase: options.nocase === true });
  } catch {
    return undefined;
  }
}

/**
 * Compiling a glob is far more expensive than matching it, and the same few patterns are matched for every file.
 * Returns `undefined` for a pattern that is unsupported or does not compile, so callers treat it as never matching.
 */
export function compiledMatcher(pattern: string, options: GlobOptions = {}): Minimatch | undefined {
  const key = `${options.dot ? "d" : "-"}${options.nocase ? "i" : "-"}:${pattern}`;
  if (matchers.has(key)) return matchers.get(key);
  if (matchers.size >= MAX_CACHED_MATCHERS) matchers.clear();
  const matcher = compile(pattern, options);
  matchers.set(key, matcher);
  return matcher;
}

export function globMatches(value: string, pattern: string, options: GlobOptions = {}): boolean {
  return compiledMatcher(pattern, options)?.match(value) ?? false;
}
