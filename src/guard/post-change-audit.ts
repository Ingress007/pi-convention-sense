import { resolve } from "node:path";
import { PathSet, pathKey } from "../runtime/path-key.js";
import { normalizeToolPath } from "../runtime/paths.js";
import { escapeXml } from "../runtime/xml.js";

export interface PostChangeFinding {
  path: string;
  reasonCode: "POST_CHANGE_EVIDENCE_GAP";
  detectedAt: number;
  delivered: boolean;
}

export class PostChangeAuditRuntime {
  private readonly byPath = new Map<string, PostChangeFinding>();

  addGap(path: string, now = Date.now()): void {
    this.byPath.set(pathKey(path), {
      path: resolve(path),
      reasonCode: "POST_CHANGE_EVIDENCE_GAP",
      detectedAt: now,
      delivered: false,
    });
  }

  undelivered(): PostChangeFinding[] {
    return this.all().filter((finding) => !finding.delivered);
  }

  markDelivered(findings: readonly PostChangeFinding[]): void {
    for (const finding of findings) {
      const current = this.byPath.get(pathKey(finding.path));
      if (current) current.delivered = true;
    }
  }

  resolve(paths: readonly string[]): number {
    let resolved = 0;
    for (const path of paths) {
      if (this.byPath.delete(pathKey(path))) resolved += 1;
    }
    return resolved;
  }

  all(): PostChangeFinding[] {
    return [...this.byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  clear(): void {
    this.byPath.clear();
  }
}

export interface ChangedSourceInput {
  cwd: string;
  /** Paths as Git reports them: relative to `cwd`. */
  changedPaths: readonly string[];
  isProductionSource(absolutePath: string): boolean;
  isExcluded(absolutePath: string): boolean;
  isException(absolutePath: string): boolean;
}

/** The changed files the audit cares about: configured production sources that are neither excluded nor excepted. */
export function selectChangedSources(input: ChangedSourceInput): string[] {
  return input.changedPaths
    .map((path) => normalizeToolPath(input.cwd, path))
    .filter((path) => input.isProductionSource(path))
    .filter((path) => !input.isExcluded(path))
    .filter((path) => !input.isException(path));
}

/** The changed sources whose Discovery was not complete before the command ran. */
export function selectEvidenceGaps(changedSources: readonly string[], coveredBefore: PathSet): string[] {
  return changedSources.filter((path) => !coveredBefore.has(path));
}

export function createPostChangeAuditMessage(
  displayPaths: readonly string[],
  mode: "observe" | "guard",
) {
  const content = [
    `<convention-post-change-audit mode="${mode}" status="evidence-gap">`,
    "A shell command changed configured source files without verified preflight Convention Evidence:",
    ...displayPaths.map((path) => `- ${escapeXml(path)}`),
    "Before further edits, read each affected target and relevant peers so Convention Sense can rebuild a fresh Snapshot.",
    "Do not automatically revert the completed shell command.",
    "</convention-post-change-audit>",
  ].join("\n");
  return {
    role: "custom" as const,
    customType: "pi-convention-sense-post-change-audit",
    content,
    display: false,
    details: {
      stage: 2,
      reasonCode: "POST_CHANGE_EVIDENCE_GAP",
      paths: [...displayPaths],
    },
    timestamp: Date.now(),
  };
}
