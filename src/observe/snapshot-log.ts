// The metadata logged when Observe builds or skips a Snapshot. Paths, counts, scores and reason codes only: never source
// text. Kept out of the extension so the shape of what is logged can be tested on its own.
import type { LoadedProjectProfile } from "../profile/profile-loader.js";
import { displayPath } from "../runtime/paths.js";
import { scopeKey } from "./scope-detector.js";
import type { AnalyzeTargetResult, ConventionSnapshot } from "./types.js";

export type SnapshotTrigger = "read" | "restore" | "freshness" | "guard-preflight";

export function snapshotCreatedPayload(input: {
  trigger: SnapshotTrigger;
  snapshot: ConventionSnapshot;
  result: Pick<AnalyzeTargetResult, "indexedFileCount" | "consideredCandidateCount" | "durationMs">;
  loadedProfile: Pick<LoadedProjectProfile, "status" | "fingerprint" | "diagnostics">;
  explainRanking: boolean;
  cwd: string;
}): Record<string, unknown> {
  const { snapshot, result, loadedProfile, cwd } = input;
  return {
    trigger: input.trigger,
    targetPath: displayPath(cwd, snapshot.targetPath),
    targetKind: snapshot.targetKind,
    repositoryRoot: displayPath(cwd, snapshot.repositoryRoot),
    scope: scopeKey(snapshot.scope),
    baseRole: snapshot.scope.role,
    effectiveRole: snapshot.scope.effectiveRole,
    profileStatus: loadedProfile.status,
    profileFingerprint: loadedProfile.fingerprint,
    profileDiagnostics: loadedProfile.diagnostics,
    scopeConfidence: snapshot.scope.confidence,
    status: snapshot.status,
    indexedFileCount: result.indexedFileCount,
    consideredCandidateCount: result.consideredCandidateCount,
    durationMs: result.durationMs,
    tokenEstimate: snapshot.tokenEstimate,
    candidateCount: snapshot.candidates.length,
    candidates: input.explainRanking
      ? snapshot.candidates.map((candidate) => ({
          path: displayPath(cwd, candidate.path),
          score: candidate.score,
          level: candidate.level,
          breakdown: candidate.breakdown,
        }))
      : snapshot.candidates.map((candidate) => displayPath(cwd, candidate.path)),
    observations: snapshot.observations.map((observation) => ({
      category: observation.category,
      pattern: observation.pattern,
      support: observation.support,
      samples: observation.samples,
      confidence: observation.confidence,
      status: observation.status,
    })),
  };
}

export function snapshotSkippedPayload(input: {
  trigger: SnapshotTrigger;
  targetPath: string;
  result: AnalyzeTargetResult;
  cwd: string;
}): Record<string, unknown> {
  const { result } = input;
  return {
    trigger: input.trigger,
    targetPath: displayPath(input.cwd, input.targetPath),
    reason: result.reason,
    errorName: result.errorName,
    errorCode: result.errorCode,
    errorLocation: result.errorLocation,
    durationMs: result.durationMs,
    indexedFileCount: result.indexedFileCount,
    consideredCandidateCount: result.consideredCandidateCount,
  };
}
