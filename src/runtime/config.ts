import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ToolMappingConfig } from "../observe/types.js";
import { isSupportedGlob } from "./glob.js";
import { logTargetTravelsThroughLink } from "./log-safety.js";
import { isPathInside } from "./paths.js";
import type { LoadedSpikeConfig, LogLevel, SpikeConfig, SpikeMode } from "./types.js";

const DEFAULT_EXCLUDE = [
  "**/generated/**",
  "**/build/**",
  "**/target/**",
  "**/vendor/**",
  "**/node_modules/**",
  "**/.nuxt/**",
  "**/.next/**",
  "**/.output/**",
  "**/coverage/**",
];

const BUILTIN_TOOL_NAMES = new Set(["read", "edit", "write", "bash", "powershell"]);
const SUPPORTED_LANGUAGES: readonly string[] = ["java", "typescript", "vue"];

export function createDefaultConfig(configDirName = ".pi"): SpikeConfig {
  return {
    enabled: true,
    mode: "observe",
    minEvidenceFiles: 2,
    maxEvidenceFiles: 4,
    maxContextTokens: 1200,
    scopeStrategy: "module-role",
    includeLanguages: ["java"],
    exclude: [...DEFAULT_EXCLUDE],
    injectContext: true,
    persistSessionState: true,
    logPath: `${configDirName}/convention-sense/observe.ndjson`,
    guard: {
      pathExceptions: [],
      allowBypass: true,
      requireRecentContext: true,
      contextWindowTurns: 2,
      contextMaxAgeMs: 10 * 60 * 1000,
    },
    postChangeAudit: {
      enabled: true,
      notify: true,
      maxChangedFiles: 100,
    },
    practiceReview: {
      mode: "suggest",
      maxContextTokens: 400,
    },
    toolMappings: [],
    logging: {
      level: "info",
      explainRanking: true,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(
  source: Record<string, unknown>,
  key: string,
  fallback: boolean,
  diagnostics: string[],
): boolean {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  diagnostics.push(`Ignoring invalid boolean field: ${key}`);
  return fallback;
}

function readInteger(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  diagnostics: string[],
): number {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return value;
  diagnostics.push(`Ignoring invalid ${key}; expected an integer from ${min} to ${max}`);
  return fallback;
}

function readStringArray(
  source: Record<string, unknown>,
  key: string,
  fallback: readonly string[],
  diagnostics: string[],
): string[] {
  const value = source[key];
  if (value === undefined) return [...fallback];
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)) {
    return [...new Set(value)];
  }
  diagnostics.push(`Ignoring invalid ${key}; expected an array of non-empty strings`);
  return [...fallback];
}

function readGlobArray(
  source: Record<string, unknown>,
  key: string,
  fallback: readonly string[],
  diagnostics: string[],
  label = key,
): string[] {
  return readStringArray(source, key, fallback, diagnostics).filter((pattern) => {
    if (isSupportedGlob(pattern)) return true;
    diagnostics.push(`Ignoring unsupported glob pattern in ${label}: ${JSON.stringify(pattern.slice(0, 40))}`);
    return false;
  });
}

// A misspelled language would otherwise silently disable analysis for that language.
function readLanguages(
  source: Record<string, unknown>,
  fallback: readonly string[],
  diagnostics: string[],
): string[] {
  const requested = readStringArray(source, "includeLanguages", fallback, diagnostics).map((item) => item.toLowerCase());
  const languages: string[] = [];
  for (const language of new Set(requested)) {
    if (SUPPORTED_LANGUAGES.includes(language)) languages.push(language);
    else diagnostics.push(`Ignoring unsupported language ${JSON.stringify(language.slice(0, 40))} in includeLanguages`);
  }
  if (source.includeLanguages !== undefined && languages.length === 0) {
    diagnostics.push("includeLanguages is empty; no source files will be analyzed");
  }
  return languages;
}

function readMode(source: Record<string, unknown>, fallback: SpikeMode, diagnostics: string[]): SpikeMode {
  const value = source.mode;
  if (value === undefined) return fallback;
  if (value === "observe" || value === "guard") return value;
  diagnostics.push("Ignoring invalid mode; expected observe or guard");
  return fallback;
}

function readPracticeMode(
  source: Record<string, unknown>,
  fallback: SpikeConfig["practiceReview"]["mode"],
  diagnostics: string[],
): SpikeConfig["practiceReview"]["mode"] {
  const value = source.mode;
  if (value === undefined) return fallback;
  if (value === "off" || value === "suggest" || value === "auto-once") return value;
  diagnostics.push("Ignoring invalid practiceReview.mode; expected off, suggest, or auto-once");
  return fallback;
}

function readLogLevel(source: Record<string, unknown>, fallback: LogLevel, diagnostics: string[]): LogLevel {
  const logging = source.logging;
  if (logging === undefined) return fallback;
  if (!isRecord(logging)) {
    diagnostics.push("Ignoring invalid logging object");
    return fallback;
  }
  const value = logging.level;
  if (value === undefined) return fallback;
  if (value === "silent" || value === "info" || value === "debug") return value;
  diagnostics.push("Ignoring invalid logging.level; expected silent, info, or debug");
  return fallback;
}

function readExplainRanking(
  source: Record<string, unknown>,
  fallback: boolean,
  diagnostics: string[],
): boolean {
  const logging = source.logging;
  if (logging === undefined) return fallback;
  if (!isRecord(logging)) return fallback;
  const value = logging.explainRanking;
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  diagnostics.push("Ignoring invalid logging.explainRanking; expected boolean");
  return fallback;
}

// The project config is repository-controlled input, so the log may only live in the plugin's own
// state directory (never in an arbitrary project file, a parent directory or a linked location).
function readLogPath(
  source: Record<string, unknown>,
  fallback: string,
  diagnostics: string[],
  cwd: string,
  configDirName: string,
): string {
  const value = source.logPath;
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push("Ignoring invalid logPath; expected a non-empty string");
    return fallback;
  }
  const requested = value.trim();
  const candidate = resolveLogPath(cwd, requested);
  if (!isPathInside(resolve(cwd, configDirName, "convention-sense"), candidate)) {
    diagnostics.push(`Ignoring logPath outside ${configDirName}/convention-sense/; using the default`);
    return fallback;
  }
  if (logTargetTravelsThroughLink(cwd, candidate)) {
    diagnostics.push("Ignoring logPath that travels through a symbolic link or junction; using the default");
    return fallback;
  }
  return requested;
}

