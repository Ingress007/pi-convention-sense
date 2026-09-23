import { extname } from "node:path";
import type { ConventionSnapshot } from "./types.js";

export type ObserveDecisionReason =
  | "SNAPSHOT_VALID"
  | "SNAPSHOT_WEAK"
  | "SNAPSHOT_MISSING_OR_STALE"
  | "UNSUPPORTED_LANGUAGE";

export interface ObserveDecision {
  action: "allow" | "wouldBlock";
  reasonCode: ObserveDecisionReason;
  message: string;
}

export function evaluateObserveDecision(
  targetPath: string,
  snapshot: ConventionSnapshot | undefined,
): ObserveDecision {
  if (extname(targetPath).toLowerCase() !== ".java") {
    return {
      action: "allow",
      reasonCode: "UNSUPPORTED_LANGUAGE",
      message: "V1 Observe only analyzes Java targets.",
    };
  }
  if (!snapshot) {
    return {
      action: "wouldBlock",
      reasonCode: "SNAPSHOT_MISSING_OR_STALE",
      message: "No fresh convention snapshot is available for this Java target.",
    };
  }
  if (snapshot.status === "weak") {
    return {
      action: "wouldBlock",
      reasonCode: "SNAPSHOT_WEAK",
      message: "The Java target has a Snapshot, but repeated peer evidence is insufficient.",
    };
  }
  return {
    action: "allow",
    reasonCode: "SNAPSHOT_VALID",
    message: "A fresh Java convention snapshot is available.",
  };
}
