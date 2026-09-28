import { relative, resolve, sep } from "node:path";
import { estimateTokens } from "../observe/snapshot-formatter.js";
import type {
  FormattedPracticeCapsule,
  PracticeAnalysisResult,
  PracticeSignal,
} from "./types.js";

const MAX_INCLUDED_SIGNALS = 6;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function displayPath(repositoryRoot: string, targetPath: string): string {
  const value = relative(resolve(repositoryRoot), resolve(targetPath));
  if (value === "" || value === ".") return ".";
  if (value === ".." || value.startsWith(`..${sep}`)) return targetPath.split(sep).join("/");
  return value.split(sep).join("/");
}

function confidenceRank(signal: PracticeSignal): number {
  if (signal.confidence === "high") return 0;
  if (signal.confidence === "medium") return 1;
  return 2;
}

function stableSignals(analyses: readonly PracticeAnalysisResult[]): PracticeSignal[] {
  const seen = new Set<string>();
  return analyses
    .flatMap((analysis) => analysis.signals)
    .filter((signal) => signal.confidence !== "low")
    .sort((left, right) =>
      confidenceRank(left) - confidenceRank(right) ||
      left.targetPath.localeCompare(right.targetPath) ||
      left.id.localeCompare(right.id),
    )
    .filter((signal) => {
      const key = `${signal.repositoryRoot}\0${signal.targetPath}\0${signal.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function formatPracticeCapsule(
  analyses: readonly PracticeAnalysisResult[],
  maxTokens: number,
): FormattedPracticeCapsule | undefined {
  const signals = stableSignals(analyses);
  if (signals.length === 0 || maxTokens <= 0) return undefined;

  const opening = '<engineering-practice status="advisory">';
  const closing = [
    "Avoid:",
    "- Comments that restate the code.",
    "- Splitting methods without improving responsibility or failure boundaries.",
    "- Introducing abstractions for hypothetical future requirements.",
    "</engineering-practice>",
  ];
  const base = [opening, "Review only the questions supported by these deterministic structure signals."];
  if (estimateTokens([...base, ...closing].join("\n")) > maxTokens) return undefined;

  const body: string[] = [];
  const includedSignalIds: string[] = [];
  let truncated = false;

  for (const item of signals) {
    if (includedSignalIds.length >= MAX_INCLUDED_SIGNALS) {
      truncated = true;
      break;
    }
    const target = escapeXml(displayPath(item.repositoryRoot, item.targetPath));
    const facts = item.facts.map((value) => `${value.name}=${value.count}`).join(", ");
    const lines = [
      `- [${item.confidence}/${item.category}] ${target} (${escapeXml(facts)})`,
      `  Question: ${escapeXml(item.reviewQuestion)}`,
    ];
    if (estimateTokens([...base, ...body, ...lines, ...closing].join("\n")) > maxTokens) {
      truncated = true;
      continue;
    }
    body.push(...lines);
    includedSignalIds.push(item.id);
  }

  if (includedSignalIds.length === 0) return undefined;
  if (
    truncated &&
    estimateTokens([...base, ...body, "- Additional low-priority practice signals omitted by token budget.", ...closing].join("\n")) <= maxTokens
  ) {
    body.push("- Additional low-priority practice signals omitted by token budget.");
  }

  const text = [...base, ...body, ...closing].join("\n");
  return {
    text,
    tokenEstimate: estimateTokens(text),
    includedSignalIds,
  };
}

export function formatOneShotPracticeReview(
  analyses: readonly PracticeAnalysisResult[],
  maxTokens: number,
): FormattedPracticeCapsule | undefined {
  const instruction = [
    '<engineering-practice-review status="one-shot">',
    "Perform one concise final self-review using only the supported questions below.",
    "If no change is warranted, keep the code unchanged; do not manufacture comments, splits, abstractions, or tests.",
    "If you do change code, run the relevant executable checks before finishing.",
    "</engineering-practice-review>",
  ].join("\n");
  const instructionTokens = estimateTokens(`${instruction}\n\n`);
  const capsule = formatPracticeCapsule(analyses, maxTokens - instructionTokens);
  if (!capsule) return undefined;

  const text = `${instruction}\n\n${capsule.text}`;
  const tokenEstimate = estimateTokens(text);
  if (tokenEstimate > maxTokens) return undefined;
  return {
    text,
    tokenEstimate,
    includedSignalIds: capsule.includedSignalIds,
  };
}
