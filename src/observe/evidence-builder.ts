import { createHash } from "node:crypto";
import type {
  ConventionObservation,
  ConventionScope,
  EvidenceRef,
  ObservationConfidence,
  RankedCandidate,
  SnapshotStatus,
} from "./types.js";

function evidenceRef(candidate: RankedCandidate): EvidenceRef {
  return {
    path: candidate.path,
    mtimeMs: candidate.facts.mtimeMs,
    size: candidate.facts.size,
    contentHash: candidate.facts.contentHash,
    score: candidate.score,
  };
}

function observationId(category: string, pattern: string): string {
  return createHash("sha1").update(`${category}\0${pattern}`).digest("hex").slice(0, 12);
}

const EXCLUSIVE_SIGNAL_CATEGORIES = new Set([
  "dependency-injection",
  "logging-framework",
  "logging-style",
  "component-style",
  "props-style",
  "emits-style",
  "style-scope",
  "store-style",
  "request-style",
  "api-export-style",
  "route-loading",
  "router-history",
]);

function confidenceFor(
  support: number,
  samples: number,
  scope: ConventionScope,
): ObservationConfidence {
  const rate = samples === 0 ? 0 : support / samples;
  if (support >= 3 && rate >= 0.8 && scope.confidence === "high") return "high";
  if (support >= 2 && rate >= 0.6) return "medium";
  return "low";
}

export interface EvidenceBuildResult {
  observations: ConventionObservation[];
  evidenceFiles: EvidenceRef[];
  status: SnapshotStatus;
}

export function buildConventionEvidence(
  scope: ConventionScope,
  candidates: readonly RankedCandidate[],
  minEvidenceFiles: number,
): EvidenceBuildResult {
  const evidenceFiles = candidates.map(evidenceRef);
  const categories = new Map<string, RankedCandidate[]>();

  for (const candidate of candidates) {
    for (const [category, patterns] of Object.entries(candidate.facts.signals)) {
      if (patterns.length === 0) continue;
      const sampleFiles = categories.get(category) ?? [];
      sampleFiles.push(candidate);
      categories.set(category, sampleFiles);
    }
  }

  const observations: ConventionObservation[] = [];
  for (const [category, sampleFiles] of categories) {
    const supportByPattern = new Map<string, RankedCandidate[]>();
    for (const candidate of sampleFiles) {
      for (const pattern of candidate.facts.signals[category] ?? []) {
        const supporting = supportByPattern.get(pattern) ?? [];
        supporting.push(candidate);
        supportByPattern.set(pattern, supporting);
      }
    }

    const sortedPatterns = [...supportByPattern.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    );
    const topSupport = sortedPatterns[0]?.[1].length ?? 0;
    const secondSupport = sortedPatterns[1]?.[1].length ?? 0;
    const samples = sampleFiles.length;
    const categoryMixed =
      EXCLUSIVE_SIGNAL_CATEGORIES.has(category) &&
      samples > 0 &&
      (topSupport / samples < 0.6 || (secondSupport / samples >= 0.4 && secondSupport >= topSupport - 1));

    for (const [pattern, supporting] of sortedPatterns) {
      const supportingPaths = new Set(supporting.map((candidate) => candidate.path));
      const counter = sampleFiles.filter((candidate) => !supportingPaths.has(candidate.path));
      const supportRate = samples === 0 ? 0 : supporting.length / samples;
      const status = categoryMixed || supportRate < 0.6 ? "mixed" : "dominant";
      observations.push({
        id: observationId(category, pattern),
        category,
        pattern,
        support: supporting.length,
        samples,
        confidence: confidenceFor(supporting.length, samples, scope),
        status,
        evidence: supporting.map(evidenceRef),
        counterEvidence: counter.map(evidenceRef),
      });
    }
  }

  const confidenceOrder = { high: 0, medium: 1, low: 2 } as const;
  observations.sort(
    (a, b) =>
      confidenceOrder[a.confidence] - confidenceOrder[b.confidence] ||
      (a.status === b.status ? 0 : a.status === "dominant" ? -1 : 1) ||
      b.support - a.support ||
      a.category.localeCompare(b.category) ||
      a.pattern.localeCompare(b.pattern),
  );

  const hasUsableObservation = observations.some(
    (observation) => observation.confidence !== "low" && observation.status === "dominant",
  );
  const status: SnapshotStatus =
    candidates.length >= minEvidenceFiles && hasUsableObservation ? "valid" : "weak";

  return { observations, evidenceFiles, status };
}

export function createConfigFingerprint(
  config: {
    minEvidenceFiles: number;
    maxEvidenceFiles: number;
    maxContextTokens: number;
    exclude: readonly string[];
  },
  profileFingerprint?: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        minEvidenceFiles: config.minEvidenceFiles,
        maxEvidenceFiles: config.maxEvidenceFiles,
        maxContextTokens: config.maxContextTokens,
        exclude: [...config.exclude].sort(),
        profileFingerprint: profileFingerprint ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}
