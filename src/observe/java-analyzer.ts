import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { MAX_ANALYZED_FILE_BYTES } from "./limits.js";
import { classificationPath } from "./repository-path.js";
import type {
  JavaDeclarationKind,
  JavaFileFacts,
  JavaRole,
  ScopeConfidence,
  SourceKind,
} from "./types.js";

interface RoleDetection {
  role: JavaRole;
  confidence: ScopeConfidence;
}

const ROLE_SUFFIXES: Array<{ pattern: RegExp; role: JavaRole }> = [
  { pattern: /Controller\.java$/i, role: "controller" },
  { pattern: /ServiceImpl\.java$/i, role: "service-impl" },
  { pattern: /Service\.java$/i, role: "service-interface" },
  { pattern: /Mapper\.java$/i, role: "mapper" },
  { pattern: /Repository\.java$/i, role: "repository" },
  { pattern: /(?:Req|Request)(?:DTO|VO)?\.java$/i, role: "request-dto" },
  { pattern: /(?:(?:Resp|Response)(?:DTO|VO)?|VO)\.java$/i, role: "response-dto" },
  { pattern: /Entity\.java$/i, role: "entity" },
];

const ROLE_ANNOTATIONS: Array<{ pattern: RegExp; role: JavaRole }> = [
  { pattern: /@(?:RestController|Controller)\b/, role: "controller" },
  { pattern: /@Service\b/, role: "service-impl" },
  { pattern: /@Mapper\b/, role: "mapper" },
  { pattern: /@Repository\b/, role: "repository" },
  { pattern: /@Entity\b/, role: "entity" },
];

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export function stripJavaComments(source: string): string {
  let output = "";
  let index = 0;
  let state: "code" | "line-comment" | "block-comment" | "string" | "char" | "text-block" = "code";

  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line-comment";
        output += "  ";
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block-comment";
        output += "  ";
        index += 2;
        continue;
      }
      // A text block (Java 15+) is one string whose content may contain quotes, // and /*.
      // Treating its three quotes as an empty string plus an opening quote makes the state depend on
      // the parity of the quotes inside, which corrupts everything after the block.
      if (char === '"' && next === '"' && source[index + 2] === '"') {
        state = "text-block";
        output += '"""';
        index += 3;
        continue;
      }
      if (char === '"') state = "string";
      if (char === "'") state = "char";
      output += char;
      index += 1;
      continue;
    }

    if (state === "text-block") {
      if (char === "\\") {
        output += char + next; // an escape, including an escaped quote
        index += 2;
        continue;
      }
      if (char === '"' && next === '"' && source[index + 2] === '"') {
        state = "code";
        output += '"""';
        index += 3;
        continue;
      }
      output += char;
      index += 1;
      continue;
    }

    if (state === "line-comment") {
      // Java ends a line comment at LF, CR or CRLF.
      if (char === "\n" || char === "\r") {
        state = "code";
        output += char;
      } else {
        output += " ";
      }
      index += 1;
      continue;
    }

    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        output += "  ";
        index += 2;
      } else {
        output += char === "\n" || char === "\r" ? char : " ";
        index += 1;
      }
      continue;
    }

    output += char;
    if (char === "\\") {
      output += next;
      index += 2;
      continue;
    }
    if (state === "string" && char === '"') state = "code";
    if (state === "char" && char === "'") state = "code";
    index += 1;
  }

  return output;
}

export function maskJavaStrings(sourceWithoutComments: string): string {
  let output = "";
  let index = 0;
  let state: "code" | "string" | "char" | "text-block" = "code";

  while (index < sourceWithoutComments.length) {
    const char = sourceWithoutComments[index] ?? "";
    const next = sourceWithoutComments[index + 1] ?? "";
    if (state === "code") {
      if (char === '"' && next === '"' && sourceWithoutComments[index + 2] === '"') {
        state = "text-block";
        output += '"""';
        index += 3;
        continue;
      }
      if (char === '"') {
        state = "string";
        output += '"';
      } else if (char === "'") {
        state = "char";
        output += "'";
      } else {
        output += char;
      }
      index += 1;
      continue;
    }

    if (state === "text-block") {
      if (char === "\\") {
        const width = Math.min(2, sourceWithoutComments.length - index);
        output += " ".repeat(width);
        index += width;
        continue;
      }
      if (char === '"' && next === '"' && sourceWithoutComments[index + 2] === '"') {
        state = "code";
        output += '"""';
        index += 3;
        continue;
      }
      output += char === "\n" || char === "\r" ? char : " ";
      index += 1;
      continue;
    }

    if (char === "\\") {
      output += "  ";
      index += Math.min(2, sourceWithoutComments.length - index);
      continue;
    }
    if (state === "string" && char === '"') {
      state = "code";
      output += '"';
    } else if (state === "char" && char === "'") {
      state = "code";
      output += "'";
    } else {
      output += char === "\n" || char === "\r" ? char : " ";
    }
    index += 1;
  }

  return output;
}

