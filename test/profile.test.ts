import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { ObserveAnalyzer } from "../src/observe/analyzer.js";
import { buildDynamicContextResult } from "../src/runtime/context.js";
import { loadSpikeConfig } from "../src/runtime/config.js";
import { createSpikeState } from "../src/runtime/state.js";
import { formatKnowledgeCapsule } from "../src/profile/capsule-formatter.js";
import { createProfileFingerprint, loadProjectProfile } from "../src/profile/profile-loader.js";
import { matchesProfileSelector } from "../src/profile/profile-selector.js";
import { resolveProjectContext } from "../src/profile/profile-resolver.js";
import type { ConventionPack, ProjectProfile } from "../src/profile/types.js";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "pi-convention-profile-"));
}

function writeProjectFile(root: string, relativePath: string, content: string): string {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function profile(): ProjectProfile {
  return {
    schemaVersion: 1,
    profileVersion: "1.0.0",
    project: { name: "snail-job", repositoryRoot: "." },
    generatedAt: "2026-09-22T00:00:00.000Z",
    generatedBy: "agent",
    review: { status: "draft" },
    technologies: [
      {
        id: "java",
        kind: "language",
        version: "21",
        confidence: "high",
        evidence: [{ kind: "manifest", path: "pom.xml", detail: "java.version=21" }],
      },
    ],
    packs: [{ id: "java-spring", version: "1.0.0", enabled: true, source: "builtin" }],
    modules: [
      {
        id: "server-ui",
        title: "Server UI",
        priority: 10,
        selector: { paths: ["snail-job-server-interface/snail-job-server-ui/**"] },
        architecture: ["spring-mvc-view"],
        knowledgeRefs: ["ui-boundary"],
      },
    ],
    scopeOverrides: [
      {
        id: "ui-view-controller",
        priority: 20,
        selector: {
          paths: ["snail-job-server-interface/snail-job-server-ui/**"],
          baseRoles: ["controller"],
          annotationsAny: ["Controller"],
        },
        effectiveRole: "mvc-view-controller",
        architecture: ["spring-mvc-view"],
        tags: ["server-rendered-view"],
        confidence: "high",
        evidence: [{ kind: "source", path: "server-ui/WebController.java", detail: "Uses @Controller" }],
      },
    ],
    knowledge: [
      {
        id: "ui-boundary",
        category: "architecture",
        title: "UI boundary",
        summary: "UI controllers return server-rendered view names and do not use REST response wrappers.",
        strength: "hard",
        selector: { paths: ["snail-job-server-interface/snail-job-server-ui/**"] },
        source: "agent-draft",
      },
    ],
    conventions: [
      {
        id: "ui-controller-style",
        category: "controller-style",
        statement: "Use Spring MVC view controllers in server-ui.",
        strength: "hard",
        selector: { paths: ["snail-job-server-interface/snail-job-server-ui/**"] },
        source: "agent-draft",
      },
    ],
  };
}

function javaSpringPack(): ConventionPack {
  return {
    schemaVersion: 1,
    id: "java-spring",
    version: "1.0.0",
    kind: "framework",
    title: "Java Spring",
    description: "Spring web baseline",
    languages: ["java"],
    detection: [],
    conventions: [
      {
        id: "spring-controller",
        category: "controller",
        statement: "Keep controller responsibilities narrow.",
        strength: "hard",
        selector: { baseRoles: ["controller"] },
      },
    ],
  };
}

test("Project Profile is trust-gated, validated, and fingerprinted", () => {
  const root = tempProject();
  mkdirSync(join(root, ".convention-sense"));
  writeFileSync(join(root, ".convention-sense", "profile.json"), JSON.stringify(profile(), null, 2));

  const ignored = loadProjectProfile(root, false);
  assert.equal(ignored.status, "ignored");
  assert.match(ignored.diagnostics.join("\n"), /not trusted/);

  const loaded = loadProjectProfile(root, true);
  assert.equal(loaded.status, "loaded");
  assert.equal(loaded.profile?.project.repositoryRoot, ".");
  assert.match(loaded.fingerprint ?? "", /^[a-f0-9]{16}$/);
  assert.equal(loadProjectProfile(root, true).fingerprint, loaded.fingerprint);
});

test("invalid or cross-root profiles fail closed to no profile", () => {
  const root = tempProject();
  mkdirSync(join(root, ".convention-sense"));
  const invalid = profile();
  invalid.project.repositoryRoot = "..";
  writeFileSync(join(root, ".convention-sense", "profile.json"), JSON.stringify(invalid));

  const loaded = loadProjectProfile(root, true);
  assert.equal(loaded.status, "invalid");
  assert.equal(loaded.profile, undefined);
  assert.match(loaded.diagnostics.join("\n"), /repositoryRoot/);
});

test("Profile selectors reject script and unknown fields", () => {
  const root = tempProject();
  mkdirSync(join(root, ".convention-sense"));
  const unsafe = profile();
  const selector = unsafe.scopeOverrides[0]!.selector as unknown as Record<string, unknown>;
  selector.script = "process.exit(0)";
  writeFileSync(join(root, ".convention-sense", "profile.json"), JSON.stringify(unsafe));

  const loaded = loadProjectProfile(root, true);
  assert.equal(loaded.status, "invalid");
  assert.match(loaded.diagnostics.join("\n"), /scopeOverrides/);
});

test("selector matching never accepts a target outside the repository", () => {
  const root = tempProject();
  const descriptor = {
    repositoryRoot: root,
    targetPath: join(root, "src", "WebController.java"),
    language: "java",
    module: "server-ui",
    baseRole: "controller",
    annotations: ["Controller"],
  };
  assert.equal(matchesProfileSelector({ paths: ["src/**"], baseRoles: ["controller"] }, descriptor), true);
  assert.equal(
    matchesProfileSelector(
      { paths: ["**"] },
      { ...descriptor, targetPath: join(root, "..", "other", "WebController.java") },
    ),
    false,
  );
});

test("resolver selects effective role and downgrades unreviewed/global hard rules", () => {
  const root = tempProject();
  mkdirSync(join(root, ".convention-sense"));
  writeFileSync(join(root, ".convention-sense", "profile.json"), JSON.stringify(profile()));
  const loaded = loadProjectProfile(root, true);
  const targetPath = join(
    root,
    "snail-job-server-interface",
    "snail-job-server-ui",
    "src",
    "main",
    "java",
    "WebController.java",
  );
  const resolved = resolveProjectContext(
    loaded,
    {
      repositoryRoot: root,
      targetPath,
      language: "java",
      module: "snail-job-server-interface:snail-job-server-ui",
      baseRole: "controller",
      annotations: ["Controller"],
    },
    [javaSpringPack()],
  );

  assert.ok(resolved);
  assert.equal(resolved.effectiveRole, "mvc-view-controller");
  assert.deepEqual(resolved.matchedModuleIds, ["server-ui"]);
  assert.deepEqual(resolved.architecture, ["spring-mvc-view"]);
  assert.ok(resolved.knowledge.every((item) => item.strength === "advisory"));
  assert.ok(resolved.conventions.every((item) => item.strength === "advisory"));
  assert.ok(resolved.conventions.some((item) => item.sourceKind === "global-pack"));
});

test("Profile effective roles isolate MVC view and REST controller evidence", () => {
  const root = tempProject();
  const value = profile();
  value.packs = [];
  value.modules.push({
    id: "server-web",
    title: "Server Web",
    priority: 10,
    selector: { paths: ["snail-job-server-interface/snail-job-server-web/**"] },
    architecture: ["spring-rest"],
  });
  value.scopeOverrides = [
    value.scopeOverrides[0]!,
    {
      id: "web-view-controller",
      priority: 30,
      selector: {
        paths: ["snail-job-server-interface/snail-job-server-web/**"],
        baseRoles: ["controller"],
        annotationsAny: ["Controller"],
      },
      effectiveRole: "mvc-view-controller",
      architecture: ["spring-mvc-view"],
      confidence: "high",
      evidence: [{ kind: "source", path: "server-web/WebController.java", detail: "Uses @Controller" }],
    },
    {
      id: "rest-controller",
      priority: 20,
      selector: {
        paths: ["snail-job-server-interface/snail-job-server-web/**"],
        baseRoles: ["controller"],
        annotationsAny: ["RestController"],
      },
      effectiveRole: "rest-controller",
      architecture: ["spring-rest"],
      confidence: "high",
      evidence: [{ kind: "source", path: "server-web/SystemInfoController.java", detail: "Uses @RestController" }],
    },
  ];
  writeProjectFile(root, ".convention-sense/profile.json", JSON.stringify(value, null, 2));
  writeProjectFile(root, "pom.xml", "<project><modules><module>snail-job-server-interface</module></modules></project>");
  writeProjectFile(
    root,
    "snail-job-server-interface/snail-job-server-ui/pom.xml",
    "<project><artifactId>snail-job-server-ui</artifactId></project>",
  );
  writeProjectFile(
    root,
    "snail-job-server-interface/snail-job-server-web/pom.xml",
    "<project><artifactId>snail-job-server-web</artifactId></project>",
  );

  const uiTarget = writeProjectFile(
    root,
    "snail-job-server-interface/snail-job-server-ui/src/main/java/com/acme/ui/controller/WebController.java",
    "package com.acme.ui.controller; @Controller public class WebController { public String index() { return \"index\"; } }",
  );
  const webView = writeProjectFile(
    root,
    "snail-job-server-interface/snail-job-server-web/src/main/java/com/acme/web/controller/WebController.java",
    "package com.acme.web.controller; @Controller public class WebController { public String index() { return \"index\"; } }",
  );
  const restTargets = ["SystemInfoController", "JobTaskController", "DashboardController"].map((name) =>
    writeProjectFile(
      root,
      `snail-job-server-interface/snail-job-server-web/src/main/java/com/acme/web/controller/${name}.java`,
      `package com.acme.web.controller; @RestController public class ${name} { public Object page() { return null; } }`,
    ),
  );

  const loadedProfile = loadProjectProfile(root, true);
  assert.equal(loadedProfile.status, "loaded");
  const config = loadSpikeConfig(root, true).config;
  const analyzer = new ObserveAnalyzer();
  const uiResult = analyzer.analyzeTarget(uiTarget, root, config, { loadedProfile });
  assert.ok(uiResult.snapshot);
  assert.equal(uiResult.snapshot.scope.effectiveRole, "mvc-view-controller");
  assert.equal(uiResult.snapshot.status, "weak");
  assert.deepEqual(uiResult.snapshot.candidates.map((candidate) => candidate.path), [webView]);
  assert.ok(uiResult.snapshot.projectContext);

  const restResult = analyzer.analyzeTarget(restTargets[0]!, root, config, { loadedProfile });
  assert.ok(restResult.snapshot);
  assert.equal(restResult.snapshot.scope.effectiveRole, "rest-controller");
  assert.equal(restResult.snapshot.status, "valid");
  assert.ok(restResult.snapshot.candidates.every((candidate) => restTargets.includes(candidate.path)));
  assert.ok(restResult.snapshot.candidates.every((candidate) => candidate.path !== webView));

  const built = buildDynamicContextResult(config, createSpikeState(), [uiResult.snapshot], root);
  assert.match(built.content, /<project-knowledge/);
  assert.match(built.content, /effective role: mvc-view-controller/i);
  assert.match(built.content, /scope="java:snail-job-server-interface:snail-job-server-ui:mvc-view-controller"/);
  assert.ok(built.includedKnowledgeIds.includes("ui-boundary"));
});

test("SnailJob draft Profile fixture resolves MVC and REST controller subtypes", () => {
  const root = tempProject();
  cpSync(
    resolve("test", "fixtures", "profiles", "snail-job", ".convention-sense"),
    join(root, ".convention-sense"),
    { recursive: true },
  );
  const loaded = loadProjectProfile(root, true);
  assert.equal(loaded.status, "loaded", loaded.diagnostics.join("; "));

  const uiContext = resolveProjectContext(loaded, {
    repositoryRoot: root,
    targetPath: join(
      root,
      "snail-job-server-interface",
      "snail-job-server-ui",
      "src",
      "main",
      "java",
      "com",
      "aizuda",
      "snailjob",
      "server",
      "ui",
      "controller",
      "WebController.java",
    ),
    language: "java",
    module: "snail-job-server-interface:snail-job-server-ui",
    baseRole: "controller",
    annotations: ["Controller"],
  });
  assert.ok(uiContext);
  assert.equal(uiContext.effectiveRole, "mvc-view-controller");
  assert.deepEqual(uiContext.matchedModuleIds, ["server-ui"]);
  assert.ok(uiContext.knowledge.some((item) => item.item.id === "server-ui-boundary"));
  assert.ok(uiContext.knowledge.every((item) => item.strength === "advisory"));
  assert.ok(uiContext.conventions.every((item) => item.strength === "advisory"));

  const restContext = resolveProjectContext(loaded, {
    repositoryRoot: root,
    targetPath: join(
      root,
      "snail-job-server-interface",
      "snail-job-server-web",
      "src",
      "main",
      "java",
      "com",
      "aizuda",
      "snailjob",
      "server",
      "web",
      "controller",
      "JobController.java",
    ),
    language: "java",
    module: "snail-job-server-interface:snail-job-server-web",
    baseRole: "controller",
    annotations: ["RestController"],
  });
  assert.ok(restContext);
  assert.equal(restContext.effectiveRole, "rest-controller");
  assert.deepEqual(restContext.matchedModuleIds, ["server-web"]);
});

test("Project Profiler Skill helper validates, fingerprints, and semantically diffs Profiles", () => {
  const skillRoot = resolve("skills", "project-profiler");
  const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: project-profiler\n/m);
  assert.match(skill, /`init`/);
  assert.match(skill, /`adopt`/);
  assert.match(skill, /`refresh`/);
  assert.match(skill, /`diff`/);
  assert.match(skill, /Never modify source code, `AGENTS\.md`/);

  const helper = join(skillRoot, "scripts", "profile-tools.mjs");
  const fixturePath = resolve(
    "test",
    "fixtures",
    "profiles",
    "snail-job",
    ".convention-sense",
    "profile.json",
  );
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as ProjectProfile;
  const validation = JSON.parse(
    execFileSync(process.execPath, [helper, "validate", fixturePath, resolve(".")], { encoding: "utf8" }),
  ) as { ok: boolean; fingerprint: string; diagnostics: string[] };
  assert.equal(validation.ok, true, validation.diagnostics.join("; "));
  assert.equal(validation.fingerprint, createProfileFingerprint(fixture));

  const temp = tempProject();
  const currentPath = join(temp, "profile.json");
  const candidatePath = join(temp, "profile.candidate.json");
  writeFileSync(currentPath, JSON.stringify(fixture, null, 2));
  const candidate = structuredClone(fixture);
  candidate.profileVersion = "0.2.0";
  candidate.generatedAt = "2026-09-22T02:00:00.000Z";
  candidate.knowledge.push({
    id: "refresh-diff-example",
    category: "architecture",
    title: "Diff example",
    summary: "A candidate-only item used to verify semantic id-based diffing.",
    strength: "advisory",
    source: "agent-draft",
  });
  writeFileSync(candidatePath, JSON.stringify(candidate, null, 2));

  const diff = JSON.parse(
    execFileSync(process.execPath, [helper, "diff", currentPath, candidatePath], { encoding: "utf8" }),
  ) as {
    ok: boolean;
    currentFingerprint: string;
    candidateFingerprint: string;
    changes: Array<{ type: string; path: string }>;
  };
  assert.equal(diff.ok, true);
  assert.notEqual(diff.currentFingerprint, diff.candidateFingerprint);
  assert.ok(diff.changes.some((change) => change.path === "$.profileVersion"));
  assert.ok(diff.changes.some((change) => change.path === "$.knowledge[id=refresh-diff-example]"));
});

