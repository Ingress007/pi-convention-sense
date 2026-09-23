import type { GuardAction, GuardDecision, SpikeConfig, SpikeRuntimeState } from "./types.js";

export function evaluateGuard(
  config: SpikeConfig,
  state: SpikeRuntimeState,
  targetPath: string,
  targetExists: boolean,
): GuardDecision {
  if (!config.enabled) {
    return {
      action: "allow",
      reasonCode: "EXTENSION_DISABLED",
      message: "Convention Sense is disabled.",
      targetPath,
      targetExists,
    };
  }

  if (!targetExists) {
    return {
      action: "allow",
      reasonCode: "NEW_FILE_BYPASS",
      message: "Stage 0 allows new files because peer evidence discovery is not implemented yet.",
      targetPath,
      targetExists,
    };
  }

  if (state.successfulReads.has(targetPath)) {
    return {
      action: "allow",
      reasonCode: "TARGET_ALREADY_READ",
      message: "The target file has a successful read result in the active branch state.",
      targetPath,
      targetExists,
    };
  }

  const action: GuardAction = config.mode === "guard" ? "block" : "wouldBlock";
  return {
    action,
    reasonCode: "TARGET_NOT_READ",
    message:
      config.mode === "guard"
        ? "Blocked by the Stage 0 guard: read the existing target file successfully, then retry the modification."
        : "Stage 0 observe decision: this modification would be blocked because the existing target has not been read successfully.",
    targetPath,
    targetExists,
  };
}

export function recordGuardDecision(state: SpikeRuntimeState, decision: GuardDecision): void {
  state.guardCounters[decision.action] += 1;
}
