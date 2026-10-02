import { isAbsolute, relative, resolve, sep } from "node:path";
import { stripExtendedPathPrefix } from "./path-key.js";

export function normalizeToolPath(cwd: string, rawPath: string): string {
  const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  return resolve(cwd, process.platform === "win32" ? stripExtendedPathPrefix(withoutAt) : withoutAt);
}

/**
 * True when `candidate` is inside `root`. The root itself only counts with `allowEqual`.
 * `relative()` follows the platform's case rules, so this is correct on Windows too.
 */
export function isPathInside(root: string, candidate: string, options: { allowEqual?: boolean } = {}): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "") return options.allowEqual === true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
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

// Every shell command that matches is audited with a Git baseline before and after it runs, so these
// patterns aim at commands that can write a source file, not at everything that mentions a redirect.
//
// A redirect only counts when it writes somewhere: `2>/dev/null`, `> nul`, `> $null` and `>&2` do not.
// Quoted text is blanked first so `grep 'a>b'` is not a redirect.
const REDIRECT_TO_FILE = /(^|[^>])>{1,2}\s*(?!&|\/dev\/null(?![\w.])|nul(?![\w.])|\$null(?![\w.]))\S/im;
// `npm install`, `mvn clean install` and friends install dependencies; only the bare `install`
// command (coreutils) copies files.
const PACKAGE_TOOL = /^\s*(?:sudo\s+)?(?:npm|npx|yarn|pnpm|pip3?|mvnw?|\.\/mvnw|gradlew?|\.\/gradlew|cargo|composer|bundle|apt(?:-get)?|brew)\b/i;

function blankQuoted(command: string): string {
  return command.replace(/'[^']*'|"[^"]*"/g, '""');
}

// Agents mostly write `cd frontend && npm install`, so the package tool is looked for at the start of
// each command segment, not only at the start of the whole line.
function withoutPackageInstalls(command: string): string {
  return command
    .split(/(&&|\|\||;|\||\n)/)
    .map((segment) => (PACKAGE_TOOL.test(segment) ? segment.replace(/\binstall\b/gi, "") : segment))
    .join("");
}

const SHELL_MUTATION_PATTERNS: Array<{ tag: string; pattern: RegExp; prepare?: (command: string) => string }> = [
  { tag: "redirect", pattern: REDIRECT_TO_FILE, prepare: blankQuoted },
  // The flag searches are bounded: an unbounded `[^\n]*` rescans the rest of the line from every `sed` or `python`.
  { tag: "in-place-edit", pattern: /\b(?:sed|perl)\b[^\n]{0,2000}(?:-i|--in-place)\b/i },
  {
    tag: "file-command",
    pattern: /\b(?:rm|mv|cp|touch|truncate|install)\b/i,
    prepare: withoutPackageInstalls,
  },
  { tag: "tee", pattern: /\btee\b/i },
  { tag: "script", pattern: /\b(?:python|python3|node|ruby|php)\b[^\n]{0,2000}(?:-c|-e)\b/i },
  { tag: "powershell-content", pattern: /\b(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item)\b/i },
];

export function classifyShellMutationRisk(command: string): string[] {
  const tags: string[] = [];
  for (const { tag, pattern, prepare } of SHELL_MUTATION_PATTERNS) {
    if (pattern.test(prepare ? prepare(command) : command)) tags.push(tag);
  }
  return tags;
}
