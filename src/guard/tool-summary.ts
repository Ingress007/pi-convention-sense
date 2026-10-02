import type { SpikeConfig } from "../runtime/types.js";
import { classifyShellMutationRisk, displayPath, normalizeToolPath } from "../runtime/paths.js";
import { isShellTool, resolveToolMapping } from "./tool-mapping.js";

/** The `command` string of a shell tool's input, or an empty string when it is missing or not a string. */
export function shellCommand(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : "";
}

/**
 * The part of a tool call that is safe to log: the normalized path and operation of a mapped file tool, or only the
 * length and risk tags of a shell command. Never the command text, file contents or edit bodies.
 */
export function summarizeToolInput(
  toolName: string,
  input: unknown,
  cwd: string,
  config: Pick<SpikeConfig, "toolMappings">,
): Record<string, unknown> {
  const mapping = resolveToolMapping(toolName, input, config.toolMappings);
  if (mapping) {
    const absolutePath = normalizeToolPath(cwd, mapping.rawPath);
    return {
      path: displayPath(cwd, absolutePath),
      operation: mapping.operation,
      builtinMapping: mapping.builtin,
    };
  }

  if (isShellTool(toolName)) {
    const command = shellCommand(input);
    return {
      commandLength: command.length,
      mutationRiskTags: classifyShellMutationRisk(command),
    };
  }
  return {};
}
