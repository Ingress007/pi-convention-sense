import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { minimatch } from "minimatch";
import { ObserveAnalyzer } from "../src/observe/analyzer.js";
import { RepositoryIndexCache } from "../src/observe/repository-index.js";
import { classificationPath } from "../src/observe/repository-path.js";
import { buildConventionEvidence, createConfigFingerprint } from "../src/observe/evidence-builder.js";
import { analyzeJavaFile, analyzeJavaSource, detectJavaRole, maskJavaStrings, stripJavaComments } from "../src/observe/java-analyzer.js";
import { MAX_ANALYZED_FILE_BYTES } from "../src/observe/limits.js";
import { analyzeTypeScriptFile, detectTypeScriptRole } from "../src/observe/typescript-analyzer.js";
import type { ConventionScope, JavaFileFacts, RankedCandidate } from "../src/observe/types.js";
import { resolveAnalysisRepositoryRoot } from "../src/observe/repository-root.js";
import { checkSnapshotFreshness, SnapshotCache } from "../src/observe/snapshot-cache.js";
import { estimateTokens, formatConventionSnapshot } from "../src/observe/snapshot-formatter.js";
import { createDefaultConfig } from "../src/runtime/config.js";
import { compiledMatcher, globMatches } from "../src/runtime/glob.js";
import { isCaseInsensitivePlatform, pathKey } from "../src/runtime/path-key.js";
import { analyzePracticeSource, analyzePracticeTarget } from "../src/practice/signal-analyzer.js";
import { buildDynamicContext } from "../src/runtime/context.js";
import { createSpikeState } from "../src/runtime/state.js";

const fixtures = resolve("test", "fixtures");

function mavenTarget(root = join(fixtures, "java-maven")): string {
  return join(
    root,
    "order",
    "src",
    "main",
    "java",
    "com",
    "acme",
    "order",
    "service",
    "impl",
    "OrderServiceImpl.java",
  );
}

test("an external Git repository never reuses candidates from the Pi working directory", () => {
  const base = mkdtempSync(join(tmpdir(), "convention-cross-repo-"));
  const sessionRoot = join(base, "session-project");
  const externalRoot = join(base, "external-java-project");
  mkdirSync(sessionRoot, { recursive: true });
  mkdirSync(join(externalRoot, ".git"), { recursive: true });
  cpSync(join(fixtures, "java-maven"), externalRoot, { recursive: true });
  cpSync(join(fixtures, "java-gradle"), sessionRoot, { recursive: true });

  const target = mavenTarget(externalRoot);
  const resolvedRoot = resolveAnalysisRepositoryRoot(target, sessionRoot);
  assert.equal(resolvedRoot, externalRoot);
  const result = new ObserveAnalyzer().analyzeTarget(target, resolvedRoot, createDefaultConfig());
  assert.ok(result.snapshot);
  assert.equal(result.snapshot.repositoryRoot, externalRoot);
  assert.equal(result.snapshot.scope.module, "order");
  assert.ok(result.snapshot.candidates.length >= 2);
  assert.ok(result.snapshot.candidates.every((candidate) => candidate.path.startsWith(externalRoot)));
  assert.ok(result.snapshot.candidates.every((candidate) => !candidate.path.startsWith(sessionRoot)));

  const formatted = formatConventionSnapshot(result.snapshot, sessionRoot, 1200);
  assert.match(formatted.text, /order\/src\/main\/java/);
  assert.doesNotMatch(formatted.text, /session-project|java-gradle/);
});

test("request and response package paths override a generic VO suffix", () => {
  assert.equal(
    detectJavaRole("/repo/src/main/java/com/acme/model/request/JobRequestWebVO.java").role,
    "request-dto",
  );
  assert.equal(
    detectJavaRole("/repo/src/main/java/com/acme/model/request/JobQueryVO.java").role,
    "request-dto",
  );
  assert.equal(
    detectJavaRole("/repo/src/main/java/com/acme/model/response/JobResponseWebVO.java").role,
    "response-dto",
  );
  assert.equal(
    detectJavaRole("/repo/src/main/java/com/acme/support/request/ReportHttpRequestHandler.java").role,
    "unknown",
  );
  assert.equal(
    detectJavaRole("/repo/src/main/java/com/acme/admin/vo/memory/AddMemoryRequestVO.java").role,
    "request-dto",
  );
  assert.equal(
    detectJavaRole("/repo/src/main/java/com/acme/admin/vo/memory/MemoryItemResponseVO.java").role,
    "response-dto",
  );
});

test("TypeScript and Vue roles distinguish pages, components, hooks, services, clients, stores, routers, layouts, and workspace packages", () => {
  const root = join(fixtures, "typescript-vue");
  const cases = [
    ["src/views/job/batch/index.vue", "page"],
    ["src/components/JobCard.vue", "component"],
    ["src/views/job/batch/modules/job-batch-search.vue", "component"],
    ["src/layouts/modules/global-header/index.vue", "component"],
    ["src/hooks/common/table.ts", "hook"],
    ["src/service/api/job.ts", "api-service"],
    ["src/service/request/index.ts", "request-client"],
    ["src/store/modules/app/index.ts", "pinia-store"],
    ["src/router/routes/modules/job.ts", "router"],
    ["src/layouts/base/index.vue", "layout"],
    ["packages/axios/src/index.ts", "request-client"],
    ["packages/alova/src/index.ts", "request-client"],
    ["packages/ofetch/src/index.ts", "request-client"],
    ["packages/shared/src/index.ts", "workspace-package"],
  ] as const;
  for (const [relativePath, expectedRole] of cases) {
    assert.equal(detectTypeScriptRole(join(root, ...relativePath.split("/"))).role, expectedRole);
  }
});

test("Vue component ranking prefers the same semantic filename suffix", () => {
  const root = mkdtempSync(join(tmpdir(), "convention-vue-semantic-name-"));
  writeFileSync(join(root, "package.json"), '{"name":"semantic-name-fixture"}\n');
  const component = '<script setup lang="ts">defineOptions({ name: "Fixture" });</script>\n<template><div /></template>\n';
  const paths = [
    "src/views/workflow/batch/modules/workflow-batch-search.vue",
    "src/views/job/batch/modules/job-batch-search.vue",
    "src/views/job/task/modules/job-task-search.vue",
    "src/views/retry/task/modules/retry-task-search.vue",
    "src/views/namespace/modules/namespace-search.vue",
    "src/components/workflow/modules/drawer/callback-drawer.vue",
    "src/components/workflow/modules/drawer/branch-drawer.vue",
    "src/components/workflow/modules/drawer/task-drawer.vue",
    "src/components/workflow/modules/common/detail-card.vue",
  ];
  for (const relativePath of paths) {
    const path = join(root, ...relativePath.split("/"));
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, component);
  }

  const config = createDefaultConfig();
  config.includeLanguages = ["typescript", "vue"];
  const result = new ObserveAnalyzer().analyzeTarget(
    join(root, ...paths[0]!.split("/")),
    root,
    config,
  );

  assert.ok(result.snapshot);
  assert.equal(result.snapshot.status, "valid");
  assert.equal(result.snapshot.candidates.length, 4);
  assert.ok(
    result.snapshot.candidates.every((candidate) =>
      candidate.path.replaceAll("\\", "/").endsWith("-search.vue"),
    ),
  );
  assert.ok(result.snapshot.candidates.every((candidate) => candidate.breakdown.nameSimilarity === 20));
});