export function detectJavaRole(path: string, source = "", repositoryRoot?: string): RoleDetection {
  const fileName = basename(path);
  const normalizedPath = classificationPath(path, repositoryRoot).toLowerCase();
  const packageRole: JavaRole | undefined =
    /\/(?:model\/)?request\//.test(normalizedPath)
      ? "request-dto"
      : /\/(?:model\/)?response\//.test(normalizedPath)
        ? "response-dto"
        : undefined;
  const suffix = ROLE_SUFFIXES.find(({ pattern }) => pattern.test(fileName));
  const clean = stripJavaComments(source);
  const annotation = ROLE_ANNOTATIONS.find(({ pattern }) => pattern.test(clean));

  if (packageRole && suffix && (suffix.role === "response-dto" || suffix.role === "request-dto")) {
    return { role: packageRole, confidence: "medium" };
  }
  if (suffix && annotation && suffix.role === annotation.role) {
    return { role: suffix.role, confidence: "high" };
  }
  if (suffix) {
    const declarationBoost =
      (suffix.role === "service-interface" && /\binterface\s+\w+Service\b/.test(clean)) ||
      (suffix.role === "service-impl" && /\bclass\s+\w+ServiceImpl\b/.test(clean));
    return { role: suffix.role, confidence: declarationBoost ? "high" : "medium" };
  }
  if (annotation) return { role: annotation.role, confidence: "medium" };
  return { role: "unknown", confidence: "low" };
}

export function detectSourceKind(path: string, repositoryRoot?: string): SourceKind {
  const normalized = classificationPath(path, repositoryRoot).toLowerCase();
  if (normalized.includes("/src/main/")) return "production";
  if (normalized.includes("/src/test/") || normalized.includes("/test/")) return "test";
  return "unknown";
}

function addSignal(signals: Map<string, Set<string>>, category: string, pattern: string): void {
  const values = signals.get(category) ?? new Set<string>();
  values.add(pattern);
  signals.set(category, values);
}

function matchAll(source: string, pattern: RegExp, group = 1): string[] {
  return [...source.matchAll(pattern)]
    .map((match) => match[group])
    .filter((value): value is string => typeof value === "string");
}

function outerType(type: string): string {
  return type.trim().replace(/\s+/g, " ").split(/[<\s]/, 1)[0] ?? type.trim();
}

function dtoNamingPattern(fileName: string): string {
  const stem = fileName.replace(/\.java$/i, "");
  for (const suffix of [
    "RequestWebVO",
    "ResponseWebVO",
    "RequestVO",
    "ResponseVO",
    "QueryVO",
    "Request",
    "Response",
    "Req",
    "Resp",
    "VO",
  ]) {
    if (stem.endsWith(suffix)) return suffix;
  }
  return "other";
}

function isGeneratedJava(
  path: string,
  source: string,
  annotations: readonly string[],
  repositoryRoot?: string,
): boolean {
  const header = source.slice(0, 2_000);
  return (
    annotations.includes("Generated") ||
    /[/\\](?:generated|target|build)[/\\]/i.test(classificationPath(path, repositoryRoot)) ||
    /\bGenerated by\b[\s\S]{0,160}\bDO NOT EDIT\b/i.test(header) ||
    /\bDO NOT EDIT\b[\s\S]{0,160}\bgenerated\b/i.test(header)
  );
}

