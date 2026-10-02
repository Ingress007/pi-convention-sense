#!/usr/bin/env node
// Release check: does the PUBLISHABLE package work when installed into a clean project?
//
//   node scripts/smoke-package-install.mjs --provider <provider> --model <model>
//
// It packs the repository exactly as `npm publish` would, unpacks the tarball, installs only its production
// dependencies, installs the result into a throw-away Git project with the real `pi` CLI, runs one tiny prompt with
// all tools disabled and checks the extension's own log: the lifecycle events fired and no `handler_error` appeared.
// Everything happens under the OS temp directory. It needs the `pi` CLI, a configured model (one short prompt is
// sent) and network access for npm; it is a local release step, not part of CI, and it never publishes anything.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const provider = option("provider");
const model = option("model");
if (!provider || !model) {
  console.error("Usage: node scripts/smoke-package-install.mjs --provider <provider> --model <model>");
  process.exit(2);
}

const shell = process.platform === "win32";
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell, stdio: ["ignore", "pipe", "pipe"], ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

const work = mkdtempSync(join(tmpdir(), "pi-convention-package-smoke-"));
const failures = [];
try {
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work]));
  console.log(`packed ${packed[0].filename}: ${packed[0].files.length} files, ${packed[0].size} bytes`);

  const unpacked = join(work, "package");
  mkdirSync(unpacked);
  // Relative arguments from inside the work directory: GNU tar reads `C:\...` as a remote host name.
  run("tar", ["-xzf", packed[0].filename, "-C", "package", "--strip-components=1"], { cwd: work });
  for (const required of ["LICENSE", "README.md", "extensions/index.ts", "skills/project-profiler/SKILL.md"]) {
    if (!existsSync(join(unpacked, required))) failures.push(`the package lacks ${required}`);
  }
  // Pi is a peer dependency supplied by the host, so it is not installed here.
  run("npm", ["install", "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: unpacked });
  if (!existsSync(join(unpacked, "node_modules", "minimatch"))) failures.push("the runtime dependency minimatch was not installed");

  const project = join(work, "project");
  mkdirSync(project);
  run("git", ["init", "-q", "."], { cwd: project });
  run("pi", ["install", unpacked, "-l"], { cwd: project });
  run(
    "pi",
    [
      "-p", "--offline", "--approve", "--no-context-files", "--no-session", "--no-tools",
      "--provider", provider, "--model", model, "--thinking", "off", "Reply with the single word OK",
    ],
    { cwd: project, timeout: 180_000 },
  );

  const logPath = join(project, ".pi", "convention-sense", "observe.ndjson");
  if (!existsSync(logPath)) {
    failures.push("the installed extension never wrote its log: it did not load");
  } else {
    const events = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).event);
    for (const expected of ["session_start", "before_agent_start", "context", "agent_settled", "session_shutdown"]) {
      if (!events.includes(expected)) failures.push(`the lifecycle event ${expected} was not logged`);
    }
    if (events.includes("handler_error")) failures.push("the extension logged a handler_error");
    // Other extensions installed globally may add agent runs of their own, so only presence is asserted.
    const counts = {};
    for (const event of events) counts[event] = (counts[event] ?? 0) + 1;
    console.log(`logged events: ${JSON.stringify(counts)}`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`package smoke FAILED:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("package smoke passed: the packed package installs and runs in a clean project");
