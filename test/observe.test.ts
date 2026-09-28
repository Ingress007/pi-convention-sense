import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ObserveAnalyzer } from "../src/observe/analyzer.js";
import { buildConventionEvidence, createConfigFingerprint } from "../src/observe/evidence-builder.js";
import { analyzeJavaSource, detectJavaRole } from "../src/observe/java-analyzer.js";
import { detectTypeScriptRole } from "../src/observe/typescript-analyzer.js";
import type { ConventionScope, JavaFileFacts, RankedCandidate } from "../src/observe/types.js";
import { resolveAnalysisRepositoryRoot } from "../src/observe/repository-root.js";
import { SnapshotCache } from "../src/observe/snapshot-cache.js";
import { formatConventionSnapshot } from "../src/observe/snapshot-formatter.js";
import { createDefaultConfig } from "../src/runtime/config.js";
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
