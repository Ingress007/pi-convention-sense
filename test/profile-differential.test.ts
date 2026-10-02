// Differential tests: the runtime Profile loader and the Project Profiler Skill's standalone helper must
// agree on what a valid Profile is. A Profile the Skill approves but the runtime silently ignores (or the
// other way round) is a bug in one of them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createProfileFingerprint, loadProjectProfile } from "../src/profile/profile-loader.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Profile = { [key: string]: any };

// The helper is a CLI script. Cut its command-line tail and import the validation functions it defines.
async function loadHelper(): Promise<{
  validateProfile(profile: unknown): { diagnostics: string[]; warnings: string[] };
  fingerprint(profile: unknown): string;
}> {
  const source = readFileSync(resolve("skills", "project-profiler", "scripts", "profile-tools.mjs"), "utf8");
  const tail = source.indexOf("const [command, ...args] = process.argv.slice(2);");
  assert.ok(tail > 0, "the helper's command-line section was not found");
  const module = `${source.slice(0, tail).replace(/^#!.*\n/, "")}\nexport { validateProfile, fingerprint };\n`;
  return import(`data:text/javascript;base64,${Buffer.from(module).toString("base64")}`);
}

function repositoryProfile(): Profile {
  return JSON.parse(readFileSync(resolve(".convention-sense", "profile.json"), "utf8")) as Profile;
}

function snailJobProfile(): Profile {
  return JSON.parse(
    readFileSync(resolve("test", "fixtures", "profiles", "snail-job", ".convention-sense", "profile.json"), "utf8"),
  ) as Profile;
}

function runtimeAccepts(profile: unknown): boolean {
  const root = mkdtempSync(join(tmpdir(), "pi-convention-differential-"));
  mkdirSync(join(root, ".convention-sense"));
  writeFileSync(join(root, ".convention-sense", "profile.json"), JSON.stringify(profile));
  return loadProjectProfile(root, true).status === "loaded";
}

interface Case {
  name: string;
  expected: "valid" | "invalid";
  mutate(profile: Profile): void;
}

const knowledgeItem = (profile: Profile) => profile.knowledge[0] as Profile;
const conventionItem = (profile: Profile) => profile.conventions[0] as Profile;
const moduleItem = (profile: Profile) => profile.modules[0] as Profile;
const overrideItem = (profile: Profile) => profile.scopeOverrides[0] as Profile;
const technologyItem = (profile: Profile) => profile.technologies[0] as Profile;

