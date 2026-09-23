import { relative, resolve, sep } from "node:path";
import { estimateTokens } from "../observe/snapshot-formatter.js";
import type { ResolvedProjectContext } from "./types.js";

export interface FormattedKnowledgeCapsule {
  text: string;
  tokenEstimate: number;
  includedKnowledgeIds: string[];
  includedConventionIds: string[];
  truncated: boolean;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function displayPath(repositoryRoot: string, path: string): string {
  const value = relative(resolve(repositoryRoot), resolve(path));
  if (value === "" || value === ".") return ".";
  if (value === ".." || value.startsWith(`..${sep}`)) return path.split(sep).join("/");
  return value.split(sep).join("/");
}

export function formatKnowledgeCapsule(
  context: ResolvedProjectContext,
  repositoryRoot: string,
  maxTokens = 400,
): FormattedKnowledgeCapsule {
  const minimumBudget = Math.max(80, maxTokens);
  const opening = `<project-knowledge profile="${escapeXml(displayPath(repositoryRoot, context.profilePath))}" review="${context.reviewStatus}">`;
  const fixedLines = [
    opening,
    `Matched modules: ${context.matchedModuleIds.length > 0 ? context.matchedModuleIds.map(escapeXml).join(", ") : "repository"}`,
    ...(context.effectiveRole ? [`Effective role: ${escapeXml(context.effectiveRole)}`] : []),
    ...(context.architecture.length > 0
      ? [`Architecture: ${context.architecture.map(escapeXml).join(", ")}`]
      : []),
    ...(context.technologies.length > 0
      ? [
          `Technology: ${context.technologies
            .map((item) => escapeXml(`${item.id}${item.version ? `@${item.version}` : ""}`))
            .join(", ")}`,
        ]
      : []),
    ...(context.reviewStatus === "draft"
      ? ["Draft profile: treat all items as advisory until user review."]
      : []),
  ];
  const closing = [
    "Use only matched project knowledge. Local source evidence and executable checks remain authoritative within their scope.",
    "</project-knowledge>",
  ];
  const body: string[] = [];
  const includedKnowledgeIds: string[] = [];
  const includedConventionIds: string[] = [];
  let truncated = false;

  const fits = (candidateBody: readonly string[]): boolean =>
    estimateTokens([...fixedLines, ...candidateBody, ...closing].join("\n")) <= minimumBudget;

  for (const resolved of context.knowledge) {
    const item = resolved.item;
    const line = `- [${resolved.strength}/${resolved.sourceKind}] ${escapeXml(item.title)}: ${escapeXml(item.summary)}`;
    if (!fits([...body, ...(body.length === 0 ? ["Knowledge:"] : []), line])) {
      truncated = true;
      continue;
    }
    if (body.length === 0) body.push("Knowledge:");
    body.push(line);
    includedKnowledgeIds.push(item.id);
  }

  let conventionHeadingAdded = false;
  for (const resolved of context.conventions) {
    const item = resolved.item;
    const line = `- [${resolved.strength}/${resolved.sourceKind}] ${escapeXml(item.category)}: ${escapeXml(item.statement)}`;
    if (!fits([...body, ...(conventionHeadingAdded ? [] : ["Project conventions:"]), line])) {
      truncated = true;
      continue;
    }
    if (!conventionHeadingAdded) {
      body.push("Project conventions:");
      conventionHeadingAdded = true;
    }
    body.push(line);
    includedConventionIds.push(item.id);
  }

  if (truncated && fits([...body, "- Additional matched profile items omitted by token budget."])) {
    body.push("- Additional matched profile items omitted by token budget.");
  }

  const text = [...fixedLines, ...body, ...closing].join("\n");
  return {
    text,
    tokenEstimate: estimateTokens(text),
    includedKnowledgeIds,
    includedConventionIds,
    truncated,
  };
}
