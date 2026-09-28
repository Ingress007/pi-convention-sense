import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import type { LoadedProjectProfile } from "../profile/profile-loader.js";
import { applyProjectProfileToScope, effectiveScopeRole } from "../profile/profiled-scope.js";
import type { ConventionPack } from "../profile/types.js";
import type { RankCandidatesResult } from "./candidate-ranker.js";
import {
  analyzeTypeScriptFile,
  detectTypeScriptLanguage,
  detectTypeScriptRole,
  detectTypeScriptSourceKind,
} from "./typescript-analyzer.js";
import { detectTypeScriptScope } from "./typescript-scope-detector.js";
import type {
  CandidateScoreBreakdown,
  ConventionScope,
  TypeScriptFileFacts,
} from "./types.js";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function jaccard(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function semanticFileSuffix(path: string): string | undefined {
  const name = basename(path, extname(path))
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
  const suffix = name.split(/[^a-z0-9]+/).filter(Boolean).at(-1);
  return suffix && !["index", "main", "shared", "type", "types", "utils"].includes(suffix)
    ? suffix
    : undefined;
}

function sameSemanticFileSuffix(left: string, right: string): boolean {
  const leftSuffix = semanticFileSuffix(left);
  return leftSuffix !== undefined && leftSuffix === semanticFileSuffix(right);
}

function determineLevel(
  targetPath: string,
  targetScope: ConventionScope,
  candidatePath: string,
  candidateScope: ConventionScope,
): 0 | 1 | 2 | 3 {
  if (dirname(targetPath) === dirname(candidatePath)) return 0;
  if (targetScope.module === candidateScope.module) return 1;
  if (dirname(targetScope.root) === dirname(candidateScope.root)) return 2;
  return 3;
}

function preliminaryScore(path: string, targetPath: string, targetScope: ConventionScope): number {
  let score = 30;
  if (sameSemanticFileSuffix(path, targetPath)) score += 50;
  if (dirname(path) === dirname(targetPath)) score += 40;
  const rel = relative(targetScope.root, path);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..")) score += 30;
  const targetParentName = dirname(targetPath).split(sep).at(-1);
  if (targetParentName && dirname(path).split(sep).includes(targetParentName)) score += 10;
  return score;
}

function scoreCandidate(
  target: TypeScriptFileFacts,
  targetScope: ConventionScope,
  candidate: TypeScriptFileFacts,
  candidateScope: ConventionScope,
): { score: number; breakdown: CandidateScoreBreakdown } {
  const sameRole = target.role === candidate.role ? 30 : 0;
  const sameModule = targetScope.module === candidateScope.module ? 25 : 0;
  const sameDirectory = dirname(target.path) === dirname(candidate.path) ? 15 : 0;
  const primitiveSimilarity = 10 * jaccard(target.frameworkPrimitives, candidate.frameworkPrimitives);
  const exportSimilarity = 8 * jaccard(target.exportNames, candidate.exportNames);
  const nameSimilarity = sameSemanticFileSuffix(target.path, candidate.path) ? 20 : 0;
  const importJaccard = 7 * jaccard(target.imports, candidate.imports);
  const recentlyMaintained = 3 / (1 + Math.abs(target.mtimeMs - candidate.mtimeMs) / YEAR_MS);
  const sizeSimilarity = target.size === 0 && candidate.size === 0
    ? 2
    : 2 * (Math.min(target.size, candidate.size) / Math.max(target.size, candidate.size, 1));
  const generatedOrDeprecatedPenalty = candidate.generated || candidate.deprecated ? -20 : 0;
  const testOnlyPenalty = target.sourceKind !== "test" && candidate.sourceKind === "test" ? -15 : 0;
  const breakdown: CandidateScoreBreakdown = {
    sameRole,
    sameModule,
    samePackageOrSibling: sameDirectory,
    annotationSimilarity: primitiveSimilarity,
    interfaceOrSuperclassSimilarity: exportSimilarity,
    nameSimilarity,
    importJaccard,
    recentlyMaintained,
    sizeSimilarity,
    generatedOrDeprecatedPenalty,
    testOnlyPenalty,
  };
  return {
    score: Object.values(breakdown).reduce((total, value) => total + value, 0),
    breakdown,
  };
}

export function rankTypeScriptCandidates(options: {
  repositoryRoot: string;
  targetPath: string;
  targetFacts: TypeScriptFileFacts;
  targetScope: ConventionScope;
  indexedFiles: readonly string[];
  maxCandidates: number;
  deepAnalysisLimit?: number;
  loadedProfile?: LoadedProjectProfile;
  availablePacks?: readonly ConventionPack[];
}): RankCandidatesResult {
  const target = resolve(options.targetPath);
  const prelim = options.indexedFiles
    .filter((path) => resolve(path) !== target)
    .filter((path) => detectTypeScriptLanguage(path) === options.targetFacts.language)
    .filter((path) => detectTypeScriptRole(path).role === options.targetFacts.role)
    .filter(
      (path) =>
        options.targetFacts.sourceKind !== "production" || detectTypeScriptSourceKind(path) !== "test",
    )
    .map((path) => ({ path, score: preliminaryScore(path, target, options.targetScope) }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  const ranked: RankCandidatesResult["candidates"] = [];
  let parseFailureCount = 0;
  const deepAnalysisLimit = options.deepAnalysisLimit ?? (options.targetScope.effectiveRole ? 80 : 40);
  for (const preliminary of prelim.slice(0, deepAnalysisLimit)) {
    try {
      const facts = analyzeTypeScriptFile(preliminary.path);
      if (
        facts.generated ||
        facts.language !== options.targetFacts.language ||
        facts.role !== options.targetFacts.role
      ) continue;
      const baseScope = detectTypeScriptScope(preliminary.path, options.repositoryRoot, facts);
      const scope = applyProjectProfileToScope(
        baseScope,
        preliminary.path,
        options.repositoryRoot,
        facts,
        options.loadedProfile,
        options.availablePacks,
      ).scope;
      if (effectiveScopeRole(scope) !== effectiveScopeRole(options.targetScope)) continue;
      const scored = scoreCandidate(options.targetFacts, options.targetScope, facts, scope);
      ranked.push({
        path: preliminary.path,
        score: Math.round(scored.score * 100) / 100,
        level: determineLevel(target, options.targetScope, preliminary.path, scope),
        breakdown: scored.breakdown,
        facts,
        scope,
      });
    } catch {
      parseFailureCount += 1;
    }
  }

  ranked.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const sameModule = ranked.filter((candidate) => candidate.scope.module === options.targetScope.module);
  const bounded = sameModule.length > 0 ? sameModule : ranked;
  return {
    candidates: bounded.slice(0, Math.max(0, options.maxCandidates)),
    consideredCount: prelim.length,
    parseFailureCount,
  };
}
