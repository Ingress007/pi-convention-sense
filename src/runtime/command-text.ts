// What the /convention-* commands say and complete. Plain functions over plain values: the extension only supplies the
// current state and shows the returned text.
import type { LoadedProjectProfile } from "../profile/profile-loader.js";
import { scopeKey } from "../observe/scope-detector.js";
import type { ConventionSnapshot } from "../observe/types.js";
import { displayPath } from "./paths.js";
import { pathKey } from "./path-key.js";
import type { GuardAction, SpikeConfig } from "./types.js";

/** One Guard (or Observe shadow) verdict on an edit/write target; paths only, never file contents. */
export interface GuardDecisionRecord {
  toolName: string;
  targetPath: string;
  action: GuardAction;
  reasonCode: string;
}

const MAX_REMEMBERED_DECISIONS = 8;

/** Newest last; a target appears once, with its latest verdict. */
export function rememberGuardDecision(
  decisions: readonly GuardDecisionRecord[],
  decision: GuardDecisionRecord,
  limit = MAX_REMEMBERED_DECISIONS,
): GuardDecisionRecord[] {
  const key = pathKey(decision.targetPath);
  const next = [...decisions.filter((item) => pathKey(item.targetPath) !== key), decision];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function formatLastGuardDecision(decisions: readonly GuardDecisionRecord[], cwd: string): string {
  const last = decisions.at(-1);
  if (!last) return "last-guard=none";
  return `last-guard=${last.action} ${last.reasonCode} (${last.toolName}) ${displayPath(cwd, last.targetPath)}`;
}

export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

/** Paths for `/convention-bypass <path>`: the targets the Guard was asked about, newest first, filtered by `prefix`. */
export function bypassCompletions(input: {
  decisions: readonly GuardDecisionRecord[];
  cwd: string;
  prefix: string;
  limit?: number;
}): CompletionItem[] | null {
  const wanted = input.prefix.trim().toLowerCase();
  const items: CompletionItem[] = [];
  for (let index = input.decisions.length - 1; index >= 0; index -= 1) {
    const decision = input.decisions[index];
    if (!decision) continue;
    const path = displayPath(input.cwd, decision.targetPath);
    if (wanted && !path.toLowerCase().includes(wanted)) continue;
    items.push({ value: path, label: path, description: `${decision.action} ${decision.reasonCode}` });
    if (items.length >= (input.limit ?? MAX_REMEMBERED_DECISIONS)) break;
  }
  return items.length > 0 ? items : null;
}

/** The path given to `/convention-snapshot`: trimmed, and without the `@` file-mention prefix Pi's editor adds. */
export function snapshotCommandTarget(args: string): string {
  const trimmed = args.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
}

export function formatSnapshotSummary(snapshot: ConventionSnapshot, cwd: string): string {
  return [
    `scope=${scopeKey(snapshot.scope)}`,
    `status=${snapshot.status}, confidence=${snapshot.scope.confidence}, targetKind=${snapshot.targetKind}`,
    `repository=${displayPath(cwd, snapshot.repositoryRoot)}`,
    `target=${displayPath(snapshot.repositoryRoot, snapshot.targetPath)}`,
    `peers=${snapshot.evidenceFiles.map((item) => displayPath(snapshot.repositoryRoot, item.path)).join(", ") || "none"}`,
    `observations=${snapshot.observations.length}, tokens≈${snapshot.tokenEstimate}`,
  ].join("\n");
}

export interface ProjectStatusInput {
  config: Pick<SpikeConfig, "includeLanguages" | "practiceReview">;
  usedProjectConfig: boolean;
  projectTrusted: boolean;
  profile: Pick<LoadedProjectProfile, "status" | "profile" | "fingerprint" | "diagnostics">;
  /** A web project (package.json with TypeScript/Vue evidence) whose languages are not enabled. */
  webProjectNotAnalyzed: boolean;
  configDirName: string;
  lastGuard: string;
}

/** The project part of `/convention-status`, after the generic counters. */
export function buildProjectStatusLines(input: ProjectStatusInput): string[] {
  const { config, profile } = input;
  const profileParts = [`profile=${profile.status}`];
  if (profile.profile !== undefined) profileParts.push(`review=${profile.profile.review.status}`);
  if (profile.fingerprint !== undefined) profileParts.push(`fingerprint=${profile.fingerprint}`);
  const activePacks = profile.profile?.packs.flatMap((pack) => {
    if (!pack.enabled) return [];
    return [`${pack.id}${pack.version ? `@${pack.version}` : ""}`];
  }) ?? [];
  return [
    `config-source=${input.usedProjectConfig ? "project" : "defaults"}, project-trusted=${input.projectTrusted}`,
    `languages=${config.includeLanguages.join(",") || "none"}`,
    ...(input.webProjectNotAnalyzed
      ? [`hint=package.json found but TypeScript/Vue analysis is off; set includeLanguages to ["java","typescript","vue"] in ${input.configDirName}/convention-sense.json`]
      : []),
    input.lastGuard,
    `practice=${config.practiceReview.mode}, practice-tokens=${config.practiceReview.maxContextTokens}`,
    profileParts.join(", "),
    `packs=${activePacks.join(", ") || "none"}`,
    ...(profile.diagnostics.length > 0 ? [`profile-diagnostics=${profile.diagnostics.join("; ")}`] : []),
  ];
}
