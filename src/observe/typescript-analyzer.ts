import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type {
  ScopeConfidence,
  SourceKind,
  TypeScriptFileFacts,
  WebRole,
} from "./types.js";

const GENERATED_PATH = /[/\\](?:node_modules|dist|build|coverage|generated|\.nuxt|\.next)[/\\]/i;
const TEST_PATH = /[/\\](?:test|tests|__tests__|spec|specs)[/\\]|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const FRAMEWORK_PRIMITIVES = [
  "computed",
  "defineComponent",
  "defineEmits",
  "defineExpose",
  "defineModel",
  "defineOptions",
  "defineProps",
  "defineStore",
  "inject",
  "onBeforeMount",
  "onMounted",
  "onUnmounted",
  "provide",
  "reactive",
  "ref",
  "shallowRef",
  "storeToRefs",
  "useRoute",
  "useRouter",
  "watch",
  "watchEffect",
] as const;

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function detectTypeScriptLanguage(path: string): "typescript" | "vue" | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === ".vue") return "vue";
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) return "typescript";
  return undefined;
}

export function detectTypeScriptSourceKind(path: string): SourceKind {
  return TEST_PATH.test(path) ? "test" : "production";
}

function stripTypeScriptComments(content: string): string {
  const output = [...content];
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  for (let index = 0; index < content.length; index += 1) {
    const current = content[index] ?? "";
    const next = content[index + 1] ?? "";
    if (state === "code") {
      if (current === "/" && next === "/") {
        output[index] = " ";
        output[index + 1] = " ";
        state = "line";
        index += 1;
      } else if (current === "/" && next === "*") {
        output[index] = " ";
        output[index + 1] = " ";
        state = "block";
        index += 1;
      } else if (current === "'") state = "single";
      else if (current === '"') state = "double";
      else if (current === "`") state = "template";
      continue;
    }
    if (state === "line") {
      if (current === "\n" || current === "\r") state = "code";
      else output[index] = " ";
      continue;
    }
    if (state === "block") {
      if (current === "*" && next === "/") {
        output[index] = " ";
        output[index + 1] = " ";
        state = "code";
        index += 1;
      } else if (current !== "\n" && current !== "\r") output[index] = " ";
      continue;
    }
    if (current === "\\") {
      index += 1;
      continue;
    }
    if (
      (state === "single" && current === "'") ||
      (state === "double" && current === '"') ||
      (state === "template" && current === "`")
    ) {
      state = "code";
    }
  }
  return output.join("").replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\r\n]/g, " "));
}

function roleResult(role: WebRole, confidence: ScopeConfidence): { role: WebRole; confidence: ScopeConfidence } {
  return { role, confidence };
}