test("Vue page analysis never mixes components or layouts into page Evidence", () => {
  const root = join(fixtures, "typescript-vue");
  const config = createDefaultConfig();
  config.includeLanguages = ["typescript", "vue"];
  const target = join(root, "src", "views", "job", "batch", "index.vue");
  const result = new ObserveAnalyzer().analyzeTarget(target, root, config);

  assert.ok(result.snapshot);
  assert.equal(result.snapshot.scope.language, "vue");
  assert.equal(result.snapshot.scope.role, "page");
  assert.equal(result.snapshot.status, "valid");
  assert.equal(result.snapshot.candidates.length, 2);
  assert.ok(result.snapshot.candidates.every((candidate) => candidate.scope.role === "page"));
  assert.ok(result.snapshot.candidates.every((candidate) => candidate.scope.language === "vue"));
  assert.ok(result.snapshot.candidates.every((candidate) => !candidate.path.includes("components")));
  assert.ok(result.snapshot.candidates.every((candidate) => !candidate.path.includes("layouts")));
  assert.ok(
    result.snapshot.observations.some(
      (observation) => observation.category === "component-style" && observation.pattern === "script-setup",
    ),
  );
});

test("TypeScript role Evidence stays role-local and respects workspace package boundaries", () => {
  const root = join(fixtures, "typescript-vue");
  const config = createDefaultConfig();
  config.includeLanguages = ["typescript", "vue"];
  const analyzer = new ObserveAnalyzer();
  const targets = [
    ["src/hooks/common/table.ts", "hook"],
    ["src/service/api/job.ts", "api-service"],
    ["src/service/request/index.ts", "request-client"],
    ["src/store/modules/app/index.ts", "pinia-store"],
    ["src/router/routes/modules/job.ts", "router"],
    ["packages/shared/src/index.ts", "workspace-package"],
  ] as const;

  for (const [relativePath, expectedRole] of targets) {
    const result = analyzer.analyzeTarget(join(root, ...relativePath.split("/")), root, config);
    assert.ok(result.snapshot, relativePath);
    assert.equal(result.snapshot.scope.role, expectedRole, relativePath);
    assert.ok(
      result.snapshot.candidates.every((candidate) => candidate.scope.role === expectedRole),
      relativePath,
    );
  }

  const workspaceClient = analyzer.analyzeTarget(
    join(root, "packages", "axios", "src", "index.ts"),
    root,
    config,
  );
  assert.ok(workspaceClient.snapshot);
  assert.equal(workspaceClient.snapshot.scope.role, "request-client");
  assert.equal(workspaceClient.snapshot.scope.module, "packages:axios");
  assert.ok(
    workspaceClient.snapshot.candidates.every(
      (candidate) =>
        candidate.scope.module === "packages:axios" &&
        candidate.path.replaceAll("\\", "/").includes("packages/axios"),
    ),
  );
  assert.ok(
    workspaceClient.snapshot.candidates.every(
      (candidate) => !candidate.path.replaceAll("\\", "/").includes("src/service/request"),
    ),
  );
});

test("TypeScript generated declarations are excluded and prospective Vue pages discover page peers", () => {
  const root = join(fixtures, "typescript-vue");
  const config = createDefaultConfig();
  config.includeLanguages = ["typescript", "vue"];
  const analyzer = new ObserveAnalyzer();
  const generated = analyzer.analyzeTarget(join(root, "src", "types", "generated.d.ts"), root, config);
  assert.equal(generated.snapshot, undefined);
  assert.equal(generated.reason, "target-excluded");

  const prospective = analyzer.analyzeProspectiveTarget(
    join(root, "src", "views", "workflow", "index.vue"),
    root,
    config,
  );
  assert.ok(prospective.snapshot);
  assert.equal(prospective.snapshot.targetKind, "prospective");
  assert.equal(prospective.snapshot.scope.role, "page");
  assert.ok(prospective.snapshot.candidates.every((candidate) => candidate.scope.role === "page"));
});

