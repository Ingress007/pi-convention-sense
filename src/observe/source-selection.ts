import { extname } from "node:path";
import { detectSourceKind } from "./java-analyzer.js";
import { detectTypeScriptLanguage, detectTypeScriptSourceKind } from "./typescript-analyzer.js";
import type { ObserveConfig } from "./types.js";

/** The language to analyze `path` as, or `undefined` when its language is not enabled by `includeLanguages`. */
export function configuredSourceLanguage(path: string, config: ObserveConfig): "java" | "typescript" | "vue" | undefined {
  if (extname(path).toLowerCase() === ".java" && config.includeLanguages.includes("java")) return "java";
  const language = detectTypeScriptLanguage(path);
  return language && config.includeLanguages.includes(language) ? language : undefined;
}

/** True for an enabled-language file that is production code (not test, generated or vendored) in `repositoryRoot`. */
export function isConfiguredProductionSource(path: string, config: ObserveConfig, repositoryRoot: string): boolean {
  const language = configuredSourceLanguage(path, config);
  if (!language) return false;
  return language === "java"
    ? detectSourceKind(path, repositoryRoot) === "production"
    : detectTypeScriptSourceKind(path, repositoryRoot) === "production";
}
