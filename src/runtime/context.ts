import { formatConventionSnapshot, estimateTokens } from "../observe/snapshot-formatter.js";
import type { ConventionSnapshot } from "../observe/types.js";
import { formatKnowledgeCapsule } from "../profile/capsule-formatter.js";
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
}

export function buildDynamicContextResult(
  config: SpikeConfig,
  state: SpikeRuntimeState,
  snapshots: readonly ConventionSnapshot[] = [],
  repositoryRoot = process.cwd(),
): DynamicContextBuildResult {
  if (snapshots.length === 0) {
    return {
      content: [
        `<local-convention status="unavailable" mode="${config.mode}">`,
        "No valid convention snapshot is available for the active branch.",
        `Successful reads on active branch: ${state.successfulReads.size}`,
        `Pending reads not usable as evidence: ${state.pendingReads.size}`,
        "Read the target and relevant peer implementations before changing existing code.",
        "Do not infer a convention from this message.",
        "</local-convention>",
      ].join("\n"),
      includedSnapshots: [],
      includedKnowledgeIds: [],
      includedConventionIds: [],
    };
  }

  const blocks: string[] = [];
  const includedSnapshots: ConventionSnapshot[] = [];
  const includedKnowledgeIds: string[] = [];
  const includedConventionIds: string[] = [];
  let remaining = config.maxContextTokens;

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
    };
  }
  return {
    content: blocks.join("\n\n"),
    includedSnapshots,
    includedKnowledgeIds,
    includedConventionIds,
  };
}

export function buildDynamicContext(
  config: SpikeConfig,
  state: SpikeRuntimeState,
  snapshots: readonly ConventionSnapshot[] = [],
  repositoryRoot = process.cwd(),
): string {
  return buildDynamicContextResult(config, state, snapshots, repositoryRoot).content;
}

export function createDynamicContextMessage(
  config: SpikeConfig,
  state: SpikeRuntimeState,
  snapshots: readonly ConventionSnapshot[] = [],
  repositoryRoot = process.cwd(),
) {
  const built = buildDynamicContextResult(config, state, snapshots, repositoryRoot);
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
      includedSnapshots: built.includedSnapshots.map((snapshot) => ({
        targetPath: snapshot.targetPath,
        createdAt: snapshot.createdAt,
      })),
    },
    timestamp: Date.now(),
  };
}
