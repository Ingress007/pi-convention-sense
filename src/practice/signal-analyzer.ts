import { existsSync, readFileSync, statSync } from "node:fs";
import { detectSourceKind } from "../observe/java-analyzer.js";
import { detectTypeScriptSourceKind } from "../observe/typescript-analyzer.js";
import type { ConventionSnapshot, ObserveLanguage } from "../observe/types.js";
import {
  PRACTICE_ANALYZER_VERSION,
  type PracticeAnalysisResult,
  type PracticeCategory,
  type PracticeConfidence,
  type PracticeFact,
  type PracticeSignal,
} from "./types.js";

const MAX_SOURCE_BYTES = 256 * 1024;

function maskCommentsAndStrings(source: string, javaTextBlocks = false): string {
  // UTF-16 units, like the indexes below: spreading into code points would shift every write after an emoji.
  const output = source.split("");
  let state: "code" | "line" | "block" | "single" | "double" | "template" | "text-block" = "code";

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (state === "text-block") {
      // Java text block: its content may hold quotes, comments and code-like text.
      if (current === "\\") {
        output[index] = " ";
        if (index + 1 < output.length) output[index + 1] = " ";
        index += 1;
      } else if (current === '"' && next === '"' && source[index + 2] === '"') {
        output[index] = " ";
        output[index + 1] = " ";
        output[index + 2] = " ";
        state = "code";
        index += 2;
      } else if (current !== "\n" && current !== "\r") {
        output[index] = " ";
      }
      continue;
    }
    if (state === "code") {
      if (javaTextBlocks && current === '"' && next === '"' && source[index + 2] === '"') {
        output[index] = " ";
        output[index + 1] = " ";
        output[index + 2] = " ";
        state = "text-block";
        index += 2;
      } else if (current === "/" && next === "/") {
        output[index] = " ";
        output[index + 1] = " ";
        state = "line";
        index += 1;
      } else if (current === "/" && next === "*") {
        output[index] = " ";
        output[index + 1] = " ";
        state = "block";
        index += 1;
      } else if (current === "'") {
        output[index] = " ";
        state = "single";
      } else if (current === '"') {
        output[index] = " ";
        state = "double";
      } else if (current === "`") {
        output[index] = " ";
        state = "template";
      }
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
      } else if (current !== "\n" && current !== "\r") {
        output[index] = " ";
      }
      continue;
    }

    if (current === "\\") {
      output[index] = " ";
      if (index + 1 < output.length) output[index + 1] = " ";
      index += 1;
      continue;
    }
    output[index] = current === "\n" || current === "\r" ? current : " ";
    if (
      (state === "single" && current === "'") ||
      (state === "double" && current === '"') ||
      (state === "template" && current === "`")
    ) {
      state = "code";
    }
  }
  return output.join("");
}

