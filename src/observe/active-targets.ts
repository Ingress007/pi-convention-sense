// Which targets are "active" for the next model request, and which of them still need attention. These are the
// decisions that used to live inside the extension's closures; they take plain values so they can be tested alone.
import { PathSet, pathKey } from "../runtime/path-key.js";
import type { AnalyzeTargetResult, ConventionSnapshot, ObserveLanguage } from "./types.js";

/** At most this many Snapshots (and Practice analyses) go into one model request. */
export const MAX_ACTIVE_SNAPSHOTS = 4;
/** At most this many candidate paths are considered when choosing the active Snapshots. */
export const MAX_ACTIVE_PATHS = 20;

/**
 * Remember an edit/write target the Guard was asked about, newest last. A path is listed once (its latest request
 * wins) and only the newest `limit` entries are kept.
 */
export function rememberRequestedTarget(requested: readonly string[], targetPath: string, limit = MAX_ACTIVE_SNAPSHOTS): string[] {
  const key = pathKey(targetPath);
  const next = [...requested.filter((path) => pathKey(path) !== key), targetPath];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export interface ActiveTargetInput {
  /** Targets the Guard was asked about, oldest first. */
  requested: readonly string[];
  /** Successful reads, oldest first. */
  recentReads: ReadonlyArray<{ path: string }>;
  /** Whether the path's language is enabled. */
  isSupported(path: string): boolean;
  limit?: number;
}

/** Most recently touched first: Guard targets, then the newest reads; unsupported and duplicate paths are dropped. */
export function selectActiveTargetPaths(input: ActiveTargetInput): string[] {
  const limit = input.limit ?? MAX_ACTIVE_PATHS;
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (path: string): void => {
    if (paths.length >= limit || !input.isSupported(path) || seen.has(pathKey(path))) return;
    seen.add(pathKey(path));
    paths.push(path);
  };
  for (let index = input.requested.length - 1; index >= 0; index -= 1) {
    const path = input.requested[index];
    if (path) add(path);
  }
  for (let index = input.recentReads.length - 1; index >= 0; index -= 1) {
    const record = input.recentReads[index];
    if (record) add(record.path);
    if (paths.length >= limit) break;
  }
  return paths;
}

export interface CoveredTargetInput {
  /** Whether the target's own file has been read successfully. */
  isRead(path: string): boolean;
  /** Whether the Snapshot has been shown to the model recently enough for the Guard. */
  isInjected(snapshot: ConventionSnapshot): boolean;
}

/**
 * Targets whose Discovery is complete, taken before a shell command runs: a changed file that was not covered then is
 * an evidence gap afterwards. A weak Snapshot counts as covered (the Guard does not enforce uncertain evidence).
 */
export function selectCoveredTargets(freshSnapshots: Iterable<ConventionSnapshot>, input: CoveredTargetInput): PathSet {
  const covered = new PathSet();
  for (const snapshot of freshSnapshots) {
    const targetReady = snapshot.targetKind === "prospective" || input.isRead(snapshot.targetPath);
    if (!targetReady) continue;
    if (snapshot.status === "weak" || input.isInjected(snapshot)) covered.add(snapshot.targetPath);
  }
  return covered;
}

export interface PracticeFallbackTarget {
  path: string;
  repositoryRoot: string;
  language: ObserveLanguage;
}

export interface PracticeFallbackInput {
  activePaths: readonly string[];
  /** Targets that already have a Snapshot (and therefore a normal Practice analysis). */
  snapshotTargets: PathSet;
  /** Why Observe produced no Snapshot for a path, by `pathKey`. */
  analysisReasons: ReadonlyMap<string, AnalyzeTargetResult["reason"]>;
  isRead(path: string): boolean;
  exists(path: string): boolean;
  /** The language and repository root when `path` is a configured, non-excluded production source. */
  eligibility(path: string): { repositoryRoot: string; language: ObserveLanguage } | undefined;
  /** How many more analyses fit into the request. */
  slots: number;
}

/**
 * The bounded Practice-only fallback: targets Observe could not scope (`scope-unknown`) but that were read
 * successfully, still exist, and are production sources. It never invents a Snapshot or peer evidence.
 */
export function selectPracticeFallbackTargets(input: PracticeFallbackInput): PracticeFallbackTarget[] {
  const targets: PracticeFallbackTarget[] = [];
  for (const path of input.activePaths) {
    if (targets.length >= input.slots) break;
    if (
      input.snapshotTargets.has(path) ||
      input.analysisReasons.get(pathKey(path)) !== "scope-unknown" ||
      !input.isRead(path) ||
      !input.exists(path)
    ) continue;
    const eligible = input.eligibility(path);
    if (eligible) targets.push({ path, ...eligible });
  }
  return targets;
}
