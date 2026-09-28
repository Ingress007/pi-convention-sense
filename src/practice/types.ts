import type { ObserveLanguage } from "../observe/types.js";

export const PRACTICE_ANALYZER_VERSION = "practice-lexical-v1";

export type PracticeConfidence = "high" | "medium" | "low";

export type PracticeCategory =
  | "transaction-side-effect"
  | "responsibility-boundary"
  | "state-persistence"
  | "failure-path"
  | "compatibility-intent"
  | "variation-axis";

export interface PracticeFact {
  name: string;
  count: number;
}

export interface PracticeSignal {
  id: string;
  category: PracticeCategory;
  targetPath: string;
  repositoryRoot: string;
  language: ObserveLanguage;
  confidence: PracticeConfidence;
  facts: PracticeFact[];
  reviewQuestion: string;
  source: "deterministic-source-structure";
  analyzerVersion: string;
}

export type PracticeAnalysisReason =
  | "prospective-target"
  | "target-missing"
  | "target-too-large"
  | "non-production-target"
  | "read-error";

export type PracticeAnalysisBasis = "snapshot" | "successful-read";

export interface PracticeAnalysisResult {
  targetPath: string;
  basis: PracticeAnalysisBasis;
  signals: PracticeSignal[];
  reason?: PracticeAnalysisReason;
  durationMs: number;
}

export interface FormattedPracticeCapsule {
  text: string;
  tokenEstimate: number;
  includedSignalIds: string[];
}