const CASES: Case[] = [
  // ---- still valid
  { name: "unchanged", expected: "valid", mutate: () => {} },
  { name: "reviewed with reviewer", expected: "valid", mutate: (p) => { p.review = { status: "reviewed", reviewedAt: "2026-10-01T00:00:00Z", reviewedBy: "me" }; } },
  { name: "unknown top-level key is ignored", expected: "valid", mutate: (p) => { p.futureField = { a: 1 }; } },
  { name: "empty selector arrays", expected: "valid", mutate: (p) => { moduleItem(p).selector = { paths: [], modules: [] }; } },
  { name: "negative priority", expected: "valid", mutate: (p) => { moduleItem(p).priority = -5; } },
  { name: "unicode titles", expected: "valid", mutate: (p) => { moduleItem(p).title = "订单模块 / Module"; } },
  { name: "evidence without path and line", expected: "valid", mutate: (p) => { technologyItem(p).evidence = [{ kind: "documentation", detail: "README" }]; } },
  { name: "knowledge without selector", expected: "valid", mutate: (p) => { delete knowledgeItem(p).selector; } },
  { name: "technology without version", expected: "valid", mutate: (p) => { delete technologyItem(p).version; } },
  { name: "related project", expected: "valid", mutate: (p) => { p.project.relatedProjects = [{ name: "admin", path: "../admin", relationship: "frontend" }]; } },

  // ---- root and header
  { name: "root is an array", expected: "invalid", mutate: (p) => { for (const key of Object.keys(p)) delete p[key]; Object.assign(p, { 0: 1 }); (p as any).__array = true; } },
  { name: "schemaVersion 2", expected: "invalid", mutate: (p) => { p.schemaVersion = 2; } },
  { name: "profileVersion missing", expected: "invalid", mutate: (p) => { delete p.profileVersion; } },
  { name: "profileVersion blank", expected: "invalid", mutate: (p) => { p.profileVersion = "   "; } },
  { name: "project.name blank", expected: "invalid", mutate: (p) => { p.project.name = " "; } },
  { name: "project.name number", expected: "invalid", mutate: (p) => { p.project.name = 7; } },
  { name: "repositoryRoot ..", expected: "invalid", mutate: (p) => { p.project.repositoryRoot = ".."; } },
  { name: "repositoryRoot ./", expected: "invalid", mutate: (p) => { p.project.repositoryRoot = "./"; } },
  { name: "generatedAt not a date", expected: "invalid", mutate: (p) => { p.generatedAt = "yesterday"; } },
  { name: "generatedAt missing", expected: "invalid", mutate: (p) => { delete p.generatedAt; } },
  { name: "generatedBy unknown", expected: "invalid", mutate: (p) => { p.generatedBy = "robot"; } },
  { name: "review.status unknown", expected: "invalid", mutate: (p) => { p.review = { status: "approved" }; } },
  { name: "review missing", expected: "invalid", mutate: (p) => { delete p.review; } },
  ...["technologies", "packs", "modules", "scopeOverrides", "knowledge", "conventions"].map((key): Case => ({
    name: `${key} is not an array`, expected: "invalid", mutate: (p) => { p[key] = {}; },
  })),
  { name: "relatedProjects bad relationship", expected: "invalid", mutate: (p) => { p.project.relatedProjects = [{ name: "x", path: "y", relationship: "peer" }]; } },
  { name: "relatedProjects missing path", expected: "invalid", mutate: (p) => { p.project.relatedProjects = [{ name: "x", relationship: "backend" }]; } },

  // ---- technologies and evidence
  { name: "technology kind unknown", expected: "invalid", mutate: (p) => { technologyItem(p).kind = "tool"; } },
  { name: "technology kind missing", expected: "invalid", mutate: (p) => { delete technologyItem(p).kind; } },
  { name: "technology confidence unknown", expected: "invalid", mutate: (p) => { technologyItem(p).confidence = "certain"; } },
  { name: "technology version number", expected: "invalid", mutate: (p) => { technologyItem(p).version = 5; } },
  { name: "technology evidence not an array", expected: "invalid", mutate: (p) => { technologyItem(p).evidence = "x"; } },
  { name: "evidence kind unknown", expected: "invalid", mutate: (p) => { technologyItem(p).evidence = [{ kind: "wiki", detail: "d" }]; } },
  { name: "evidence detail empty", expected: "invalid", mutate: (p) => { technologyItem(p).evidence = [{ kind: "config", detail: "" }]; } },
  { name: "evidence detail missing", expected: "invalid", mutate: (p) => { technologyItem(p).evidence = [{ kind: "config" }]; } },
  { name: "evidence path escapes", expected: "invalid", mutate: (p) => { technologyItem(p).evidence = [{ kind: "config", path: "../other/pom.xml", detail: "d" }]; } },
  { name: "evidence path absolute", expected: "invalid", mutate: (p) => { technologyItem(p).evidence = [{ kind: "config", path: "/etc/passwd", detail: "d" }]; } },
  { name: "evidence path windows absolute", expected: "invalid", mutate: (p) => { technologyItem(p).evidence = [{ kind: "config", path: "C:\\x\\y", detail: "d" }]; } },
  { name: "evidence line zero", expected: "invalid", mutate: (p) => { technologyItem(p).evidence = [{ kind: "config", line: 0, detail: "d" }]; } },
  { name: "evidence line fractional", expected: "invalid", mutate: (p) => { technologyItem(p).evidence = [{ kind: "config", line: 1.5, detail: "d" }]; } },

  // ---- packs
  { name: "pack id empty", expected: "invalid", mutate: (p) => { p.packs = [{ id: "", enabled: true, source: "builtin" }]; } },
  { name: "pack enabled string", expected: "invalid", mutate: (p) => { p.packs = [{ id: "java-spring", enabled: "yes", source: "builtin" }]; } },
  { name: "pack source remote", expected: "invalid", mutate: (p) => { p.packs = [{ id: "java-spring", enabled: true, source: "remote" }]; } },
  { name: "pack version number", expected: "invalid", mutate: (p) => { p.packs = [{ id: "java-spring", enabled: true, source: "builtin", version: 1 }]; } },

  // ---- modules, overrides and selectors
  { name: "module title empty", expected: "invalid", mutate: (p) => { moduleItem(p).title = ""; } },
  { name: "module title number", expected: "invalid", mutate: (p) => { moduleItem(p).title = 3; } },
  { name: "module priority string", expected: "invalid", mutate: (p) => { moduleItem(p).priority = "high"; } },
  { name: "selector unknown key", expected: "invalid", mutate: (p) => { moduleItem(p).selector = { paths: ["a/**"], script: ["rm -rf /"] }; } },
  { name: "selector key not an array", expected: "invalid", mutate: (p) => { moduleItem(p).selector = { paths: "a/**" }; } },
  { name: "selector contains an empty string", expected: "invalid", mutate: (p) => { moduleItem(p).selector = { modules: [""] }; } },
  { name: "selector path escapes", expected: "invalid", mutate: (p) => { moduleItem(p).selector = { paths: ["../other/**"] }; } },
  { name: "selector path absolute", expected: "invalid", mutate: (p) => { moduleItem(p).selector = { excludePaths: ["/etc/**"] }; } },
  { name: "selector missing on module", expected: "invalid", mutate: (p) => { delete moduleItem(p).selector; } },
  { name: "module knowledgeRefs not strings", expected: "invalid", mutate: (p) => { moduleItem(p).knowledgeRefs = [1]; } },
  { name: "override confidence unknown", expected: "invalid", mutate: (p) => { overrideItem(p).confidence = "sure"; } },
  { name: "override effectiveRole number", expected: "invalid", mutate: (p) => { overrideItem(p).effectiveRole = 4; } },
  { name: "override evidence bad", expected: "invalid", mutate: (p) => { overrideItem(p).evidence = [{ kind: "x", detail: "d" }]; } },
  { name: "override tags not strings", expected: "invalid", mutate: (p) => { overrideItem(p).tags = [null]; } },

  // ---- knowledge and conventions
  { name: "knowledge strength unknown", expected: "invalid", mutate: (p) => { knowledgeItem(p).strength = "must"; } },
  { name: "knowledge source unknown", expected: "invalid", mutate: (p) => { knowledgeItem(p).source = "ai"; } },
  { name: "knowledge category unknown", expected: "invalid", mutate: (p) => { knowledgeItem(p).category = "misc"; } },
  { name: "knowledge title missing", expected: "invalid", mutate: (p) => { delete knowledgeItem(p).title; } },
  { name: "knowledge title empty", expected: "invalid", mutate: (p) => { knowledgeItem(p).title = ""; } },
  { name: "knowledge summary number", expected: "invalid", mutate: (p) => { knowledgeItem(p).summary = 1; } },
  { name: "knowledge detailPath escapes", expected: "invalid", mutate: (p) => { knowledgeItem(p).detailPath = "../../secret.md"; } },
  { name: "knowledge detailPath absolute", expected: "invalid", mutate: (p) => { knowledgeItem(p).detailPath = "/etc/hosts"; } },
  { name: "knowledge detailPath ok", expected: "valid", mutate: (p) => { knowledgeItem(p).detailPath = "docs/architecture.md"; } },
  { name: "knowledge selector bad", expected: "invalid", mutate: (p) => { knowledgeItem(p).selector = { nope: ["x"] }; } },
  { name: "knowledge evidence bad", expected: "invalid", mutate: (p) => { knowledgeItem(p).evidence = [{ detail: "d" }]; } },
  { name: "convention statement missing", expected: "invalid", mutate: (p) => { delete conventionItem(p).statement; } },
  { name: "convention statement empty", expected: "invalid", mutate: (p) => { conventionItem(p).statement = ""; } },
  { name: "convention category number", expected: "invalid", mutate: (p) => { conventionItem(p).category = 1; } },
  { name: "convention strength unknown", expected: "invalid", mutate: (p) => { conventionItem(p).strength = "soft"; } },

  // ---- identity
  ...(["technologies", "modules", "scopeOverrides", "knowledge", "conventions"] as const).flatMap((key): Case[] => [
    { name: `${key}: duplicate id`, expected: "invalid", mutate: (p) => { p[key].push(structuredClone(p[key][0])); } },
    { name: `${key}: missing id`, expected: "invalid", mutate: (p) => { delete p[key][0].id; } },
    { name: `${key}: empty id`, expected: "invalid", mutate: (p) => { p[key][0].id = ""; } },
  ]),
];

