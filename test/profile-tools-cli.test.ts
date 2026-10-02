// The Project Profiler Skill's standalone helper, driven the way the Skill drives it: as a command-line tool.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";

const helper = resolve("skills", "project-profiler", "scripts", "profile-tools.mjs");
const fixturePath = resolve("test", "fixtures", "profiles", "snail-job", ".convention-sense", "profile.json");
const root = mkdtempSync(join(tmpdir(), "pi-convention-profile-cli-"));
after(() => rmSync(root, { recursive: true, force: true }));

type Profile = Record<string, any>;

function fixture(): Profile {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Profile;
}

let counter = 0;
function write(profile: unknown, name = `p${(counter += 1)}.json`): string {
  const path = join(root, name);
  writeFileSync(path, typeof profile === "string" ? profile : JSON.stringify(profile, null, 2));
  return path;
}

function run(...args: string[]): { status: number | null; stdout: string; stderr: string; json: any } {
  const result = spawnSync(process.execPath, [helper, ...args], { encoding: "utf8" });
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = undefined;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

test("validate accepts a good Profile and reports its fingerprint", () => {
  const result = run("validate", fixturePath, resolve("."));
  assert.equal(result.status, 0);
  assert.equal(result.json.ok, true);
  assert.deepEqual(result.json.diagnostics, []);
  assert.match(result.json.fingerprint, /^[0-9a-f]{16,}$/);
  assert.equal(run("fingerprint", fixturePath).json.fingerprint, result.json.fingerprint, "both commands agree");
});

test("validate exits 1 with diagnostics for an invalid Profile", () => {
  const broken = fixture();
  broken.knowledge[0].strength = "mandatory";
  delete broken.modules[0].selector;
  const result = run("validate", write(broken), resolve("."));
  assert.equal(result.status, 1);
  assert.equal(result.json.ok, false);
  assert.ok(result.json.diagnostics.some((message: string) => /strength/.test(message)));
  assert.ok(result.json.diagnostics.length >= 2);
});

test("validate rejects a Profile file that lies outside the repository root", () => {
  const nested = join(root, "repo");
  mkdirSync(nested, { recursive: true });
  const outside = write(fixture());
  const result = run("validate", outside, nested);
  assert.equal(result.status, 1);
  assert.ok(result.json.diagnostics.includes("Profile file is outside the active repository root"));
  const inside = join(nested, "profile.json");
  writeFileSync(inside, JSON.stringify(fixture()));
  assert.equal(run("validate", inside, nested).status, 0);
});

test("validate uses the working directory as the default repository root", () => {
  const result = spawnSync(process.execPath, [helper, "validate", fixturePath], { encoding: "utf8", cwd: resolve("test", "fixtures", "profiles", "snail-job") });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).repositoryRoot, resolve("test", "fixtures", "profiles", "snail-job"));
});

test("diff lists added, removed and changed items by id and reports the review transition", () => {
  const current = fixture();
  const candidate = structuredClone(current);
  candidate.profileVersion = "9.9.9";
  candidate.review = { status: "reviewed", reviewedAt: "2026-10-01T00:00:00Z", reviewedBy: "me" };
  const removed = candidate.knowledge.shift();
  candidate.knowledge.push({ id: "brand-new", category: "workflow", title: "New", summary: "New item", strength: "advisory", source: "human" });
  candidate.conventions[0].statement = `${candidate.conventions[0].statement} (reworded)`;

  const result = run("diff", write(current), write(candidate));
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.reviewTransition, `${current.review.status} -> reviewed`);
  const paths = new Map<string, string>(result.json.changes.map((change: { path: string; type: string }) => [change.path, change.type]));
  assert.equal(paths.get("$.profileVersion"), "changed");
  assert.equal(paths.get("$.knowledge[id=brand-new]"), "added");
  assert.equal(paths.get(`$.knowledge[id=${removed.id}]`), "removed");
  assert.ok([...paths.entries()].some(([path, type]) => path.startsWith(`$.conventions[id=${current.conventions[0].id}]`) && type === "changed"));
  const { added, removed: removedCount, changed } = result.json.summary;
  assert.equal(added + removedCount + changed, result.json.changes.length);
  assert.notEqual(result.json.currentFingerprint, result.json.candidateFingerprint);

  const same = run("diff", write(current), write(structuredClone(current)));
  assert.equal(same.json.changes.length, 0);
  assert.equal(same.json.currentFingerprint, same.json.candidateFingerprint);
});

test("diff refuses to compare when either side is invalid", () => {
  const good = write(fixture());
  const broken = fixture();
  broken.schemaVersion = 2;
  const result = run("diff", good, write(broken));
  assert.equal(result.status, 1);
  assert.equal(result.json.ok, false);
  assert.deepEqual(result.json.currentDiagnostics, []);
  assert.ok(result.json.candidateDiagnostics.length > 0);
});

test("usage errors exit 2 and name the problem", () => {
  for (const args of [[], ["bogus"], ["validate"], ["validate", "a", "b", "c"], ["fingerprint"], ["diff", "only-one"]]) {
    const result = run(...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /Usage|expects/i, JSON.stringify(args));
  }
  const missing = run("validate", join(root, "does-not-exist.json"));
  assert.equal(missing.status, 2);
  assert.ok(missing.stderr.length > 0);
  const garbage = run("validate", write("{ not json"));
  assert.equal(garbage.status, 2);
});
