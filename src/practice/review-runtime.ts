import { resolve } from "node:path";

export type PracticeMutationRelevance = "relevant" | "unknown" | "irrelevant";

export interface PracticeReviewMutation {
  path: string;
  relevance: PracticeMutationRelevance;
}

export interface PracticeReviewTaskState {
  generation: number;
  mutations: PracticeReviewMutation[];
  requested: boolean;
}

export type PracticeReviewSkipReason =
  | "task-not-started"
  | "already-requested"
  | "agent-aborted"
  | "agent-error"
  | "continuation-already-pending"
  | "no-mutation"
  | "no-relevant-mutation"
  | "no-eligible-target";

export type PracticeReviewBoundaryPlan =
  | { action: "skip"; reason: PracticeReviewSkipReason }
  | { action: "analyze"; targets: string[] };

const PRACTICE_CHANGE_MARKER = /(?:@Transactional|\b(?:transaction|commit|rollback|catch|throw|retry|fallback|recover|compensat|legacy|compatib|migration|switch|case)\b|\.set[A-Z][\w$]*\s*\(|\b[\w$]*(?:mapper|repository|dao|client|gateway|producer|publisher)[\w$]*\s*\.)/iu;

function textHasPracticeMarker(value: unknown): boolean {
  return typeof value === "string" && PRACTICE_CHANGE_MARKER.test(value);
}

export function classifyPracticeMutationInput(
  operation: "edit" | "write",
  input: Record<string, unknown>,
): PracticeMutationRelevance {
  if (operation === "write") {
    if (typeof input.content !== "string") return "unknown";
    return textHasPracticeMarker(input.content) ? "relevant" : "irrelevant";
  }

  if (!Array.isArray(input.edits)) return "unknown";
  return input.edits.some((edit) => {
    if (typeof edit !== "object" || edit === null) return false;
    const value = edit as { oldText?: unknown; newText?: unknown };
    return textHasPracticeMarker(value.oldText) || textHasPracticeMarker(value.newText);
  })
    ? "relevant"
    : "irrelevant";
}

function relevanceRank(value: PracticeMutationRelevance): number {
  if (value === "relevant") return 2;
  if (value === "unknown") return 1;
  return 0;
}

export function planPracticeReviewBoundary(input: {
  task: PracticeReviewTaskState;
  outcome: "completed" | "aborted" | "error";
  continuationPending: boolean;
  successfulReads: ReadonlySet<string>;
  maxTargets: number;
  isEligible(path: string): boolean;
}): PracticeReviewBoundaryPlan {
  if (input.task.generation === 0) return { action: "skip", reason: "task-not-started" };
  if (input.task.requested) return { action: "skip", reason: "already-requested" };
  if (input.outcome !== "completed") return { action: "skip", reason: `agent-${input.outcome}` };
  if (input.continuationPending) return { action: "skip", reason: "continuation-already-pending" };
  if (input.task.mutations.length === 0) return { action: "skip", reason: "no-mutation" };

  const reviewable = input.task.mutations.filter((mutation) => mutation.relevance !== "irrelevant");
  if (reviewable.length === 0) return { action: "skip", reason: "no-relevant-mutation" };
  const targets = reviewable
    .map((mutation) => mutation.path)
    .filter((path) => input.successfulReads.has(path))
    .filter((path) => input.isEligible(path))
    .slice(0, input.maxTargets);
  return targets.length > 0
    ? { action: "analyze", targets }
    : { action: "skip", reason: "no-eligible-target" };
}

export class PracticeReviewRuntime {
  private generation = 0;
  private readonly mutations = new Map<string, PracticeMutationRelevance>();
  private requested = false;

  beginTask(): number {
    this.generation += 1;
    this.mutations.clear();
    this.requested = false;
    return this.generation;
  }

  recordMutation(path: string, relevance: PracticeMutationRelevance = "unknown"): void {
    if (this.generation === 0) return;
    const normalized = resolve(path);
    const current = this.mutations.get(normalized);
    if (!current || relevanceRank(relevance) > relevanceRank(current)) {
      this.mutations.set(normalized, relevance);
    }
  }

  requestOnce(): boolean {
    if (this.generation === 0 || this.requested) return false;
    this.requested = true;
    return true;
  }

  current(): PracticeReviewTaskState {
    return {
      generation: this.generation,
      mutations: [...this.mutations.entries()]
        .map(([path, relevance]) => ({ path, relevance }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      requested: this.requested,
    };
  }

  reset(): void {
    this.generation = 0;
    this.mutations.clear();
    this.requested = false;
  }
}