export function analyzeJavaSource(path: string, source: string, repositoryRoot?: string): JavaFileFacts {
  const stat = statSync(path);
  const clean = stripJavaComments(source);
  const structural = maskJavaStrings(clean);
  const role = detectJavaRole(path, source, repositoryRoot);
  const packageName = structural.match(/\bpackage\s+([\w.]+)\s*;/)?.[1];
  const imports = uniqueSorted(matchAll(structural, /^[^\S\r\n]*import\s+(?:static\s+)?([\w.*]+)\s*;/gm));
  const annotations = uniqueSorted(matchAll(structural, /@([A-Za-z_$][\w$]*)\b/g));
  const superTypes = uniqueSorted(
    matchAll(
      structural,
      /\b(?:extends|implements)\s+([\w$.]+(?:\s*,\s*[\w$.]+)*)/g,
    ).flatMap((value) => value.split(",").map((item) => item.trim())),
  );

  const signals = new Map<string, Set<string>>();
  const className = basename(path, ".java").replace(/[$()[\]{}.*+?^\\|]/g, "\\$&");
  const declarationKind = structural.match(
    new RegExp(`\\b(class|interface|enum|record)\\s+${className}\\b`),
  )?.[1] as JavaDeclarationKind | undefined;
  const dependencyField = /\b(?:private|protected|public)\s+(?:static\s+)?(?:final\s+)?([A-Z][\w$]*(?:Service|Mapper|Repository|Client|Gateway))\s+\w+\s*;/g;
  const dependencyTypes = matchAll(structural, dependencyField);
  const hasDependencyFields = dependencyTypes.length > 0;

  // The negated classes below are bounded: an unbounded `[^)]*` rescans to EOF from every unclosed `Name(`.
  const constructorPattern = new RegExp(`\\b${className}\\s*\\(([^)]{0,600})\\)`, "g");
  const constructors = matchAll(structural, constructorPattern);
  if (constructors.some((params) => /(?:Service|Mapper|Repository|Client|Gateway)\b/.test(params))) {
    addSignal(signals, "dependency-injection", "constructor");
  }
  if (/@RequiredArgsConstructor\b/.test(structural) && /\bprivate\s+final\s+\w+\s+\w+\s*;/.test(structural)) {
    addSignal(signals, "dependency-injection", "constructor-lombok");
  }
  if (
    /@(?:Autowired|Resource|Inject)\b[\s\S]{0,180}?\b(?:private|protected|public)\s+(?:final\s+)?\w+[<\w, ?.$>]{0,200}\s+\w+\s*;/.test(
      structural,
    )
  ) {
    addSignal(signals, "dependency-injection", "field");
  }
  if (hasDependencyFields && constructors.length === 0 && /@RequiredArgsConstructor\b/.test(structural)) {
    addSignal(signals, "dependency-injection", "constructor-lombok");
  }

  for (const annotation of annotations) {
    if (["RestController", "Controller", "Service", "Component", "Repository", "Mapper", "Entity"].includes(annotation)) {
      addSignal(signals, "stereotype", annotation);
    }
  }

  if (role.role === "request-dto" || role.role === "response-dto") {
    addSignal(signals, "dto-naming", dtoNamingPattern(basename(path)));
    for (const annotation of annotations) {
      if (["Data", "Value", "Getter", "Setter", "Builder", "SuperBuilder", "NoArgsConstructor", "AllArgsConstructor"].includes(annotation)) {
        addSignal(signals, "dto-lombok", annotation);
      }
    }
    if (
      annotations.some((annotation) =>
        ["Valid", "Validated", "NotNull", "NotBlank", "NotEmpty", "Size", "Min", "Max", "Pattern", "Positive"].includes(annotation),
      )
    ) {
      addSignal(signals, "dto-validation", "bean-validation");
    }
    if (superTypes.some((type) => type.endsWith("Serializable"))) {
      addSignal(signals, "dto-contract", "serializable");
    }
  }

  if (/@Transactional(?:\s*\([^()]*\))?\s*(?:public\s+)?(?:class|interface)\b/.test(structural)) {
    addSignal(signals, "transaction-placement", "class");
  }
  if (/@Transactional(?:\s*\([^()]*\))?\s*(?:public|protected|private)\b/.test(structural)) {
    addSignal(signals, "transaction-placement", "method");
  }

  for (const exceptionType of matchAll(structural, /\bthrow\s+new\s+([A-Z][\w$]*Exception)\s*\(/g)) {
    addSignal(signals, "exception-type", exceptionType);
  }
  for (const match of structural.matchAll(/\bthrow\s+new\s+([A-Z][\w$]*Exception)\s*\(([^;]{0,1000})\)/g)) {
    const exceptionType = match[1];
    const args = match[2];
    if (exceptionType && args && /\b\w*ErrorCode\s*\./.test(args)) {
      addSignal(signals, "exception-model", `${exceptionType}+ErrorCode`);
    }
  }

  if (imports.some((value) => value.startsWith("org.slf4j.")) || annotations.includes("Slf4j")) {
    addSignal(signals, "logging-framework", "slf4j");
  }
  if (imports.some((value) => value.includes("log4j")) || annotations.includes("Log4j2")) {
    addSignal(signals, "logging-framework", "log4j2");
  }
  if (imports.some((value) => value.startsWith("java.util.logging."))) {
    addSignal(signals, "logging-framework", "jul");
  }
  if (/\b(?:log|logger)\.(?:trace|debug|info|warn|error)\s*\(\s*"[^"\n]{0,400}\{\}[^"\n]{0,400}"\s*,/i.test(clean)) {
    addSignal(signals, "logging-style", "parameterized");
  }
  if (/\b(?:log|logger)\.(?:trace|debug|info|warn|error)\s*\(\s*"[^"\n]*"\s*\+/i.test(clean)) {
    addSignal(signals, "logging-style", "concatenated");
  }

  const methodPattern = /\b(?:public|protected)\s+(?:static\s+)?(?:final\s+)?([A-Z][\w$]*(?:\s*<[^;{}()]{1,400}>)?)\s+\w+\s*\(/g;
  for (const returnType of matchAll(structural, methodPattern)) {
    const outer = outerType(returnType);
    if (/^(?:ResponseEntity|Result|ApiResponse|CommonResult|Page|PageResult|Optional)$/.test(outer)) {
      addSignal(signals, "return-wrapper", outer);
    }
  }

  if (/\b\w*mapper\.\w+\s*\(/i.test(structural)) addSignal(signals, "mapping-helper", "mapper");
  if (/\b\w*(?:converter|assembler)\.\w+\s*\(/i.test(structural)) {
    addSignal(signals, "mapping-helper", "converter-or-assembler");
  }

  if (/\bOptional\s*\./.test(structural)) addSignal(signals, "null-handling", "optional");
  if (/\bObjects\s*\.\s*(?:isNull|nonNull|requireNonNull)\s*\(/.test(structural)) {
    addSignal(signals, "null-handling", "objects-utility");
  }
  if (/(?:==|!=)\s*null\b|\bnull\s*(?:==|!=)/.test(structural)) {
    addSignal(signals, "null-handling", "direct-null-check");
  }

  for (const dependency of dependencyTypes) {
    if (/Service$/.test(dependency)) addSignal(signals, "dependency-shape", "service");
    if (/Mapper$/.test(dependency)) addSignal(signals, "dependency-shape", "mapper");
    if (/Repository$/.test(dependency)) addSignal(signals, "dependency-shape", "repository");
    if (/(?:Client|Gateway)$/.test(dependency)) addSignal(signals, "dependency-shape", "client-or-gateway");
  }
  if (annotations.includes("Override")) addSignal(signals, "override-style", "annotated");

  return {
    path,
    ...(packageName ? { packageName } : {}),
    ...(declarationKind ? { declarationKind } : {}),
    role: role.role,
    roleConfidence: role.confidence,
    sourceKind: detectSourceKind(path, repositoryRoot),
    annotations,
    imports,
    superTypes,
    signals: Object.fromEntries(
      [...signals.entries()].map(([category, patterns]) => [category, uniqueSorted(patterns)]),
    ),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    contentHash: createHash("sha256").update(source).digest("hex"),
    generated: isGeneratedJava(path, source, annotations, repositoryRoot),
    deprecated: annotations.includes("Deprecated"),
  };
}

export function analyzeJavaFile(path: string, repositoryRoot?: string): JavaFileFacts {
  const size = statSync(path).size;
  if (size > MAX_ANALYZED_FILE_BYTES) {
    throw new Error(`Source file too large to analyze (${size} bytes > ${MAX_ANALYZED_FILE_BYTES})`);
  }
  return analyzeJavaSource(path, readFileSync(path, "utf8"), repositoryRoot);
}
