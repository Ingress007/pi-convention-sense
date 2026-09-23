import { resolve } from "node:path";

export interface PostChangeFinding {
  path: string;
  reasonCode: "POST_CHANGE_EVIDENCE_GAP";
  detectedAt: number;
  delivered: boolean;
}

export class PostChangeAuditRuntime {
  private readonly byPath = new Map<string, PostChangeFinding>();

  addGap(path: string, now = Date.now()): void {
    const key = resolve(path);
    this.byPath.set(key, {
      path: key,
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
      const current = this.byPath.get(resolve(finding.path));
      if (current) current.delivered = true;
    }
  }

  resolve(paths: readonly string[]): number {
    let resolved = 0;
    for (const path of paths) {
      if (this.byPath.delete(resolve(path))) resolved += 1;
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

export function createPostChangeAuditMessage(
  displayPaths: readonly string[],
  mode: "observe" | "guard",
) {
  const content = [
    `<convention-post-change-audit mode="${mode}" status="evidence-gap">`,
    "A shell command changed configured source files without verified preflight Convention Evidence:",
    ...displayPaths.map((path) => `- ${path}`),
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
