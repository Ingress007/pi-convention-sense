import { relative } from "node:path";
import type { ConventionObservation, ConventionSnapshot } from "./types.js";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
  return `- [${observation.confidence}/${observation.status}] ${observation.category}: ${observation.pattern} (${observation.support}/${observation.samples}${counter})`;
}

function renderSnapshot(
  snapshot: ConventionSnapshot,
  repositoryRoot: string,
  observations: readonly ConventionObservation[],
  candidatePaths: readonly string[],
): string {
  const lines = [
    `<local-convention scope="${snapshot.scope.language}:${snapshot.scope.module}:${snapshot.scope.effectiveRole ?? snapshot.scope.role}" confidence="${snapshot.scope.confidence}" status="${snapshot.status}">`,
    "Target:",
    `- ${relativeDisplay(repositoryRoot, snapshot.targetPath)}`,
    "",
    candidatePaths.length < snapshot.evidenceFiles.length
      ? `Comparable implementations (showing ${candidatePaths.length} of ${snapshot.evidenceFiles.length}):`
      : "Comparable implementations:",
    ...(candidatePaths.length > 0
      ? candidatePaths.map((path) => `- ${relativeDisplay(repositoryRoot, path)}`)
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
      `<local-convention scope="${scope}" status="${snapshot.status}">`,
      "Evidence details omitted to fit the context budget.",
      "Treat local conventions as evidence, not absolute rules.",
      "</local-convention>",
    ].join("\n");
  }
  if (estimateTokens(text) > maxTokens) {
    text = text.slice(0, Math.max(0, maxTokens * 4));
  }

  return {
    text,
    tokenEstimate: estimateTokens(text),
    includedObservationIds: observations.map((observation) => observation.id),
  };
}