// The index of the `>` that ends an opening tag, or -1. A `>` inside a quoted attribute value does not count:
// Vue 3.3 writes `<script setup generic="T extends Array<string>">`.
function openingTagEnd(source: string, from: number): number {
  let quote = "";
  for (let index = from; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return -1;
}

// Each search starts where the previous block ended, so an unterminated tag costs one pass instead of one per tag.
function vueScriptBlocks(source: string): string[] {
  const blocks: string[] = [];
  const opening = /<script\b/gi;
  const closing = /<\/script>/gi;
  let cursor = 0;
  for (;;) {
    opening.lastIndex = cursor;
    const open = opening.exec(source);
    if (!open) break;
    const tagEnd = openingTagEnd(source, open.index + open[0].length);
    if (tagEnd < 0) break;
    closing.lastIndex = tagEnd + 1;
    const close = closing.exec(source);
    if (!close) break;
    const block = source.slice(tagEnd + 1, close.index);
    if (block.length > 0) blocks.push(block);
    cursor = close.index + close[0].length;
  }
  return blocks;
}

function sourceCode(language: ObserveLanguage, source: string): string {
  if (language !== "vue") return maskCommentsAndStrings(source, language === "java");
  return maskCommentsAndStrings(vueScriptBlocks(source).join("\n"));
}

function countMatches(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function fact(name: string, count: number): PracticeFact {
  return { name, count };
}

interface SignalInput {
  targetPath: string;
  repositoryRoot: string;
  language: ObserveLanguage;
  category: PracticeCategory;
  confidence: PracticeConfidence;
  facts: PracticeFact[];
  reviewQuestion: string;
}

function signal(input: SignalInput): PracticeSignal {
  return {
    id: `practice.${input.category}`,
    category: input.category,
    targetPath: input.targetPath,
    repositoryRoot: input.repositoryRoot,
    language: input.language,
    confidence: input.confidence,
    facts: input.facts,
    reviewQuestion: input.reviewQuestion,
    source: "deterministic-source-structure",
    analyzerVersion: PRACTICE_ANALYZER_VERSION,
  };
}

export function analyzePracticeSource(
  targetPath: string,
  repositoryRoot: string,
  language: ObserveLanguage,
  source: string,
): PracticeSignal[] {
  const code = sourceCode(language, source);
  const transactionMarkers = countMatches(
    code,
    language === "java"
      ? /@Transactional\b|\btransactionTemplate\s*\.\s*execute\s*\(/gi
      : /\b(?:transaction|transactional)\s*\(/gi,
  );
  const externalCalls = countMatches(
    code,
    language === "java"
      // `\w*(?:keyword)\w*` is quadratic in the length of one identifier that repeats the keyword, hence the bounds.
      ? /\b\w{0,100}(?:client|gateway|producer|publisher|sender|notifier|webhook|remote|kafka|rabbit)\w{0,100}\s*\.\s*\w+\s*\(/gi
      : /\b(?:fetch|axios(?:\.\w+)?|\w*(?:client|gateway|request|http|api))\s*(?:\.\s*\w+)?\s*\(/gi,
  );
  const persistenceCalls = countMatches(
    code,
    /\b\w{0,100}(?:mapper|repository|repo|dao)\w{0,100}\s*\.\s*(?:save|insert|update|delete|persist|merge|upsert|select|find\w*)\s*\(/gi,
  );
  const validationMarkers = countMatches(
    code,
    /\bthrow\s+new\b|\b(?:validate|check|require|assert)\w*\s*\(|@(?:Valid|Validated|NotNull|NotBlank)\b/g,
  );
  const stateTransitions = countMatches(
    code,
    /(?:\.|\b)(?:status|state|stage)\s*=|\bset(?:Status|State|Stage)\s*\(/g,
  );
  const mappingMarkers = countMatches(
    code,
    /\b\w{0,100}(?:converter|assembler)\w{0,100}\s*\.\s*\w+\s*\(|\b(?:toResponse|buildResponse|fromEntity)\s*\(/gi,
  );
  const catchMarkers = countMatches(code, /\bcatch\s*\(/g);
  const receiverRecoveryCalls = countMatches(
    code,
    /\.\s*(?:fallback\w*|compensat\w*|rollback\w*|recover\w*|retry)\s*\(/gi,
  );
  const localRecoveryCalls = catchMarkers > 0
    ? countMatches(code, /\b(?:fallback\w*|compensat\w*|rollback\w*|recover\w*|retry)\s*\(/gi)
    : 0;
  const frameworkRecoveryMarkers = countMatches(
    code,
    /@Retryable\b|\bRetryTemplate\s*\.\s*execute\s*\(/g,
  );
  const fallbackMarkers = Math.max(receiverRecoveryCalls, localRecoveryCalls) + frameworkRecoveryMarkers;
  const compatibilityMarkers = countMatches(
    code,
    /\b(?:legacy\w*|compat\w*|backward\w*|workaround\w*|migration\w*|oldVersion\w*)\b/gi,
  );
  const switchMarkers = countMatches(code, /\bswitch\s*\(/g);
  const caseMarkers = countMatches(code, /\bcase\s+[^:\n]{1,200}:/g);
  const typeDispatchMarkers = countMatches(code, /\binstanceof\s+[A-Za-z_$][\w$]*/g);

  const signals: PracticeSignal[] = [];
  if (transactionMarkers > 0 && externalCalls > 0) {
    signals.push(signal({
      targetPath,
      repositoryRoot,
      language,
      category: "transaction-side-effect",
      confidence: "high",
      facts: [fact("transaction-markers", transactionMarkers), fact("external-call-sites", externalCalls)],
      reviewQuestion: "Do the external side effects participate in a transaction-sensitive flow, and what happens on partial failure?",
    }));
  }

  const responsibilities = [
    validationMarkers > 0,
    persistenceCalls > 0,
    externalCalls > 0,
    stateTransitions > 0,
    mappingMarkers > 0,
  ].filter(Boolean).length;
  if (responsibilities >= 3) {
    signals.push(signal({
      targetPath,
      repositoryRoot,
      language,
      category: "responsibility-boundary",
      confidence: "medium",
      facts: [fact("responsibility-dimensions", responsibilities)],
      reviewQuestion: "Are validation, state changes, persistence, external calls, and result assembly separated at clear responsibility and failure boundaries?",
    }));
  }

  if (stateTransitions > 0 && persistenceCalls > 0) {
    signals.push(signal({
      targetPath,
      repositoryRoot,
      language,
      category: "state-persistence",
      confidence: "medium",
      facts: [fact("state-transition-sites", stateTransitions), fact("persistence-call-sites", persistenceCalls)],
      reviewQuestion: "Are state-transition invariants and persistence ordering explicit, including the behavior when persistence fails?",
    }));
  }

  if (fallbackMarkers > 0) {
    signals.push(signal({
      targetPath,
      repositoryRoot,
      language,
      category: "failure-path",
      confidence: "medium",
      facts: [fact("fallback-retry-compensation-markers", fallbackMarkers)],
      reviewQuestion: "Does the fallback, retry, recovery, or compensation path preserve failure semantics and have a meaningful negative-path test?",
    }));
  }

  if (compatibilityMarkers > 0) {
    signals.push(signal({
      targetPath,
      repositoryRoot,
      language,
      category: "compatibility-intent",
      confidence: "medium",
      facts: [fact("compatibility-markers", compatibilityMarkers)],
      reviewQuestion: "Is the compatibility or workaround branch's reason and removal condition clear, using a short why-comment only when names and types cannot express it?",
    }));
  }

  if ((switchMarkers > 0 && caseMarkers >= 3) || typeDispatchMarkers >= 3) {
    signals.push(signal({
      targetPath,
      repositoryRoot,
      language,
      category: "variation-axis",
      confidence: "medium",
      facts: [
        fact("switch-statements", switchMarkers),
        fact("case-labels", caseMarkers),
        fact("type-dispatch-sites", typeDispatchMarkers),
      ],
      reviewQuestion: "Does this multi-branch dispatch represent a stable variation axis? Prefer simple or data-driven branching unless multiple real implementations justify an abstraction.",
    }));
  }

  return signals;
}

export function analyzePracticeTarget(
  targetPath: string,
  repositoryRoot: string,
  language: ObserveLanguage,
): PracticeAnalysisResult {
  const startedAt = Date.now();
  const base = {
    targetPath,
    basis: "successful-read" as const,
    durationMs: 0,
  };
  if (!existsSync(targetPath)) {
    return { ...base, signals: [], reason: "target-missing" };
  }
  const sourceKind = language === "java"
    ? detectSourceKind(targetPath, repositoryRoot)
    : detectTypeScriptSourceKind(targetPath, repositoryRoot);
  if (sourceKind !== "production") {
    return { ...base, signals: [], reason: "non-production-target" };
  }

  try {
    if (statSync(targetPath).size > MAX_SOURCE_BYTES) {
      return { ...base, signals: [], reason: "target-too-large", durationMs: Date.now() - startedAt };
    }
    const source = readFileSync(targetPath, "utf8");
    return {
      ...base,
      signals: analyzePracticeSource(targetPath, repositoryRoot, language, source),
      durationMs: Date.now() - startedAt,
    };
  } catch {
    return { ...base, signals: [], reason: "read-error", durationMs: Date.now() - startedAt };
  }
}

export function analyzePracticeSnapshot(snapshot: ConventionSnapshot): PracticeAnalysisResult {
  if (snapshot.targetKind === "prospective") {
    return {
      targetPath: snapshot.targetPath,
      basis: "snapshot",
      signals: [],
      reason: "prospective-target",
      durationMs: 0,
    };
  }
  return {
    ...analyzePracticeTarget(
      snapshot.targetPath,
      snapshot.repositoryRoot,
      snapshot.scope.language,
    ),
    basis: "snapshot",
  };
}
