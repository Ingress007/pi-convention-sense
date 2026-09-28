import { formatConventionSnapshot, estimateTokens } from "../observe/snapshot-formatter.js";
import type { ConventionSnapshot } from "../observe/types.js";
import { formatKnowledgeCapsule } from "../profile/capsule-formatter.js";
import { formatPracticeCapsule } from "../practice/capsule-formatter.js";
import type { PracticeAnalysisResult } from "../practice/types.js";
import { SPIKE_CONTEXT_TYPE, type SpikeConfig, type SpikeRuntimeState } from "./types.js";

export const STABLE_GUIDANCE_MARKER = "<!-- pi-convention-sense:v1-observe -->";

export const STABLE_GUIDANCE = `${STABLE_GUIDANCE_MARKER}
## Local Convention Evidence

- Prefer repeated conventions demonstrated by nearby relevant production code.
- Inspect equivalent implementations before introducing a new local pattern.
- Treat inferred conventions as preferences, never as overrides for explicit requirements or executable checks.
- Avoid unrelated refactors made only for stylistic consistency.
- If local evidence is weak or mixed, preserve uncertainty instead of inventing a rule.`;

export const STABLE_GUIDANCE_SECTION = "pi-convention-sense";

export function applyStableGuidanceSection(sections: Record<string, string>): void {
  const current = sections[STABLE_GUIDANCE_SECTION];
  if (current?.includes(STABLE_GUIDANCE_MARKER)) return;
  sections[STABLE_GUIDANCE_SECTION] = current
    ? `${current}\n\n${STABLE_GUIDANCE}`
    : STABLE_GUIDANCE;
}

export interface DynamicContextBuildResult {
  content: string;
  includedSnapshots: ConventionSnapshot[];
  includedKnowledgeIds: string[];
  includedConventionIds: string[];
  includedPracticeSignalIds: string[];
}

export function buildDynamicContextResult(
  config: SpikeConfig,
  state: SpikeRuntimeState,
  snapshots: readonly ConventionSnapshot[] = [],
  repositoryRoot = process.cwd(),
  practiceAnalyses: readonly PracticeAnalysisResult[] = [],
): DynamicContextBuildResult {
  const blocks: string[] = [];
  const includedSnapshots: ConventionSnapshot[] = [];
  const includedKnowledgeIds: string[] = [];
  const includedConventionIds: string[] = [];
  let includedPracticeSignalIds: string[] = [];
  let remaining = config.maxContextTokens;

  if (snapshots.length === 0) {
    const unavailable = [
      `<local-convention status="unavailable" mode="${config.mode}">`,
      "No valid convention snapshot is available for the active branch.",
      `Successful reads on active branch: ${state.successfulReads.size}`,
      `Pending reads not usable as evidence: ${state.pendingReads.size}`,
      practiceAnalyses.some((analysis) => analysis.basis === "successful-read")
        ? "Any Engineering Practice block below is target-only and does not provide Scope or peer evidence."
        : "Read the target and relevant peer implementations before changing existing code.",
      "Do not infer a convention from this message.",
      "</local-convention>",
    ].join("\n");
    blocks.push(unavailable);
    remaining -= estimateTokens(unavailable);
  } else {
    const primaryProjectContext = snapshots.find((snapshot) => snapshot.projectContext)?.projectContext;
    if (primaryProjectContext) {
      const capsuleBudget = Math.min(300, Math.max(100, Math.floor(config.maxContextTokens * 0.25)));
      const capsule = formatKnowledgeCapsule(primaryProjectContext, repositoryRoot, capsuleBudget);
      if (capsule.tokenEstimate <= capsuleBudget && remaining - capsule.tokenEstimate >= 100) {
        blocks.push(capsule.text);
        includedKnowledgeIds.push(...capsule.includedKnowledgeIds);
        includedConventionIds.push(...capsule.includedConventionIds);
        remaining -= capsule.tokenEstimate;
      }
    }

    for (const snapshot of snapshots) {
      const separatorTokens = blocks.length > 0 ? estimateTokens("\n\n") : 0;
      const available = remaining - separatorTokens;
      if (available <= 0) break;
      const formatted = formatConventionSnapshot(snapshot, repositoryRoot, available);
      if (formatted.tokenEstimate > available) continue;
      blocks.push(formatted.text);
      includedSnapshots.push(snapshot);
      remaining -= formatted.tokenEstimate + separatorTokens;
    }

    if (includedSnapshots.length === 0) {
      return {
        content: `<local-convention status="budget-exhausted">No Snapshot fit the ${config.maxContextTokens}-token budget.</local-convention>`,
        includedSnapshots: [],
        includedKnowledgeIds: [],
        includedConventionIds: [],
        includedPracticeSignalIds: [],
      };
    }
  }

  if (config.practiceReview.mode === "suggest" && practiceAnalyses.length > 0) {
    const includedTargetPaths = new Set(includedSnapshots.map((snapshot) => snapshot.targetPath));
    const relevantAnalyses = practiceAnalyses.filter((analysis) =>
      analysis.basis === "successful-read" || includedTargetPaths.has(analysis.targetPath),
    );
    const separatorTokens = blocks.length > 0 ? estimateTokens("\n\n") : 0;
    const available = Math.min(config.practiceReview.maxContextTokens, remaining - separatorTokens);
    const capsule = formatPracticeCapsule(relevantAnalyses, available);
    if (capsule && capsule.tokenEstimate <= available) {
      blocks.push(capsule.text);
      includedPracticeSignalIds = capsule.includedSignalIds;
    }
  }

  return {
    content: blocks.join("\n\n"),
    includedSnapshots,
    includedKnowledgeIds,
    includedConventionIds,
    includedPracticeSignalIds,
  };
}

export function buildDynamicContext(
  config: SpikeConfig,
  state: SpikeRuntimeState,
  snapshots: readonly ConventionSnapshot[] = [],
  repositoryRoot = process.cwd(),
  practiceAnalyses: readonly PracticeAnalysisResult[] = [],
): string {
  return buildDynamicContextResult(config, state, snapshots, repositoryRoot, practiceAnalyses).content;
}

export function createDynamicContextMessage(
  config: SpikeConfig,
  state: SpikeRuntimeState,
  snapshots: readonly ConventionSnapshot[] = [],
  repositoryRoot = process.cwd(),
  practiceAnalyses: readonly PracticeAnalysisResult[] = [],
) {
  const built = buildDynamicContextResult(config, state, snapshots, repositoryRoot, practiceAnalyses);
  return {
    role: "custom" as const,
    customType: SPIKE_CONTEXT_TYPE,
    content: built.content,
    display: false,
    details: {
      stage: 2,
      mode: config.mode,
      successfulReadCount: state.successfulReads.size,
      pendingReadCount: state.pendingReads.size,
      snapshotCount: snapshots.length,
      tokenEstimate: estimateTokens(built.content),
      scopes: built.includedSnapshots.map(
        (snapshot) =>
          `${snapshot.scope.language}:${snapshot.scope.module}:${snapshot.scope.effectiveRole ?? snapshot.scope.role}`,
      ),
      includedKnowledgeIds: built.includedKnowledgeIds,
      includedConventionIds: built.includedConventionIds,
      includedPracticeSignalIds: built.includedPracticeSignalIds,
      includedSnapshots: built.includedSnapshots.map((snapshot) => ({
        targetPath: snapshot.targetPath,
        createdAt: snapshot.createdAt,
      })),
    },
    timestamp: Date.now(),
  };
}
