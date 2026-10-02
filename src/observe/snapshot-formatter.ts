import { relative } from "node:path";
import { escapeXml } from "../runtime/xml.js";
import type { ConventionObservation, ConventionSnapshot } from "./types.js";

// CJK ideographs, kana, hangul and full-width forms: tokenizers spend about one token per character on
// them, against roughly four characters per token for Latin text. Counting them as Latin would
// under-estimate Chinese Profiles and Snapshots by two to four times and blow the Context budget.
// Plain comparisons: this runs over every character of text that the trimming loops re-estimate on
// each iteration, so it must not allocate.
function isCjk(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x30ff) || // CJK symbols and punctuation, hiragana, katakana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
    (code >= 0xac00 && code <= 0xd7af) || // hangul syllables
    (code >= 0xff00 && code <= 0xffef) // full-width forms
  );
}

export function estimateTokens(text: string): number {
  let cjk = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (isCjk(text.charCodeAt(index))) cjk += 1;
  }
  return Math.ceil((text.length - cjk) / 4 + cjk);
}

function shorten(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `…${value.slice(-(maxLength - 1))}`;
}

function relativeDisplay(root: string, path: string): string {
  const value = relative(root, path).replaceAll("\\", "/") || ".";
  return shorten(value, 120);
}

function observationLine(observation: ConventionObservation): string {
  const counter = observation.counterEvidence.length > 0
    ? `; counter=${observation.counterEvidence.length}`
    : "";
  return `- [${observation.confidence}/${observation.status}] ${escapeXml(observation.category)}: ${escapeXml(observation.pattern)} (${observation.support}/${observation.samples}${counter})`;
}

function renderSnapshot(
  snapshot: ConventionSnapshot,
  repositoryRoot: string,
  observations: readonly ConventionObservation[],
  candidatePaths: readonly string[],
): string {
  const lines = [
    `<local-convention scope="${escapeXml(`${snapshot.scope.language}:${snapshot.scope.module}:${snapshot.scope.effectiveRole ?? snapshot.scope.role}`)}" confidence="${snapshot.scope.confidence}" status="${snapshot.status}">`,
    "Target:",
    `- ${escapeXml(relativeDisplay(repositoryRoot, snapshot.targetPath))}`,
    "",
    candidatePaths.length < snapshot.evidenceFiles.length
      ? `Comparable implementations (showing ${candidatePaths.length} of ${snapshot.evidenceFiles.length}):`
      : "Comparable implementations:",
    ...(candidatePaths.length > 0
      ? candidatePaths.map((path) => `- ${escapeXml(relativeDisplay(repositoryRoot, path))}`)
      : ["- none found"]),
    "",
    "Repeated observations:",
    ...(observations.length > 0
      ? observations.map(observationLine)
      : ["- insufficient repeated evidence; do not infer a local convention"]),
    "",
    "Instruction:",
    "Use this as local consistency evidence, not an absolute rule.",
    "Explicit requirements and executable checks take precedence.",
    "Do not refactor unrelated code solely to match these observations.",
    "</local-convention>",
  ];
  return lines.join("\n");
}

function findLastObservationIndex(
  observations: readonly ConventionObservation[],
  predicate: (observation: ConventionObservation) => boolean,
): number {
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index];
    if (observation && predicate(observation)) return index;
  }
  return -1;
}

export function formatConventionSnapshot(
  snapshot: ConventionSnapshot,
  repositoryRoot: string,
  maxTokens: number,
): { text: string; tokenEstimate: number; includedObservationIds: string[] } {
  const displayRoot = snapshot.repositoryRoot || repositoryRoot;
  const usable = snapshot.observations.filter(
    (observation) => observation.confidence !== "low" || snapshot.status === "weak",
  );
  let observations = usable.slice();
  let candidates = snapshot.evidenceFiles.map((evidence) => evidence.path);
  let text = renderSnapshot(snapshot, displayRoot, observations, candidates);

  while (estimateTokens(text) > maxTokens && observations.some((item) => item.confidence === "low")) {
    const lastLow = findLastObservationIndex(observations, (item) => item.confidence === "low");
    observations = observations.filter((_item, index) => index !== lastLow);
    text = renderSnapshot(snapshot, displayRoot, observations, candidates);
  }
  while (estimateTokens(text) > maxTokens && observations.some((item) => item.status === "mixed")) {
    const lastMixed = findLastObservationIndex(observations, (item) => item.status === "mixed");
    observations = observations.filter((_item, index) => index !== lastMixed);
    text = renderSnapshot(snapshot, displayRoot, observations, candidates);
  }
  while (estimateTokens(text) > maxTokens && observations.length > 1) {
    observations = observations.slice(0, -1);
    text = renderSnapshot(snapshot, displayRoot, observations, candidates);
  }
  while (estimateTokens(text) > maxTokens && candidates.length > 0) {
    candidates = candidates.slice(0, -1);
    text = renderSnapshot(snapshot, displayRoot, observations, candidates);
  }
  while (estimateTokens(text) > maxTokens && observations.length > 0) {
    observations = observations.slice(0, -1);
    text = renderSnapshot(snapshot, displayRoot, observations, candidates);
  }

  if (estimateTokens(text) > maxTokens) {
    observations = [];
    const scope = `${shorten(snapshot.scope.language, 16)}:${shorten(snapshot.scope.module, 32)}:${shorten(snapshot.scope.effectiveRole ?? snapshot.scope.role, 32)}`;
    text = [
      `<local-convention scope="${escapeXml(scope)}" status="${snapshot.status}">`,
      "Evidence details omitted to fit the context budget.",
      "Treat local conventions as evidence, not absolute rules.",
      "</local-convention>",
    ].join("\n");
  }
  // If even the minimal closed form exceeds the budget, return it as is with its true estimate: the
  // caller skips what does not fit. Cutting it would inject an unclosed tag into the model context.
  return {
    text,
    tokenEstimate: estimateTokens(text),
    includedObservationIds: observations.map((observation) => observation.id),
  };
}
