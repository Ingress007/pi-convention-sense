import { isAbsolute, relative, resolve, sep } from "node:path";

export function normalizeToolPath(cwd: string, rawPath: string): string {
  const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  return resolve(cwd, withoutAt);
}

export function displayPath(cwd: string, absolutePath: string): string {
  const rel = relative(cwd, absolutePath);
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  const value = outside ? absolutePath : rel || ".";
  return value.split(sep).join("/");
}

export function getPathInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

const SHELL_MUTATION_PATTERNS: Array<{ tag: string; pattern: RegExp }> = [
  { tag: "redirect", pattern: /(^|[^>])>{1,2}\s*[^&]/m },
  { tag: "in-place-edit", pattern: /\b(?:sed|perl)\b[^\n]*(?:-i|--in-place)\b/i },
  { tag: "file-command", pattern: /\b(?:rm|mv|cp|touch|truncate|install)\b/i },
  { tag: "tee", pattern: /\btee\b/i },
  { tag: "script", pattern: /\b(?:python|python3|node|ruby|php)\b[^\n]*(?:-c|-e)\b/i },
  { tag: "powershell-content", pattern: /\b(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item)\b/i },
];

export function classifyShellMutationRisk(command: string): string[] {
  const tags: string[] = [];
  for (const { tag, pattern } of SHELL_MUTATION_PATTERNS) {
    if (pattern.test(command)) tags.push(tag);
  }
  return tags;
}