test("Knowledge Capsule is scoped, escaped, and bounded", () => {
  const root = tempProject();
  mkdirSync(join(root, ".convention-sense"));
  const value = profile();
  value.review = { status: "reviewed", reviewedAt: "2026-09-22T01:00:00.000Z", reviewedBy: "team" };
  for (let index = 0; index < 20; index += 1) {
    value.knowledge.push({
      id: `knowledge-${index}`,
      category: "domain",
      title: `Unsafe <title> ${index}`,
      summary: "A deliberately long project knowledge summary used to exercise deterministic token trimming.",
      strength: "advisory",
      selector: { paths: ["snail-job-server-interface/snail-job-server-ui/**"] },
      source: "human",
    });
  }
  writeFileSync(join(root, ".convention-sense", "profile.json"), JSON.stringify(value));
  const loaded = loadProjectProfile(root, true);
  const resolved = resolveProjectContext(loaded, {
    repositoryRoot: root,
    targetPath: join(root, "snail-job-server-interface", "snail-job-server-ui", "WebController.java"),
    language: "java",
    module: "server-ui",
    baseRole: "controller",
    annotations: ["Controller"],
  });
  assert.ok(resolved);

  const capsule = formatKnowledgeCapsule(resolved, root, 220);
  assert.ok(capsule.tokenEstimate <= 220, `capsule used ${capsule.tokenEstimate} tokens`);
  assert.equal(capsule.truncated, true);
  assert.match(capsule.text, /effective role: mvc-view-controller/i);
  assert.match(capsule.text, /&lt;title&gt;/);
  assert.doesNotMatch(capsule.text, /Unsafe <title>/);
});