function readNestedObject(
  source: Record<string, unknown>,
  key: string,
  diagnostics: string[],
): Record<string, unknown> {
  const value = source[key];
  if (value === undefined) return {};
  if (isRecord(value)) return value;
  diagnostics.push(`Ignoring invalid ${key}; expected an object`);
  return {};
}

function readToolMappings(
  source: Record<string, unknown>,
  diagnostics: string[],
): ToolMappingConfig[] {
  const value = source.toolMappings;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    diagnostics.push("Ignoring invalid toolMappings; expected an array");
    return [];
  }

  const mappings: ToolMappingConfig[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      diagnostics.push(`Ignoring invalid toolMappings[${index}]; expected an object`);
      continue;
    }
    const toolName = typeof item.toolName === "string" ? item.toolName.trim() : "";
    const operation = item.operation;
    const pathField = typeof item.pathField === "string" ? item.pathField.trim() : "";
    const safePathField =
      pathField.length > 0 &&
      pathField.split(".").every((segment) => /^[A-Za-z_$][\w$]*$/.test(segment) && !["__proto__", "prototype", "constructor"].includes(segment));
    if (
      !toolName ||
      !["read", "edit", "write"].includes(String(operation)) ||
      !safePathField ||
      BUILTIN_TOOL_NAMES.has(toolName) ||
      seen.has(toolName)
    ) {
      diagnostics.push(`Ignoring invalid or duplicate toolMappings[${index}]`);
      continue;
    }
    seen.add(toolName);
    mappings.push({
      toolName,
      operation: operation as ToolMappingConfig["operation"],
      pathField,
    });
  }
  return mappings;
}

export function resolveLogPath(cwd: string, configuredPath: string): string {
  return isAbsolute(configuredPath) ? configuredPath : resolve(cwd, configuredPath);
}

function defaultsResult(
  config: SpikeConfig,
  configPath: string,
  diagnostics: string[],
): LoadedSpikeConfig {
  return { config, configPath, diagnostics, usedProjectConfig: false };
}

export function loadSpikeConfig(
  cwd: string,
  projectTrusted: boolean,
  configDirName = ".pi",
): LoadedSpikeConfig {
  const loaded = readSpikeConfig(cwd, projectTrusted, configDirName);
  // A custom logPath that is unsafe already fell back to the default. If even the default location
  // is unsafe (a repository can ship a symlinked log file), keep running without a log.
  if (logTargetTravelsThroughLink(cwd, resolveLogPath(cwd, loaded.config.logPath))) {
    loaded.config.logging.level = "silent";
    loaded.diagnostics.push(
      "Logging disabled because the log path travels through a symbolic link or junction",
    );
  }
  return loaded;
}

