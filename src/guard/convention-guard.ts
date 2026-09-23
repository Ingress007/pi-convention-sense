import type { AnalyzeTargetResult, ConventionScope, ConventionSnapshot, ObserveConfig } from "../observe/types.js";
import type { GuardAction } from "../runtime/types.js";

export type ConventionGuardReason =
  | "EXTENSION_DISABLED"
  | "UNSUPPORTED_LANGUAGE"
  | "TARGET_EXCLUDED"
  | "PATH_EXCEPTION"
  | "BYPASS_GRANTED"
  | "TARGET_NOT_READ"
  | "SCOPE_UNKNOWN"
  | "SCOPE_LOW_CONFIDENCE"
  | "ANALYSIS_FAILED_OPEN"
  | "SNAPSHOT_MISSING"
  | "SNAPSHOT_STALE"
  | "SNAPSHOT_NOT_INJECTED"
  | "NO_PEERS_AVAILABLE"
  | "INSUFFICIENT_PEERS_AVAILABLE"
  | "SNAPSHOT_WEAK_DISCOVERY_COMPLETE"
  | "SNAPSHOT_VALID";

export interface ConventionGuardDecision {
  action: GuardAction;
  reasonCode: ConventionGuardReason;
  message: string;
  targetPath: string;
  targetExists: boolean;
  scope?: ConventionScope;
  suggestedPeers: string[];
  bypassAvailable: boolean;
}

export interface ConventionGuardInput {
  config: ObserveConfig;
  targetPath: string;
  targetExists: boolean;
  targetRead: boolean;
  snapshot?: ConventionSnapshot;
  snapshotInjected: boolean;
  bypassGranted: boolean;
  unsupportedLanguage?: boolean;
  targetExcluded?: boolean;
  pathException?: boolean;
  analysisReason?: AnalyzeTargetResult["reason"];
}

function decision(
  input: ConventionGuardInput,
  action: GuardAction,
  reasonCode: ConventionGuardReason,
  message: string,
  bypassAvailable = false,
): ConventionGuardDecision {
  const value: ConventionGuardDecision = {
    action,
    reasonCode,
    message,
    targetPath: input.targetPath,
    targetExists: input.targetExists,
    suggestedPeers: input.snapshot?.candidates.map((candidate) => candidate.path) ?? [],
    bypassAvailable: bypassAvailable && input.config.guard.allowBypass,
  };
  if (input.snapshot?.scope) value.scope = input.snapshot.scope;
  return value;
}

function gapDecision(
  input: ConventionGuardInput,
  reasonCode: Extract<
    ConventionGuardReason,
    "TARGET_NOT_READ" | "SNAPSHOT_MISSING" | "SNAPSHOT_STALE" | "SNAPSHOT_NOT_INJECTED"
  >,
  guardMessage: string,
): ConventionGuardDecision {
  const action: GuardAction = input.config.mode === "guard" ? "block" : "wouldBlock";
  const modeMessage = input.config.mode === "guard"
    ? `Convention Guard blocked this modification. ${guardMessage}`
    : `Observe would block this modification. ${guardMessage}`;
  return decision(input, action, reasonCode, modeMessage, true);
}

export function evaluateConventionGuard(input: ConventionGuardInput): ConventionGuardDecision {
  if (!input.config.enabled) {
    return decision(input, "allow", "EXTENSION_DISABLED", "Convention Sense is disabled.");
  }
  if (input.unsupportedLanguage) {
    return decision(input, "allow", "UNSUPPORTED_LANGUAGE", "The target language is outside the configured V1 scope.");
  }
  if (input.targetExcluded) {
    return decision(input, "allow", "TARGET_EXCLUDED", "The target is excluded from convention analysis.");
  }
  if (input.pathException) {
    return decision(input, "allow", "PATH_EXCEPTION", "The target matches a project-level Guard path exception.");
  }
  if (input.bypassGranted && input.config.mode === "guard" && input.config.guard.allowBypass) {
    return decision(input, "allow", "BYPASS_GRANTED", "A one-time Guard bypass was consumed for this exact path.");
  }

  if (input.targetExists && !input.targetRead) {
    return gapDecision(
      input,
      "TARGET_NOT_READ",
      "Read the target file successfully; Convention Sense will discover comparable implementations and retry on the next turn.",
    );
  }

  if (input.analysisReason === "scope-unknown") {
    return decision(input, "allow", "SCOPE_UNKNOWN", "The target role could not be identified reliably; failing open.");
  }
  if (input.analysisReason === "analysis-error") {
    return decision(input, "allow", "ANALYSIS_FAILED_OPEN", "Convention analysis failed; failing open without blocking Pi.");
  }
  if (!input.snapshot) {
    return gapDecision(
      input,
      "SNAPSHOT_MISSING",
      "No convention Snapshot is available. Read the target and suggested peer implementations, then retry.",
    );
  }
  if (input.snapshot.status === "stale") {
    return gapDecision(
      input,
      "SNAPSHOT_STALE",
      "The previous Snapshot is stale. Re-read the target or a relevant peer so it can be rebuilt.",
    );
  }
  if (input.snapshot.scope.confidence === "low" || input.snapshot.scope.role === "unknown") {
    return decision(
      input,
      "allow",
      "SCOPE_LOW_CONFIDENCE",
      "Scope confidence is too low for a safe Guard decision; failing open.",
    );
  }

  const peerCount = input.snapshot.evidenceFiles.length;
  if (peerCount === 0) {
    return decision(
      input,
      "allow",
      "NO_PEERS_AVAILABLE",
      "Discovery completed and found no comparable implementation; allowing to avoid a permanent block.",
    );
  }
  if (peerCount < input.config.minEvidenceFiles) {
    return decision(
      input,
      "allow",
      "INSUFFICIENT_PEERS_AVAILABLE",
      `Discovery completed with only ${peerCount} comparable implementation(s); allowing because more peers cannot be created by additional reads.`,
    );
  }
  if (input.snapshot.status === "weak") {
    return decision(
      input,
      "allow",
      "SNAPSHOT_WEAK_DISCOVERY_COMPLETE",
      "Discovery completed but evidence is weak or mixed; Guard does not enforce uncertain style conclusions.",
    );
  }
  if (input.config.guard.requireRecentContext && !input.snapshotInjected) {
    return gapDecision(
      input,
      "SNAPSHOT_NOT_INJECTED",
      "A valid Snapshot exists but has not appeared in a recent model Context. Retry on the next turn after Context injection.",
    );
  }
  return decision(input, "allow", "SNAPSHOT_VALID", "A fresh, recently injected convention Snapshot is available.");
}

export function formatGuardBlockReason(
  decision: ConventionGuardDecision,
  displayTarget: string,
  displayPeer: (path: string) => string = (path) => path,
): string {
  const peers = decision.suggestedPeers.length > 0
    ? ` Suggested peers: ${decision.suggestedPeers.slice(0, 4).map(displayPeer).join(", ")}.`
    : "";
  const bypass = decision.bypassAvailable
    ? ` To bypass once, run /convention-bypass ${displayTarget}`
    : "";
  return `${decision.message}${peers}${bypass} [${decision.reasonCode}]`;
}
