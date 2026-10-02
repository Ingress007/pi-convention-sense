import { dirname, relative, resolve, sep } from "node:path";
import { foldPathCase, pathKey, samePath } from "../runtime/path-key.js";
import type { LoadedProjectProfile } from "../profile/profile-loader.js";
import { applyProjectProfileToScope, effectiveScopeRole } from "../profile/profiled-scope.js";
import type { ConventionPack } from "../profile/types.js";
import { analyzeJavaFile, detectJavaRole, detectSourceKind } from "./java-analyzer.js";
import { detectConventionScope } from "./scope-detector.js";
import type {
  CandidateScoreBreakdown,
  ConventionScope,
  JavaFileFacts,
  RankedCandidate,
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

function samePackageOrSibling(target: JavaFileFacts, candidate: JavaFileFacts): number {
  if (target.packageName && candidate.packageName && target.packageName === candidate.packageName) return 1;
  return samePath(dirname(target.path), dirname(candidate.path)) ? 1 : 0;
}

function determineLevel(
  targetPath: string,
  targetScope: ConventionScope,
  candidatePath: string,
  candidateScope: ConventionScope,
): 0 | 1 | 2 | 3 {
  if (samePath(dirname(targetPath), dirname(candidatePath))) return 0;
  if (targetScope.module === candidateScope.module) return 1;
  if (samePath(dirname(targetScope.root), dirname(candidateScope.root))) return 2;
  return 3;
}

function preliminaryScore(path: string, targetPath: string, targetScope: ConventionScope): number {
  let score = 30;
  if (samePath(dirname(path), dirname(targetPath))) score += 40;
  const rel = relative(targetScope.root, path);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..")) score += 25;
  const targetParentName = dirname(targetPath).split(sep).at(-1);
  if (targetParentName && foldPathCase(dirname(path)).split(sep).includes(foldPathCase(targetParentName))) score += 10;
  return score;
}

function scoreCandidate(
  target: JavaFileFacts,
  targetScope: ConventionScope,
  candidate: JavaFileFacts,
  candidateScope: ConventionScope,
): { score: number; breakdown: CandidateScoreBreakdown } {
  const sameRole = target.role === candidate.role ? 30 : 0;
  const sameModule = targetScope.module === candidateScope.module ? 25 : 0;
  const samePackage = 15 * samePackageOrSibling(target, candidate);
  const annotationSimilarity = 10 * jaccard(target.annotations, candidate.annotations);
  const inheritanceSimilarity = 8 * jaccard(target.superTypes, candidate.superTypes);
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
    samePackageOrSibling: samePackage,
    annotationSimilarity,
    interfaceOrSuperclassSimilarity: inheritanceSimilarity,
    nameSimilarity: 0,
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

export interface RankCandidatesResult {
  candidates: RankedCandidate[];
  consideredCount: number;
  parseFailureCount: number;
}

export function rankJavaCandidates(options: {
  repositoryRoot: string;
  targetPath: string;
  targetFacts: JavaFileFacts;
  targetScope: ConventionScope;
  indexedFiles: readonly string[];
  maxCandidates: number;
  deepAnalysisLimit?: number;
  loadedProfile?: LoadedProjectProfile;
  availablePacks?: readonly ConventionPack[];
}): RankCandidatesResult {
  const target = resolve(options.targetPath);
  const targetSourceKind = options.targetFacts.sourceKind;
  const prelim = options.indexedFiles
    .filter((path) => pathKey(path) !== pathKey(target))
    .filter((path) => detectJavaRole(path, "", options.repositoryRoot).role === options.targetFacts.role)
    .filter(
      (path) => targetSourceKind !== "production" || detectSourceKind(path, options.repositoryRoot) !== "test",
    )
    .map((path) => ({ path, score: preliminaryScore(path, target, options.targetScope) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const ranked: RankedCandidate[] = [];
  let parseFailureCount = 0;
  const deepAnalysisLimit = options.deepAnalysisLimit ?? (options.targetScope.effectiveRole ? 60 : 20);
  for (const preliminary of prelim.slice(0, deepAnalysisLimit)) {
    try {
      const facts = analyzeJavaFile(preliminary.path, options.repositoryRoot);
      if (facts.generated || facts.role !== options.targetFacts.role) continue;
      if (
        options.targetFacts.role === "service-interface" &&
        options.targetFacts.declarationKind &&
        facts.declarationKind &&
        facts.declarationKind !== options.targetFacts.declarationKind
      ) continue;
      const baseScope = detectConventionScope(preliminary.path, options.repositoryRoot, facts);
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

  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    candidates: ranked.slice(0, Math.max(0, options.maxCandidates)),
    consideredCount: prelim.length,
    parseFailureCount,
  };
}