for (const [label, base] of [["this repository's Profile", repositoryProfile], ["the SnailJob fixture Profile", snailJobProfile]] as const) {
  test(`runtime loader and Skill helper agree on a curated corpus (${label})`, async () => {
    const helper = await loadHelper();
    const divergences: string[] = [];
    let compared = 0;
    for (const testCase of CASES) {
      const profile = base();
      if (testCase.name.startsWith("technologies:") && profile.technologies.length === 0) continue;
      // The fixture may lack an item the mutation needs; skip rather than invent data.
      try {
        testCase.mutate(profile);
      } catch {
        continue;
      }
      if (testCase.name === "root is an array") {
        const asArray = [1, 2, 3];
        const helperOk = helper.validateProfile(asArray).diagnostics.length === 0;
        assert.equal(helperOk, false);
        assert.equal(runtimeAccepts(asArray), false);
        continue;
      }
      const helperOk = helper.validateProfile(profile).diagnostics.length === 0;
      const runtimeOk = runtimeAccepts(profile);
      compared += 1;
      const want = testCase.expected === "valid";
      if (helperOk !== want || runtimeOk !== want) {
        divergences.push(`${testCase.name}: expected ${testCase.expected}, helper=${helperOk ? "valid" : "invalid"}, runtime=${runtimeOk ? "valid" : "invalid"}`);
      }
    }
    assert.ok(compared >= 60, `only ${compared} cases ran`);
    assert.deepEqual(divergences, [], `\n${divergences.join("\n")}`);
  });
}