test("generated source headers are excluded even under src/main/java", () => {
  const root = mkdtempSync(join(tmpdir(), "convention-generated-source-"));
  const target = join(root, "src", "main", "java", "com", "acme", "request", "GrpcRequest.java");
  mkdirSync(join(root, "src", "main", "java", "com", "acme", "request"), { recursive: true });
  writeFileSync(join(root, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>\n");
  writeFileSync(
    target,
    "// Generated by the protocol buffer compiler. DO NOT EDIT!\npackage com.acme.request; public final class GrpcRequest {}\n",
  );

  const facts = analyzeJavaSource(target, readFileSync(target, "utf8"));
  assert.equal(facts.generated, true);
  assert.equal(new ObserveAnalyzer().analyzeTarget(target, root, createDefaultConfig()).reason, "target-excluded");
});

test("DTO facts expose naming, Lombok, validation, and contract signals", () => {
  const root = mkdtempSync(join(tmpdir(), "convention-dto-signals-"));
  const target = join(root, "src", "main", "java", "com", "acme", "request", "JobQueryVO.java");
  mkdirSync(join(root, "src", "main", "java", "com", "acme", "request"), { recursive: true });
  const source = `package com.acme.request;
import java.io.Serializable;
@Data
@Builder
public class JobQueryVO implements Serializable {
  @NotBlank private String name;
}\n`;
  writeFileSync(target, source);

  const facts = analyzeJavaSource(target, source);
  assert.deepEqual(facts.signals["dto-naming"], ["QueryVO"]);
  assert.deepEqual(facts.signals["dto-lombok"], ["Builder", "Data"]);
  assert.deepEqual(facts.signals["dto-validation"], ["bean-validation"]);
  assert.deepEqual(facts.signals["dto-contract"], ["serializable"]);
});

test("coexisting additive return wrappers are not mislabeled as mixed alternatives", () => {
  const scope: ConventionScope = {
    language: "java",
    module: "web",
    role: "controller",
    root: "/repo/web",
    confidence: "high",
  };
  const candidates: RankedCandidate[] = [1, 2, 3].map((index) => {
    const facts: JavaFileFacts = {
      path: `/repo/web/Controller${index}.java`,
      role: "controller",
      roleConfidence: "high",
      sourceKind: "production",
      annotations: ["RestController"],
      imports: [],
      superTypes: [],
      signals: { "return-wrapper": ["PageResult", "ResponseEntity"] },
      size: 100,
      mtimeMs: index,
      contentHash: `hash-${index}`,
      generated: false,
      deprecated: false,
    };
    return {
      path: facts.path,
      score: 100 - index,
      level: 0,
      breakdown: {
        sameRole: 30,
        sameModule: 25,
        samePackageOrSibling: 15,
        annotationSimilarity: 10,
        interfaceOrSuperclassSimilarity: 0,
        importJaccard: 0,
        recentlyMaintained: 3,
        sizeSimilarity: 2,
        generatedOrDeprecatedPenalty: 0,
        testOnlyPenalty: 0,
      },
      facts,
      scope,
    };
  });
  const evidence = buildConventionEvidence(scope, candidates, 2);
  const wrappers = evidence.observations.filter((item) => item.category === "return-wrapper");
  assert.equal(wrappers.length, 2);
  assert.ok(wrappers.every((item) => item.confidence === "high"));
  assert.ok(wrappers.every((item) => item.status === "dominant"));
});

test("Java service interfaces do not borrow implementation-only peers", () => {
  const root = mkdtempSync(join(tmpdir(), "convention-java-interface-peers-"));
  writeFileSync(join(root, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>\n");
  const packageRoot = join(root, "src", "main", "java", "com", "acme", "service");
  mkdirSync(join(packageRoot, "pipeline"), { recursive: true });
  const sources = new Map([
    ["RerankService.java", "package com.acme.service; public interface RerankService { void rerank(); }\n"],
    ["SearchService.java", "package com.acme.service; public interface SearchService { void search(); }\n"],
    ["ChunkService.java", "package com.acme.service; public interface ChunkService { void chunk(); }\n"],
    [
      "pipeline/DocumentService.java",
      "package com.acme.service.pipeline; @Service @RequiredArgsConstructor public class DocumentService { private final SearchService searchService; }\n",
    ],
  ]);
  for (const [relativePath, source] of sources) {
    writeFileSync(join(packageRoot, ...relativePath.split("/")), source);
  }

  const result = new ObserveAnalyzer().analyzeTarget(
    join(packageRoot, "RerankService.java"),
    root,
    createDefaultConfig(),
  );

  assert.ok(result.snapshot);
  assert.equal(result.snapshot.status, "weak");
  assert.equal(result.snapshot.candidates.length, 2);
  assert.ok(
    result.snapshot.candidates.every(
      (candidate) => (candidate.facts as JavaFileFacts).declarationKind === "interface",
    ),
  );
  assert.ok(result.snapshot.candidates.every((candidate) => !candidate.path.includes("DocumentService")));
  assert.ok(
    result.snapshot.observations.every(
      (observation) => !["dependency-injection", "logging-framework"].includes(observation.category),
    ),
  );
});

test("Maven multi-module analysis produces ranked peers and repeated evidence", () => {
  const root = join(fixtures, "java-maven");
  const config = createDefaultConfig();
  const result = new ObserveAnalyzer().analyzeTarget(mavenTarget(root), root, config);

  assert.ok(result.snapshot, result.error ?? result.reason);
  const snapshot = result.snapshot;
  assert.equal(snapshot.scope.module, "order");
  assert.equal(snapshot.scope.role, "service-impl");
  assert.equal(snapshot.scope.confidence, "high");
  assert.equal(snapshot.status, "valid");
  assert.equal(snapshot.candidates.length, 3);
  assert.ok(snapshot.candidates.every((candidate) => candidate.path !== snapshot.targetPath));
  assert.ok(snapshot.candidates.every((candidate) => !candidate.path.includes(`${join("src", "test")}`)));
  assert.ok(snapshot.candidates.every((candidate) => !candidate.path.includes(`${join("target", "generated")}`)));

  const constructor = snapshot.observations.find(
    (observation) => observation.category === "dependency-injection" && observation.pattern === "constructor",
  );
  assert.ok(constructor);
  assert.equal(constructor.support, 2);
  assert.equal(constructor.samples, 3);
  assert.equal(constructor.confidence, "medium");
  assert.equal(constructor.status, "dominant");
  assert.equal(constructor.counterEvidence.length, 1);

  const logging = snapshot.observations.find(
    (observation) => observation.category === "logging-framework" && observation.pattern === "slf4j",
  );
  assert.ok(logging);
  assert.equal(logging.support, 3);
  assert.equal(logging.samples, 3);
  assert.equal(logging.confidence, "high");
});

test("Gradle module boundary is preferred and low sample count yields weak Snapshot", () => {
  const root = join(fixtures, "java-gradle");
  const target = join(
    root,
    "inventory",
    "src",
    "main",
    "java",
    "com",
    "acme",
    "inventory",
    "controller",
    "InventoryController.java",
  );
  const result = new ObserveAnalyzer().analyzeTarget(target, root, createDefaultConfig());
  assert.ok(result.snapshot);
  assert.equal(result.snapshot.scope.module, "inventory");
  assert.equal(result.snapshot.scope.role, "controller");
  assert.equal(result.snapshot.scope.confidence, "high");
  assert.equal(result.snapshot.candidates.length, 1);
  assert.equal(result.snapshot.status, "weak");
});

test("single-build monolith falls back to the business package before the role package", () => {
  const root = join(fixtures, "java-monolith");
  const target = join(
    root,
    "src",
    "main",
    "java",
    "com",
    "acme",
    "billing",
    "service",
    "impl",
    "BillingServiceImpl.java",
  );
  const result = new ObserveAnalyzer().analyzeTarget(target, root, createDefaultConfig());
  assert.ok(result.snapshot);
  assert.equal(result.snapshot.scope.module, "billing");
  assert.equal(result.snapshot.scope.confidence, "medium");
});

test("comment and string contents do not create structural Java signals", () => {
  const root = mkdtempSync(join(tmpdir(), "convention-java-parser-"));
  const target = join(root, "CommentServiceImpl.java");
  const source = `
    package com.acme.comment.service.impl;
    import org.springframework.stereotype.Service;
    @Service
    public class CommentServiceImpl {
      // @Autowired private GhostMapper ghostMapper;
      private final RealMapper realMapper;
      public CommentServiceImpl(RealMapper realMapper) { this.realMapper = realMapper; }
      public void run() {
        String sample = "throw new FakeException(ErrorCode.BAD)";
      }
    }
  `;
  writeFileSync(target, source);
  const facts = analyzeJavaSource(target, source);
  assert.deepEqual(facts.signals["dependency-injection"], ["constructor"]);
  assert.equal(facts.signals["exception-type"], undefined);
});

test("formatter respects budget and keeps evidence semantics", () => {
  const root = join(fixtures, "java-maven");
  const result = new ObserveAnalyzer().analyzeTarget(mavenTarget(root), root, createDefaultConfig());
  assert.ok(result.snapshot);
  const formatted = formatConventionSnapshot(result.snapshot, root, 220);
  assert.ok(formatted.tokenEstimate <= 220);
  assert.match(formatted.text, /scope="java:order:service-impl"/);
  assert.match(formatted.text, /support|\(\d+\/\d+/);
  assert.match(formatted.text, /not an absolute rule/);
});

test("combined Snapshot context never exceeds the configured budget", () => {
  const root = join(fixtures, "java-maven");
  const result = new ObserveAnalyzer().analyzeTarget(mavenTarget(root), root, createDefaultConfig());
  assert.ok(result.snapshot);
  const config = { ...createDefaultConfig(), maxContextTokens: 300 };
  const content = buildDynamicContext(config, createSpikeState(), [result.snapshot, result.snapshot, result.snapshot], root);
  assert.ok(Math.ceil(content.length / 4) <= 300);
});

test("Snapshot freshness detects evidence changes and path invalidation", () => {
  const root = mkdtempSync(join(tmpdir(), "convention-freshness-"));
  cpSync(join(fixtures, "java-maven"), root, { recursive: true });
  const config = createDefaultConfig();
  const analyzer = new ObserveAnalyzer();
  const result = analyzer.analyzeTarget(mavenTarget(root), root, config);
  assert.ok(result.snapshot);

  const cache = new SnapshotCache();
  cache.set(result.snapshot);
  const fingerprint = createConfigFingerprint(config);
  assert.ok(cache.getFresh(result.snapshot.targetPath, fingerprint));

  const evidencePath = result.snapshot.evidenceFiles[0]?.path;
  assert.ok(evidencePath);
  writeFileSync(evidencePath, `${readFileSync(evidencePath, "utf8")}\n// changed\n`);
  assert.equal(cache.getFresh(result.snapshot.targetPath, fingerprint), undefined);
  assert.equal(cache.get(result.snapshot.targetPath)?.status, "stale");

  const second = analyzer.analyzeTarget(mavenTarget(root), root, config);
  assert.ok(second.snapshot);
  cache.set(second.snapshot);
  assert.equal(cache.invalidatePath(second.snapshot.targetPath), 1);
  assert.equal(cache.get(second.snapshot.targetPath)?.staleReason, "path-mutated");
});

test("excluded paths and unsupported files do not create Snapshots", () => {
  const root = join(fixtures, "java-maven");
  const generated = join(root, "order", "target", "generated-sources", "GeneratedServiceImpl.java");
  const analyzer = new ObserveAnalyzer();
  assert.equal(analyzer.analyzeTarget(generated, root, createDefaultConfig()).reason, "target-excluded");
  assert.equal(analyzer.analyzeTarget(join(root, "pom.xml"), root, createDefaultConfig()).reason, "unsupported-language");
});

// Directory names ABOVE the repository root (for example D:\build\app or ~/test/app) must never
// influence generated/test/role classification; only the repository-relative path may.
const AMBIGUOUS_PARENT_DIRECTORIES = ["build", "target", "generated", "dist", "test", "tests", "views", "apps"];

function repositoryUnder(parent: string, name: string): string {
  const root = join(mkdtempSync(join(tmpdir(), "pi-convention-parent-")), parent, name);
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

test("Java Snapshots do not depend on directory names above the repository root", () => {
  const config = { ...createDefaultConfig(), includeLanguages: ["java"] };
  const baseline = repositoryUnder("work", "proj");
  cpSync(join(fixtures, "java-maven"), baseline, { recursive: true });
  const expected = new ObserveAnalyzer().analyzeTarget(mavenTarget(baseline), baseline, config);
  assert.ok(expected.snapshot, "baseline repository must produce a Snapshot");

  for (const parent of AMBIGUOUS_PARENT_DIRECTORIES) {
    const root = repositoryUnder(parent, "proj");
    cpSync(join(fixtures, "java-maven"), root, { recursive: true });
    const result = new ObserveAnalyzer().analyzeTarget(mavenTarget(root), root, config);
    assert.ok(result.snapshot, `repository under "${parent}/" lost its Snapshot (${result.reason})`);
    assert.equal(result.snapshot.status, expected.snapshot.status, `status changed under "${parent}/"`);
    assert.equal(
      result.snapshot.evidenceFiles.length,
      expected.snapshot.evidenceFiles.length,
      `peer count changed under "${parent}/"`,
    );
  }
});

test("Vue Snapshots and Practice eligibility do not depend on directory names above the repository root", () => {
  const config = { ...createDefaultConfig(), includeLanguages: ["vue"] };
  for (const parent of ["work", ...AMBIGUOUS_PARENT_DIRECTORIES]) {
    const root = repositoryUnder(parent, "web");
    const directory = join(root, "src", "views", "user");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(root, "package.json"), '{"name":"web"}');
    for (const name of ["A", "B", "C"]) {
      writeFileSync(
        join(directory, `${name}.vue`),
        '<script setup lang="ts">\nimport { ref } from "vue";\nconst value = ref(1);\n</script>\n<template><div>{{ value }}</div></template>\n',
      );
    }
    const target = join(directory, "A.vue");
    const result = new ObserveAnalyzer().analyzeTarget(target, root, config);
    assert.ok(result.snapshot, `Vue repository under "${parent}/" lost its Snapshot (${result.reason})`);
    assert.equal(result.snapshot.scope.role, "page");
    assert.equal(result.snapshot.evidenceFiles.length, 2, `peer count changed under "${parent}/"`);
    assert.notEqual(
      analyzePracticeTarget(target, root, "vue").reason,
      "non-production-target",
      `a production file under "${parent}/" was treated as test code`,
    );
  }
});

test("roles and workspace packages come from the repository-relative path only", () => {
  const config = { ...createDefaultConfig(), includeLanguages: ["typescript"] };
  const root = repositoryUnder("views", "proj");
  mkdirSync(join(root, "src", "utils"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"proj"}');
  const util = join(root, "src", "utils", "format.ts");
  writeFileSync(util, "export function format(value: string): string {\n  return value.trim();\n}\n");
  const utilResult = new ObserveAnalyzer().analyzeTarget(util, root, config);
  assert.equal(utilResult.snapshot, undefined, "a utility under <parent>/views/<repo> is not a page");
  assert.equal(utilResult.reason, "scope-unknown");

  const appRoot = repositoryUnder("apps", "web");
  mkdirSync(join(appRoot, "src", "views", "user"), { recursive: true });
  writeFileSync(join(appRoot, "package.json"), '{"name":"web"}');
  for (const name of ["A", "B", "C"]) {
    writeFileSync(join(appRoot, "src", "views", "user", `${name}.ts`), "export const page = 1;\n");
  }
  const page = new ObserveAnalyzer().analyzeTarget(
    join(appRoot, "src", "views", "user", "A.ts"),
    appRoot,
    config,
  );
  assert.ok(page.snapshot);
  assert.equal(
    page.snapshot.scope.packageName,
    undefined,
    "'apps' above the repository root is not a workspace package",
  );
});

test("generated and test paths inside the repository are still excluded from production evidence", () => {
  const config = { ...createDefaultConfig(), includeLanguages: ["typescript"] };
  const root = repositoryUnder("work", "web");
  mkdirSync(join(root, "src", "generated"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"web"}');
  const generated = join(root, "src", "generated", "api.ts");
  const spec = join(root, "tests", "format.ts");
  writeFileSync(generated, "export const api = 1;\n");
  writeFileSync(spec, "export const spec = 1;\n");

  assert.equal(new ObserveAnalyzer().analyzeTarget(generated, root, config).reason, "target-excluded");
  assert.equal(analyzePracticeTarget(spec, root, "typescript").reason, "non-production-target");
});

test("peer ranking and Snapshot invalidation match paths by platform path key", { skip: !isCaseInsensitivePlatform() }, () => {
  const root = repositoryUnder("work", "proj");
  cpSync(join(fixtures, "java-maven"), root, { recursive: true });
  const config = { ...createDefaultConfig(), includeLanguages: ["java"] };
  const target = mavenTarget(root);
  const variant = target.replace("OrderServiceImpl", "orderserviceimpl");
  assert.notEqual(variant, target);

  const result = new ObserveAnalyzer().analyzeTarget(variant, root, config);
  assert.ok(result.snapshot);
  assert.ok(
    result.snapshot.evidenceFiles.every((evidence) => pathKey(evidence.path) !== pathKey(target)),
    "the target must never be listed as its own comparable implementation",
  );

  const cache = new SnapshotCache();
  cache.set(result.snapshot);
  assert.equal(cache.invalidatePath(target), 1, "invalidation must match a differently cased path");
});

function nonGitProject(name: string, files: Record<string, string>): { base: string; root: string; otherCwd: string } {
  const base = mkdtempSync(join(tmpdir(), "pi-convention-nongit-"));
  const root = join(base, name);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, ...relativePath.split("/"));
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  // Pi was started somewhere else, and the project has no .git directory.
  return { base, root, otherCwd: mkdtempSync(join(tmpdir(), "pi-convention-cwd-")) };
}

const VUE_PAGE = '<script setup lang="ts">\nconst value = 1;\n</script>\n<template><div>{{ value }}</div></template>\n';

test("a non-git web project outside the Pi directory resolves to its package root", () => {
  const { root, otherCwd } = nonGitProject("webapp", {
    "package.json": '{"name":"webapp"}',
    "src/views/user/A.vue": VUE_PAGE,
    "src/views/user/B.vue": VUE_PAGE,
    "src/views/user/C.vue": VUE_PAGE,
    "tests/util.ts": "export const util = 1;\n",
  });
  const page = join(root, "src", "views", "user", "A.vue");
  const spec = join(root, "tests", "util.ts");

  assert.equal(resolveAnalysisRepositoryRoot(page, otherCwd), root);
  assert.equal(resolveAnalysisRepositoryRoot(spec, otherCwd), root);

  const config = { ...createDefaultConfig(), includeLanguages: ["vue", "typescript"] };
  const result = new ObserveAnalyzer().analyzeTarget(page, root, config);
  assert.ok(result.snapshot, `expected a Snapshot, got ${result.reason}`);
  assert.equal(result.snapshot.scope.role, "page", "directory-based roles must survive without a .git directory");
  assert.equal(analyzePracticeTarget(spec, root, "typescript").reason, "non-production-target");
});

test("a non-git pnpm workspace resolves to the workspace root so apps/<name> stays the package", () => {
  const { root, otherCwd } = nonGitProject("mono", {
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
    "package.json": '{"name":"mono","private":true}',
    "apps/web/package.json": '{"name":"web"}',
    "apps/web/src/views/user/A.vue": VUE_PAGE,
    "apps/web/src/views/user/B.vue": VUE_PAGE,
    "apps/web/src/views/user/C.vue": VUE_PAGE,
  });
  const page = join(root, "apps", "web", "src", "views", "user", "A.vue");
  assert.equal(resolveAnalysisRepositoryRoot(page, otherCwd), root);

  const config = { ...createDefaultConfig(), includeLanguages: ["vue"] };
  const result = new ObserveAnalyzer().analyzeTarget(page, root, config);
  assert.ok(result.snapshot);
  assert.equal(result.snapshot.scope.module, "apps:web");
  assert.equal(result.snapshot.scope.packageName, "web");
});

test("a package.json workspaces field also marks the workspace root", () => {
  const { root, otherCwd } = nonGitProject("npmws", {
    "package.json": '{"name":"npmws","workspaces":["packages/*"]}',
    "packages/ui/package.json": '{"name":"ui"}',
    "packages/ui/src/Button.vue": VUE_PAGE,
  });
  assert.equal(resolveAnalysisRepositoryRoot(join(root, "packages", "ui", "src", "Button.vue"), otherCwd), root);
});

test("Java targets still resolve by build markers and a git root still wins over any marker", () => {
  const { root, otherCwd } = nonGitProject("javaapp", {
    "pom.xml": "<project/>",
    "package.json": '{"name":"frontend-inside-java"}',
    "src/main/java/com/acme/Foo.java": "package com.acme; class Foo {}\n",
  });
  assert.equal(resolveAnalysisRepositoryRoot(join(root, "src", "main", "java", "com", "acme", "Foo.java"), otherCwd), root);

  mkdirSync(join(root, ".git"), { recursive: true });
  const nested = join(root, "frontend", "src", "Page.vue");
  mkdirSync(join(root, "frontend", "src"), { recursive: true });
  writeFileSync(join(root, "frontend", "package.json"), "{}");
  writeFileSync(nested, VUE_PAGE);
  assert.equal(resolveAnalysisRepositoryRoot(nested, otherCwd), root, ".git is the strongest repository boundary");
});

function rankingOf(result: ReturnType<ObserveAnalyzer["analyzeTarget"]>): Array<[string, number, number]> {
  return (result.snapshot?.candidates ?? []).map((candidate): [string, number, number] => [
    pathKey(candidate.path),
    candidate.level,
    candidate.score,
  ]);
}

test("Java peer ranking is identical for a differently cased spelling of the same target", { skip: !isCaseInsensitivePlatform() }, () => {
  const root = repositoryUnder("work", "proj");
  cpSync(join(fixtures, "java-maven"), root, { recursive: true });
  const config = { ...createDefaultConfig(), includeLanguages: ["java"] };
  const target = mavenTarget(root);
  const variant = target.replace(join("service", "impl"), join("SERVICE", "IMPL"));
  assert.notEqual(variant, target);

  const exact = rankingOf(new ObserveAnalyzer().analyzeTarget(target, root, config));
  const cased = rankingOf(new ObserveAnalyzer().analyzeTarget(variant, root, config));
  assert.ok(exact.length > 0);
  assert.deepEqual(cased, exact, "same file, same peers, same levels and scores");
  assert.ok(exact.every(([, level]) => level === 0), "the fixture peers live in the target's own directory");
});

test("Vue peer ranking is identical for a differently cased spelling of the same target", { skip: !isCaseInsensitivePlatform() }, () => {
  const root = repositoryUnder("work", "web");
  const directory = join(root, "src", "views", "user");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"web"}');
  for (const name of ["A", "B", "C"]) {
    writeFileSync(
      join(directory, `${name}.vue`),
      '<script setup lang="ts">\nconst value = 1;\n</script>\n<template><div>{{ value }}</div></template>\n',
    );
  }
  const config = { ...createDefaultConfig(), includeLanguages: ["vue"] };
  const target = join(directory, "A.vue");
  const variant = target.replace(join("views", "user"), join("VIEWS", "USER"));
  assert.notEqual(variant, target);

  const exact = rankingOf(new ObserveAnalyzer().analyzeTarget(target, root, config));
  const cased = rankingOf(new ObserveAnalyzer().analyzeTarget(variant, root, config));
  assert.ok(exact.length > 0);
  assert.deepEqual(cased, exact);
  assert.ok(exact.every(([, level]) => level === 0));
});

function mavenRootCopy(): string {
  const root = repositoryUnder("work", "proj");
  cpSync(join(fixtures, "java-maven"), root, { recursive: true });
  return root;
}

test("the repository index survives edits but notices created and deleted files", () => {
  const root = mavenRootCopy();
  const config = { ...createDefaultConfig(), includeLanguages: ["java"] };
  const target = mavenTarget(root);
  const directory = join(target, "..");
  const analyzer = new ObserveAnalyzer();
  const considered = () => analyzer.analyzeTarget(target, root, config).consideredCandidateCount;

  const baseline = considered();
  assert.equal(analyzer.indexBuildCount, 1);

  // Editing an existing file never changes the set of files.
  writeFileSync(target, `${readFileSync(target, "utf8")}\n// edited\n`);
  analyzer.noteFileChanged(target);
  assert.equal(considered(), baseline);
  assert.equal(analyzer.indexBuildCount, 1, "an edit must not trigger a repository rescan");

  // Files the index would not list never trigger a rescan either.
  writeFileSync(join(directory, "notes.txt"), "not java");
  analyzer.noteFileChanged(join(directory, "notes.txt"));
  mkdirSync(join(root, "order", "target", "generated"), { recursive: true });
  writeFileSync(join(root, "order", "target", "generated", "GeneratedServiceImpl.java"), "class GeneratedServiceImpl {}\n");
  analyzer.noteFileChanged(join(root, "order", "target", "generated", "GeneratedServiceImpl.java"));
  assert.equal(considered(), baseline);
  assert.equal(analyzer.indexBuildCount, 1, "non-source and excluded files must not trigger a rescan");

  // A new source file changes the index.
  const created = join(directory, "ShippingServiceImpl.java");
  writeFileSync(created, "package com.acme.order.service.impl; public class ShippingServiceImpl implements ShippingService {}\n");
  analyzer.noteFileChanged(created);
  assert.equal(considered(), baseline + 1, "the new peer is discovered");
  assert.equal(analyzer.indexBuildCount, 2);

  // So does deleting one.
  rmSync(created);
  analyzer.noteFileChanged(created);
  assert.equal(considered(), baseline);
  assert.equal(analyzer.indexBuildCount, 3);
});

test("a truncated repository index is not rebuilt on every change", () => {
  const root = mavenRootCopy();
  const cache = new RepositoryIndexCache({ maxFiles: 2 });
  const first = cache.get(root, createDefaultConfig().exclude, [".java"]);
  assert.equal(first.truncated, true);
  assert.equal(cache.buildCount, 1);

  const created = join(root, "order", "src", "main", "java", "com", "acme", "order", "NewThing.java");
  writeFileSync(created, "class NewThing {}\n");
  cache.noteFileChanged(created);
  cache.get(root, createDefaultConfig().exclude, [".java"]);
  assert.equal(cache.buildCount, 1, "a partial index cannot tell whether a file is new, so it keeps the index");
});

test("glob matchers are compiled once and behave exactly like minimatch", () => {
  const patterns = ["**/generated/**", "**/target/**", "src/**/*.java", "!**/keep/**", "**/{a,b}/**"];
  const paths = ["a/generated/X.java", "order/target/classes/Y.class", "src/main/Z.java", "keep/me.java", "x/b/q.txt", "plain.txt"];
  for (const pattern of patterns) {
    assert.equal(compiledMatcher(pattern, { dot: true }), compiledMatcher(pattern, { dot: true }), "the matcher is cached");
    for (const path of paths) {
      assert.equal(globMatches(path, pattern, { dot: true }), minimatch(path, pattern, { dot: true }), `${pattern} vs ${path}`);
    }
  }
  assert.notEqual(compiledMatcher("a/**", { dot: true }), compiledMatcher("a/**", { dot: false }), "options are part of the identity");
});

test("classificationPath keeps its exact behavior for every path spelling", () => {
  const root = resolve("/repo", "proj");
  assert.equal(classificationPath(join(root, "src", "main", "A.java"), root), "/src/main/A.java");
  assert.equal(classificationPath(join(root, "src", "..", "lib", "B.java"), root), "/lib/B.java", "unnormalized input");
  assert.equal(classificationPath(`${root}${sep}`, root), `${root.replaceAll("\\", "/")}/`, "the root itself is not 'inside'");
  assert.equal(classificationPath(join(root, "a", "b.ts"), `${root}${sep}`), "/a/b.ts", "a trailing separator on the root");
  assert.equal(
    classificationPath(join(resolve("/elsewhere"), "x", "C.java"), root),
    join(resolve("/elsewhere"), "x", "C.java").replaceAll("\\", "/"),
    "a path outside the root keeps its absolute spelling",
  );
  assert.equal(classificationPath(join(root, "x.ts")), join(root, "x.ts").replaceAll("\\", "/"), "no root, no change");
  assert.equal(classificationPath(`${root}-other${sep}d.ts`, root), `${root}-other${sep}d.ts`.replaceAll("\\", "/"), "a sibling with a shared prefix");
  if (isCaseInsensitivePlatform()) {
    assert.equal(classificationPath(join(root.toUpperCase(), "Src", "D.java"), root), "/Src/D.java", "root spelled differently");
    assert.equal(classificationPath(join(root, "A.java").replaceAll("\\", "/"), root), "/A.java", "forward slashes");
  }
});

// A Snapshot is checked on every model request, so an unchanged file must not be re-read and hashed.
// Like git's "racy clean" rule, equal mtime+size is trusted only when the file was already old when
// its facts were captured; a file modified in the same timestamp tick could keep both.
function snapshotWithEvidenceMtime(ageMs: number): { root: string; evidencePath: string; check: () => boolean } {
  const root = mavenRootCopy();
  const config = createDefaultConfig();
  const target = mavenTarget(root);
  if (ageMs > 0) {
    const old = new Date(Date.now() - ageMs);
    for (const path of [target, ...new ObserveAnalyzer().analyzeTarget(target, root, config).snapshot?.evidenceFiles.map((item) => item.path) ?? []]) {
      utimesSync(path, old, old);
    }
  }
  const snapshot = new ObserveAnalyzer().analyzeTarget(target, root, config).snapshot;
  assert.ok(snapshot);
  const evidencePath = snapshot.evidenceFiles[0]?.path;
  assert.ok(evidencePath);
  return {
    root,
    evidencePath,
    check: () => checkSnapshotFreshness(snapshot, createConfigFingerprint(config)).fresh,
  };
}

function rewriteSameSizeKeepingMtime(path: string): void {
  const before = statSync(path);
  const content = readFileSync(path, "utf8");
  writeFileSync(path, content.replace(/[A-Za-z]/, (letter) => (letter === "Z" ? "Y" : "Z")));
  assert.equal(statSync(path).size, before.size, "the rewrite keeps the size");
  utimesSync(path, before.atime, before.mtime);
}

test("freshness trusts an unchanged mtime and size for a file that was already old", () => {
  const { evidencePath, check } = snapshotWithEvidenceMtime(60 * 60 * 1000);
  assert.equal(check(), true);
  rewriteSameSizeKeepingMtime(evidencePath); // only possible by forging the mtime
  assert.equal(check(), true, "an old file with the same mtime and size is not re-hashed");
});

test("freshness still hashes a file that was recent when its facts were captured", () => {
  const { evidencePath, check } = snapshotWithEvidenceMtime(0);
  assert.equal(check(), true);
  rewriteSameSizeKeepingMtime(evidencePath);
  assert.equal(check(), false, "a racy-clean file keeps the content check");
});

test("freshness still detects any change of mtime or size", () => {
  const { evidencePath, check } = snapshotWithEvidenceMtime(60 * 60 * 1000);
  writeFileSync(evidencePath, `${readFileSync(evidencePath, "utf8")}\n// grown\n`);
  assert.equal(check(), false);
});

test("estimateTokens counts CJK text at about one token per character and leaves ASCII unchanged", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("a".repeat(400)), 100, "ASCII stays at four characters per token");
  assert.equal(estimateTokens("事务边界必须明确".repeat(10)), 80, "80 Chinese characters are about 80 tokens, not 20");
  assert.equal(estimateTokens("Order 订单服务"), 6, "mixed text: 6 ASCII characters plus 4 CJK characters");
  assert.equal(estimateTokens("，。：；"), 4, "full-width punctuation counts as CJK");
  assert.equal(estimateTokens("かな カナ 한글"), 7, "kana and hangul count too: 6 characters plus 2 spaces");
});

test("a Snapshot is never emitted as a truncated, unclosed tag, however small the budget", () => {
  const root = mavenRootCopy();
  const snapshot = new ObserveAnalyzer().analyzeTarget(mavenTarget(root), root, createDefaultConfig()).snapshot;
  assert.ok(snapshot);
  const hostile = { ...snapshot, scope: { ...snapshot.scope, module: `${"订单服务模块".repeat(40)}"><x>&` } };
  for (const budget of [12, 24, 45, 80, 200]) {
    const formatted = formatConventionSnapshot(hostile, root, budget);
    assert.ok(formatted.text.endsWith("</local-convention>"), `budget ${budget}: ${formatted.text}`);
    assert.equal(formatted.tokenEstimate, estimateTokens(formatted.text), "the estimate is honest, so callers can skip what does not fit");
  }
  assert.ok(formatConventionSnapshot(hostile, root, 200).tokenEstimate <= 200);

  // Several Snapshots share one budget: later ones get what is left and must never be injected half-cut.
  const snapshots = [0, 1, 2, 3].map((index) => ({ ...snapshot, targetPath: join(root, `Target${index}.java`) }));
  const text = buildDynamicContext({ ...createDefaultConfig(), maxContextTokens: 200 }, createSpikeState(), snapshots, root);
  assert.equal((text.match(/<local-convention/g) ?? []).length, (text.match(/<\/local-convention>/g) ?? []).length, text);
});

test("Snapshot text escapes repository-controlled names so they cannot add or close tags", () => {
  const root = mavenRootCopy();
  const snapshot = new ObserveAnalyzer().analyzeTarget(mavenTarget(root), root, createDefaultConfig()).snapshot;
  assert.ok(snapshot);
  const hostile = '"><injected-tag>&';
  const tampered = {
    ...snapshot,
    scope: { ...snapshot.scope, module: `orders${hostile}`, effectiveRole: `role${hostile}` },
    targetPath: join(root, "order", `T${hostile.replaceAll('"', "")}.java`),
    evidenceFiles: snapshot.evidenceFiles.map((evidence, index) =>
      index === 0 ? { ...evidence, path: join(root, "order", `P${hostile.replaceAll('"', "")}.java`) } : evidence,
    ),
  };
  const { text } = formatConventionSnapshot(tampered, root, 2000);

  assert.equal((text.match(/</g) ?? []).length, 2, `only the opening and closing tags may contain '<': ${text}`);
  assert.ok(text.startsWith('<local-convention scope="'));
  assert.ok(text.endsWith("</local-convention>"));
  assert.match(text, /&lt;injected-tag&gt;/);
  assert.match(text, /&amp;/);
  assert.doesNotMatch(text, /<injected-tag>/);
});

const TEXT_BLOCK_SOURCE = [
  "package com.acme.order.mapper;",
  "",
  "public class OrderQueries {",
  '    static final String SQL = """',
  '        SELECT "id", \'name\' FROM orders -- see http://wiki.acme.test/orders',
  '        WHERE note = "@Transactional" /* not a comment */ AND label = \'it"s\'',
  '        """;',
  "    // a real comment",
  "    @Transactional",
  "    public void run() {",
  '        throw new OrderException("real");',
  "    }",
  "}",
  "",
].join("\n");

test("Java text blocks keep their content out of both comment stripping and code analysis", () => {
  const stripped = stripJavaComments(TEXT_BLOCK_SOURCE);
  assert.ok(stripped.includes("http://wiki.acme.test/orders"), "a // inside a text block is not a comment");
  assert.ok(stripped.includes("/* not a comment */"), "a /* */ inside a text block is not a comment");
  assert.ok(!stripped.includes("a real comment"), "the real comment after the block is still stripped");
  assert.ok(stripped.includes("@Transactional\n    public void run()"), "code after the block is intact");

  const masked = maskJavaStrings(stripped);
  assert.ok(!masked.includes("SELECT") && !masked.includes("wiki"), "text block content is blanked");
  assert.equal(masked.length, stripped.length, "masking preserves offsets");
  assert.equal(masked.split("\n").length, stripped.split("\n").length, "and line structure");
  assert.match(masked, /@Transactional\n {4}public void run\(\)/);
});

test("signals come from real code, not from text inside a Java text block", () => {
  const source = [
    "package com.acme.order.mapper;",
    "public class OrderMapperImpl {",
    '    static final String SQL = """',
    '        throw new FakeException("x") -- "@Transactional" it"s http://example.test',
    '        """;',
    "    @Transactional",
    "    public void run() {",
    '        throw new OrderException("real");',
    "    }",
    "}",
    "",
  ].join("\n");
  const dir = mkdtempSync(join(tmpdir(), "pi-convention-textblock-"));
  const file = join(dir, "OrderMapperImpl.java");
  writeFileSync(file, source);
  const facts = analyzeJavaSource(file, source);
  assert.deepEqual(facts.signals["exception-type"], ["OrderException"], "FakeException exists only inside the text block");
  assert.deepEqual(facts.signals["transaction-placement"], ["method"]);
});

test("Practice signals ignore Java text blocks too", () => {
  const source = [
    "public class Reports {",
    '    static final String HELP = """',
    '        it"s then client.send( x ); gateway.publish( y ); catch (Exception e) { retry( z ); }',
    "        status = 1; mapper.update( q ); @Transactional",
    '        """;',
    "}",
    "",
  ].join("\n");
  assert.deepEqual(analyzePracticeSource("Reports.java", "/repo", "java", source), []);
});

test("oversized files fail open instead of being read and analyzed", () => {
  const huge = `class Big {}\n// ${"x".repeat(MAX_ANALYZED_FILE_BYTES)}\n`;
  const root = mavenRootCopy();
  const directory = join(mavenTarget(root), "..");
  const hugePeer = join(directory, "HugeServiceImpl.java");
  writeFileSync(hugePeer, `package com.acme.order.service.impl;\npublic class HugeServiceImpl implements HugeService {}\n// ${"x".repeat(MAX_ANALYZED_FILE_BYTES)}\n`);
  assert.throws(() => analyzeJavaFile(hugePeer, root), /too large/i);

  const tsFile = join(root, "big.ts");
  writeFileSync(tsFile, huge);
  assert.throws(() => analyzeTypeScriptFile(tsFile, root), /too large/i);

  const config = { ...createDefaultConfig(), includeLanguages: ["java"] };
  const result = new ObserveAnalyzer().analyzeTarget(mavenTarget(root), root, config);
  assert.ok(result.snapshot, "a normal target still works");
  assert.ok(
    result.snapshot.candidates.every((candidate) => !candidate.path.endsWith("HugeServiceImpl.java")),
    "an oversized peer is skipped, not analyzed",
  );

  const asTarget = new ObserveAnalyzer().analyzeTarget(hugePeer, root, config);
  assert.equal(asTarget.snapshot, undefined);
  assert.equal(asTarget.reason, "analysis-error", "Guard treats analysis-error as fail-open");
  assert.match(asTarget.error ?? "", /too large/i);
});

test("the repository index is revalidated when it ages out or the checked-out commit changes", () => {
  const root = mavenRootCopy();
  const head = join(root, ".git", "HEAD");
  writeFileSync(head, "ref: refs/heads/main\n");
  let clock = 1_000_000;
  const cache = new RepositoryIndexCache({ maxAgeMs: 60_000, now: () => clock });
  const exclude = createDefaultConfig().exclude;
  const scan = () => cache.get(root, exclude, [".java"]);

  scan();
  scan();
  assert.equal(cache.buildCount, 1);
  clock += 59_000;
  scan();
  assert.equal(cache.buildCount, 1, "a young index is kept");
  clock += 2_000;
  scan();
  assert.equal(cache.buildCount, 2, "an old index is rescanned: files may have changed behind our back");

  const later = new Date(Date.now() + 10_000);
  writeFileSync(head, "ref: refs/heads/feature\n");
  utimesSync(head, later, later);
  scan();
  assert.equal(cache.buildCount, 3, "a branch switch is noticed immediately");
  scan();
  assert.equal(cache.buildCount, 3, "and only once");
});

test("editing a symlinked source file does not rescan the repository", (t) => {
  const root = mavenRootCopy();
  const config = { ...createDefaultConfig(), includeLanguages: ["java"] };
  const target = mavenTarget(root);
  const link = join(target, "..", "LinkedServiceImpl.java");
  try {
    symlinkSync(target, link, "file");
  } catch {
    t.skip("file symlinks cannot be created here");
    return;
  }
  const analyzer = new ObserveAnalyzer();
  analyzer.analyzeTarget(target, root, config);
  for (let edit = 0; edit < 3; edit += 1) {
    analyzer.noteFileChanged(link);
    analyzer.analyzeTarget(target, root, config);
  }
  assert.equal(analyzer.indexBuildCount, 1, "the index never lists symlinks, so editing one changes nothing");
});

test("estimateTokens counts exactly the CJK ranges", () => {
  const ranges = [[0x3000, 0x30ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xac00, 0xd7af], [0xff00, 0xffef]] as const;
  const isCjk = (code: number) => ranges.some(([low, high]) => code >= low && code <= high);
  for (let code = 0; code <= 0xffff; code += 1) {
    const expected = isCjk(code) ? 4 : 1; // four CJK characters are 4 tokens; four others fit in one
    assert.equal(estimateTokens(String.fromCharCode(code).repeat(4)), expected, `U+${code.toString(16)}`);
  }
});