export function detectTypeScriptRole(
  path: string,
  content = "",
): { role: WebRole; confidence: ScopeConfidence } {
  const normalized = normalizedPath(path).toLowerCase();
  const fileName = basename(path).toLowerCase();
  const code = stripTypeScriptComments(content);

  if (/\bdefineStore\s*\(/.test(code) || /\/(?:store|stores)\//.test(normalized)) {
    return roleResult("pinia-store", "high");
  }
  if (/\/(?:router|routes)\//.test(normalized) || /(?:^|\.)router\.[cm]?[jt]s$/.test(fileName)) {
    return roleResult("router", "high");
  }
  if (
    /\/(?:views?|pages?)\/.*\/(?:modules?|components?)\//.test(normalized) ||
    /\/(?:layouts?|layout)\/(?:modules?|components?)\//.test(normalized)
  ) {
    return roleResult("component", "high");
  }
  if (/\/(?:layouts?|layout)\//.test(normalized)) return roleResult("layout", "high");
  if (/\/(?:views?|pages?)\//.test(normalized)) return roleResult("page", "high");
  if (
    /\/(?:hooks?|composables?)\//.test(normalized) ||
    /^use[A-Z0-9_-]/.test(basename(path).replace(/\.[^.]+$/, ""))
  ) {
    return roleResult("hook", "high");
  }
  if (/\/(?:service|services)\/api\//.test(normalized) || /\/(?:api|apis)\//.test(normalized)) {
    return roleResult("api-service", "high");
  }
  if (
    /\/(?:request|requests|http|client|clients)\//.test(normalized) ||
    /\/packages\/(?:axios|alova|ofetch|request|http)(?:\/|$)/.test(normalized) ||
    /\baxios\.create\s*\(|\bcreateFetch\s*\(|\bcreateRequest\s*\(/.test(code)
  ) {
    return roleResult("request-client", "high");
  }
  if (/\/(?:components?|widgets?)\//.test(normalized)) return roleResult("component", "high");
  if (/\/packages\/[^/]+\//.test(normalized)) return roleResult("workspace-package", "medium");
  if (detectTypeScriptLanguage(path) === "vue") return roleResult("component", "medium");
  if (/\bdefineComponent\s*\(/.test(code) || extname(path).toLowerCase() === ".tsx") {
    return roleResult("component", "medium");
  }
  return roleResult("unknown", "low");
}

function extractImports(code: string): string[] {
  const imports: string[] = [];
  const pattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of code.matchAll(pattern)) {
    const value = match[1];
    if (value) imports.push(value);
  }
  for (const match of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const value = match[1];
    if (value) imports.push(value);
  }
  return unique(imports);
}

function extractExports(code: string): string[] {
  const exports: string[] = [];
  if (/\bexport\s+default\b/.test(code)) exports.push("default");
  for (const match of code.matchAll(
    /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    const value = match[1];
    if (value) exports.push(value);
  }
  return unique(exports);
}

function detectSignals(
  code: string,
  language: "typescript" | "vue",
  role: WebRole,
  exports: readonly string[],
): Record<string, string[]> {
  const signals: Record<string, string[]> = {};
  const add = (category: string, pattern: string) => {
    const values = signals[category] ?? [];
    if (!values.includes(pattern)) values.push(pattern);
    signals[category] = values;
  };

  add("source-language", language === "vue" ? "vue-sfc" : "typescript");
  if (exports.includes("default") && exports.length > 1) add("export-style", "mixed");
  else if (exports.includes("default")) add("export-style", "default");
  else if (exports.length > 0) add("export-style", "named");

  if (language === "vue") {
    if (/<script\b[^>]*\bsetup\b/i.test(code)) add("component-style", "script-setup");
    else if (/\bdefineComponent\s*\(/.test(code)) add("component-style", "define-component");
    else if (/\bexport\s+default\s*\{/.test(code)) add("component-style", "options-api");

    if (/\bdefineProps\s*</.test(code)) add("props-style", "type-based");
    else if (/\bdefineProps\s*\(\s*\{/.test(code)) add("props-style", "runtime");
    if (/\bwithDefaults\s*\(\s*defineProps/.test(code)) add("props-defaults", "with-defaults");
    if (/\bdefineEmits\s*</.test(code)) add("emits-style", "type-based");
    else if (/\bdefineEmits\s*\(\s*\[/.test(code)) add("emits-style", "runtime");
    if (/<style\b[^>]*\bmodule\b/i.test(code)) add("style-scope", "module");
    else if (/<style\b[^>]*\bscoped\b/i.test(code)) add("style-scope", "scoped");
    else if (/<style\b/i.test(code)) add("style-scope", "global");
  }

  if (/\bdefineStore\s*\([^,]+,\s*(?:async\s*)?\(/.test(code)) add("store-style", "setup");
  else if (/\bdefineStore\s*\([^,]+,\s*\{/.test(code)) add("store-style", "options");

  if (/\baxios\b/.test(code)) add("request-style", "axios");
  else if (/\bfetch\s*\(/.test(code)) add("request-style", "fetch");
  else if (/\brequest\s*\(/.test(code)) add("request-style", "request-wrapper");

  if (role === "api-service") {
    if (exports.includes("default")) add("api-export-style", "default-object");
    if (exports.some((name) => name !== "default")) add("api-export-style", "named-functions");
  }
  if (role === "router") {
    if (/\bcomponent\s*:\s*\(\s*\)\s*=>\s*import\s*\(/.test(code)) add("route-loading", "lazy");
    if (/\bcreateWebHashHistory\s*\(/.test(code)) add("router-history", "hash");
    else if (/\bcreateWebHistory\s*\(/.test(code)) add("router-history", "history");
  }

  for (const values of Object.values(signals)) values.sort((left, right) => left.localeCompare(right));
  return signals;
}

export function analyzeTypeScriptFile(path: string): TypeScriptFileFacts {
  const language = detectTypeScriptLanguage(path);
  if (!language) throw new Error(`Unsupported TypeScript/Vue file: ${path}`);
  const content = readFileSync(path, "utf8");
  const code = stripTypeScriptComments(content);
  const stat = statSync(path);
  const role = detectTypeScriptRole(path, code);
  const exports = extractExports(code);
  const frameworkPrimitives = FRAMEWORK_PRIMITIVES.filter((name) =>
    new RegExp(`\\b${name}\\b`).test(code),
  );
  const normalized = normalizedPath(path);
  const workspaceMatch = normalized.match(/\/(?:packages|apps)\/([^/]+)\//i);
  const generated =
    GENERATED_PATH.test(path) ||
    /\.d\.[cm]?ts$/i.test(path) ||
    /(?:@generated|generated by|do not edit)/i.test(content.slice(0, 800));

  return {
    path,
    language,
    role: role.role,
    roleConfidence: role.confidence,
    sourceKind: detectTypeScriptSourceKind(path),
    annotations: unique(frameworkPrimitives),
    imports: extractImports(code),
    superTypes: unique([
      ...(frameworkPrimitives.includes("defineComponent") ? ["defineComponent"] : []),
      ...(frameworkPrimitives.includes("defineStore") ? ["defineStore"] : []),
    ]),
    signals: detectSignals(code, language, role.role, exports),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    contentHash: createHash("sha256").update(content).digest("hex"),
    generated,
    deprecated: /@deprecated\b/i.test(content),
    ...(workspaceMatch?.[1] ? { workspacePackage: workspaceMatch[1] } : {}),
    exportNames: exports,
    frameworkPrimitives,
  };
}

export function prospectiveTypeScriptFacts(path: string): TypeScriptFileFacts {
  const language = detectTypeScriptLanguage(path);
  if (!language) throw new Error(`Unsupported TypeScript/Vue file: ${path}`);
  const role = detectTypeScriptRole(path);
  const normalized = normalizedPath(path);
  const workspaceMatch = normalized.match(/\/(?:packages|apps)\/([^/]+)\//i);
  return {
    path,
    language,
    role: role.role,
    roleConfidence: role.confidence,
    sourceKind: detectTypeScriptSourceKind(path),
    annotations: [],
    imports: [],
    superTypes: [],
    signals: {},
    size: 0,
    mtimeMs: 0,
    contentHash: "prospective",
    generated: GENERATED_PATH.test(path) || /\.d\.[cm]?ts$/i.test(path),
    deprecated: false,
    ...(workspaceMatch?.[1] ? { workspacePackage: workspaceMatch[1] } : {}),
    exportNames: [],
    frameworkPrimitives: [],
  };
}