function readSpikeConfig(
  cwd: string,
  projectTrusted: boolean,
  configDirName: string,
): LoadedSpikeConfig {
  const defaults = createDefaultConfig(configDirName);
  const configPath = join(cwd, configDirName, "convention-sense.json");
  const diagnostics: string[] = [];

  if (!projectTrusted) {
    if (existsSync(configPath)) {
      diagnostics.push("Project config exists but was ignored because the project is not trusted");
    }
    return defaultsResult(defaults, configPath, diagnostics);
  }
  if (!existsSync(configPath)) return defaultsResult(defaults, configPath, diagnostics);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    diagnostics.push(`Failed to parse project config: ${error instanceof Error ? error.message : String(error)}`);
    return defaultsResult(defaults, configPath, diagnostics);
  }
  if (!isRecord(parsed)) {
    diagnostics.push("Ignoring project config because its root is not an object");
    return defaultsResult(defaults, configPath, diagnostics);
  }

  const minEvidenceFiles = readInteger(
    parsed,
    "minEvidenceFiles",
    defaults.minEvidenceFiles,
    1,
    10,
    diagnostics,
  );
  let maxEvidenceFiles = readInteger(
    parsed,
    "maxEvidenceFiles",
    defaults.maxEvidenceFiles,
    1,
    10,
    diagnostics,
  );
  if (maxEvidenceFiles < minEvidenceFiles) {
    diagnostics.push("Raised maxEvidenceFiles to minEvidenceFiles");
    maxEvidenceFiles = minEvidenceFiles;
  }

  const scopeStrategy = parsed.scopeStrategy;
  if (scopeStrategy !== undefined && scopeStrategy !== "module-role") {
    diagnostics.push("Ignoring invalid scopeStrategy; V1 supports module-role only");
  }

  const config: SpikeConfig = {
    enabled: readBoolean(parsed, "enabled", defaults.enabled, diagnostics),
    mode: readMode(parsed, defaults.mode, diagnostics),
    minEvidenceFiles,
    maxEvidenceFiles,
    maxContextTokens: readInteger(
      parsed,
      "maxContextTokens",
      defaults.maxContextTokens,
      200,
      8000,
      diagnostics,
    ),
    scopeStrategy: "module-role",
    includeLanguages: readLanguages(parsed, defaults.includeLanguages, diagnostics),
    exclude: readGlobArray(parsed, "exclude", defaults.exclude, diagnostics),
    injectContext: readBoolean(parsed, "injectContext", defaults.injectContext, diagnostics),
    persistSessionState: readBoolean(
      parsed,
      "persistSessionState",
      defaults.persistSessionState,
      diagnostics,
    ),
    logPath: readLogPath(parsed, defaults.logPath, diagnostics, cwd, configDirName),
    guard: (() => {
      const guard = readNestedObject(parsed, "guard", diagnostics);
      return {
        pathExceptions: readGlobArray(
          guard,
          "pathExceptions",
          defaults.guard.pathExceptions,
          diagnostics,
          "guard.pathExceptions",
        ),
        allowBypass: readBoolean(guard, "allowBypass", defaults.guard.allowBypass, diagnostics),
        requireRecentContext: readBoolean(
          guard,
          "requireRecentContext",
          defaults.guard.requireRecentContext,
          diagnostics,
        ),
        contextWindowTurns: readInteger(
          guard,
          "contextWindowTurns",
          defaults.guard.contextWindowTurns,
          0,
          100,
          diagnostics,
        ),
        contextMaxAgeMs: readInteger(
          guard,
          "contextMaxAgeMs",
          defaults.guard.contextMaxAgeMs,
          1_000,
          86_400_000,
          diagnostics,
        ),
      };
    })(),
    postChangeAudit: (() => {
      const audit = readNestedObject(parsed, "postChangeAudit", diagnostics);
      return {
        enabled: readBoolean(audit, "enabled", defaults.postChangeAudit.enabled, diagnostics),
        notify: readBoolean(audit, "notify", defaults.postChangeAudit.notify, diagnostics),
        maxChangedFiles: readInteger(
          audit,
          "maxChangedFiles",
          defaults.postChangeAudit.maxChangedFiles,
          1,
          1000,
          diagnostics,
        ),
      };
    })(),
    practiceReview: (() => {
      const practice = readNestedObject(parsed, "practiceReview", diagnostics);
      return {
        mode: readPracticeMode(practice, defaults.practiceReview.mode, diagnostics),
        maxContextTokens: readInteger(
          practice,
          "maxContextTokens",
          defaults.practiceReview.maxContextTokens,
          120,
          1200,
          diagnostics,
        ),
      };
    })(),
    toolMappings: readToolMappings(parsed, diagnostics),
    logging: {
      level: readLogLevel(parsed, defaults.logging.level, diagnostics),
      explainRanking: readExplainRanking(parsed, defaults.logging.explainRanking, diagnostics),
    },
  };

  if (config.mode === "guard" && !config.injectContext && config.guard.requireRecentContext) {
    config.guard.requireRecentContext = false;
    diagnostics.push("Disabled guard.requireRecentContext because injectContext is false; Guard will fail open on this condition");
  }

  return { config, configPath, diagnostics, usedProjectConfig: true };
}
