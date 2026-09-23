import type { ToolMappingConfig, ToolMappingOperation } from "../observe/types.js";

export interface ResolvedToolMapping {
  toolName: string;
  operation: ToolMappingOperation;
  rawPath: string;
  builtin: boolean;
}

const BUILTIN_OPERATIONS = new Map<string, ToolMappingOperation>([
  ["read", "read"],
  ["edit", "edit"],
  ["write", "write"],
]);

function readPathField(input: unknown, pathField: string): string | undefined {
  let current: unknown = input;
  for (const segment of pathField.split(".")) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current) ||
      ["__proto__", "prototype", "constructor"].includes(segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.length > 0 ? current : undefined;
}

export function resolveToolMapping(
  toolName: string,
  input: unknown,
  configuredMappings: readonly ToolMappingConfig[],
): ResolvedToolMapping | undefined {
  const builtin = BUILTIN_OPERATIONS.get(toolName);
  if (builtin) {
    const rawPath = readPathField(input, "path");
    return rawPath ? { toolName, operation: builtin, rawPath, builtin: true } : undefined;
  }

  const configured = configuredMappings.find((mapping) => mapping.toolName === toolName);
  if (!configured) return undefined;
  const rawPath = readPathField(input, configured.pathField);
  if (!rawPath) return undefined;
  return {
    toolName,
    operation: configured.operation,
    rawPath,
    builtin: false,
  };
}

export function isShellTool(toolName: string): boolean {
  return toolName === "bash" || toolName === "powershell";
}