test("both implementations compute the same fingerprint for valid Profiles", async () => {
  const helper = await loadHelper();
  for (const profile of [repositoryProfile(), snailJobProfile()]) {
    assert.equal(helper.fingerprint(profile), createProfileFingerprint(profile as never));
  }
});

// Seeded pseudo-random mutations: whatever one accepts, the other must accept.
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function collectPaths(value: Json, path: Array<string | number> = [], out: Array<Array<string | number>> = []): Array<Array<string | number>> {
  if (Array.isArray(value)) value.forEach((item, index) => { out.push([...path, index]); collectPaths(item, [...path, index], out); });
  else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) { out.push([...path, key]); collectPaths(item, [...path, key], out); }
  return out;
}

const JUNK: Json[] = [null, true, 0, -1, 1.5, "", " ", "x", "../x", "/abs", "C:\\abs", [], {}, [""], ["a"], { id: "z" }, { kind: "x", detail: "d" }];

test("runtime loader and Skill helper agree on 400 seeded random mutations", async () => {
  const helper = await loadHelper();
  const random = mulberry32(20261001);
  const divergences: string[] = [];
  let accepted = 0;
  for (let index = 0; index < 400; index += 1) {
    const profile = (index % 2 === 0 ? repositoryProfile() : snailJobProfile()) as Json;
    const edits = 1 + Math.floor(random() * 3);
    const description: string[] = [];
    for (let edit = 0; edit < edits; edit += 1) {
      const paths = collectPaths(profile);
      const path = paths[Math.floor(random() * paths.length)];
      if (!path) continue;
      let parent: any = profile;
      for (const step of path.slice(0, -1)) parent = parent[step];
      const last = path[path.length - 1] as string | number;
      const operation = random();
      if (operation < 0.55) {
        const junk = JUNK[Math.floor(random() * JUNK.length)] as Json;
        parent[last] = structuredClone(junk);
        description.push(`set ${path.join(".")}=${JSON.stringify(junk)}`);
      } else if (operation < 0.8) {
        if (Array.isArray(parent)) parent.splice(last as number, 1); else delete parent[last];
        description.push(`delete ${path.join(".")}`);
      } else if (Array.isArray(parent)) {
        parent.push(structuredClone(parent[last as number]));
        description.push(`duplicate ${path.join(".")}`);
      }
    }
    const helperOk = helper.validateProfile(profile).diagnostics.length === 0;
    const runtimeOk = runtimeAccepts(profile);
    if (helperOk && runtimeOk) accepted += 1;
    if (helperOk !== runtimeOk) divergences.push(`#${index} helper=${helperOk} runtime=${runtimeOk}: ${description.join("; ")}`);
  }
  assert.deepEqual(divergences.slice(0, 15), [], `${divergences.length} divergences\n${divergences.slice(0, 15).join("\n")}`);
  // A mutation test that only ever produces invalid (or only valid) Profiles compares nothing.
  assert.ok(accepted >= 40 && accepted <= 360, `${accepted} of 400 mutations were valid: the corpus has no discriminating power`);
});
