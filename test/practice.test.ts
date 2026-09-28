import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { estimateTokens } from "../src/observe/snapshot-formatter.js";
import type { ConventionSnapshot } from "../src/observe/types.js";
import {
  formatOneShotPracticeReview,
  formatPracticeCapsule,
} from "../src/practice/capsule-formatter.js";
import {
  classifyPracticeMutationInput,
  planPracticeReviewBoundary,
  PracticeReviewRuntime,
} from "../src/practice/review-runtime.js";
import {
  analyzePracticeSnapshot,
  analyzePracticeSource,
  analyzePracticeTarget,
} from "../src/practice/signal-analyzer.js";
import type { PracticeAnalysisResult } from "../src/practice/types.js";
import { loadSpikeConfig } from "../src/runtime/config.js";
import { buildDynamicContextResult } from "../src/runtime/context.js";
import { createSpikeState } from "../src/runtime/state.js";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "pi-convention-practice-"));
}

function snapshot(root: string, targetPath: string): ConventionSnapshot {
  return {
    scope: {
      language: "java",
      module: "orders",
      role: "service-impl",
      root,
      confidence: "high",
    },
    repositoryRoot: root,
    targetPath,
    targetKind: "existing",
    targetMtimeMs: 1,
    targetSize: 1,
    targetHash: "target-hash",
    observations: [],
    evidenceFiles: [],
    candidates: [],
    createdAt: 1,
    status: "weak",
    tokenEstimate: 1,
    analyzerVersion: "test-analyzer",
    configFingerprint: "test-config",
  };
}

test("simple code and comment-like text do not produce Practice Signals", () => {
  const root = tempProject();
  const target = join(root, "SimpleService.java");
  const signals = analyzePracticeSource(
    target,
    root,
    "java",
    `
      class SimpleService {
        // @Transactional notifier.send(); legacyFallback();
        String name() { return "client.send() compatibility workaround"; }
      }
    `,
  );
  assert.deepEqual(signals, []);
});

test("transaction, responsibility, and state signals remain advisory and explainable", () => {
  const root = tempProject();
  const target = join(root, "OrderService.java");
  const signals = analyzePracticeSource(
    target,
    root,
    "java",
    `
      class OrderService {
        @Transactional
        void approve(Order order) {
          validateOrder(order);
          order.setStatus(APPROVED);
          orderMapper.update(order);
          notificationGateway.publish(order);
        }
      }
    `,
  );

  assert.deepEqual(
    signals.map((item) => item.id),
    [
      "practice.transaction-side-effect",
      "practice.responsibility-boundary",
      "practice.state-persistence",
    ],
  );
  assert.equal(signals[0]?.confidence, "high");
  assert.deepEqual(signals[0]?.facts, [
    { name: "transaction-markers", count: 1 },
    { name: "external-call-sites", count: 1 },
  ]);
  assert.match(signals[0]?.reviewQuestion ?? "", /partial failure/i);
  assert.doesNotMatch(signals.map((item) => item.reviewQuestion).join("\n"), /must use|must split/i);
});

test("variation and compatibility signals ask questions without requiring a pattern or comments", () => {
  const root = tempProject();
  const target = join(root, "ProviderRouter.java");
  const signals = analyzePracticeSource(
    target,
    root,
    "java",
    `
      class ProviderRouter {
        Result route(Type type) {
          if (legacyCompatibilityEnabled) retryPolicy.retry();
          switch (type) {
            case A: return runA();
            case B: return runB();
            case C: return runC();
            default: return runDefault();
          }
        }
      }
    `,
  );

  assert.ok(signals.some((item) => item.id === "practice.failure-path"));
  assert.ok(signals.some((item) => item.id === "practice.compatibility-intent"));
  const variation = signals.find((item) => item.id === "practice.variation-axis");
  assert.ok(variation);
  assert.match(variation.reviewQuestion, /prefer simple or data-driven branching/i);
  const compatibility = signals.find((item) => item.id === "practice.compatibility-intent");
  assert.match(compatibility?.reviewQuestion ?? "", /why-comment only when/i);
});

test("successful-read Practice analysis is bounded to existing production targets", () => {
  const root = tempProject();
  const productionDir = join(root, "src", "main", "java", "com", "acme", "provider");
  mkdirSync(productionDir, { recursive: true });
  const target = join(productionDir, "ProviderRouter.java");
  writeFileSync(
    target,
    "class ProviderRouter { Object route(int type) { switch (type) { case 1: return a(); case 2: return b(); case 3: return c(); default: return d(); } } }",
  );

  const analysis = analyzePracticeTarget(target, root, "java");
  assert.equal(analysis.basis, "successful-read");
  assert.equal(analysis.reason, undefined);
  assert.ok(analysis.signals.some((signal) => signal.id === "practice.variation-axis"));

  const testTarget = join(root, "src", "test", "java", "ProviderRouterTest.java");
  mkdirSync(join(root, "src", "test", "java"), { recursive: true });
  writeFileSync(testTarget, "class ProviderRouterTest {}");
  const nonProduction = analyzePracticeTarget(testTarget, root, "java");
  assert.equal(nonProduction.reason, "non-production-target");
  assert.deepEqual(nonProduction.signals, []);
});

test("Practice Capsule is bounded, structured, and omits source bodies", () => {
  const root = tempProject();
  const target = join(root, "OrderService.java");
  const source = `
    class OrderService {
      @Transactional void approve(Order order) {
        validateOrder(order);
        order.setStatus(APPROVED);
        orderMapper.update(order);
        notificationGateway.publish(order);
      }
    }
  `;
  const analysis: PracticeAnalysisResult = {
    targetPath: target,
    basis: "snapshot",
    signals: analyzePracticeSource(target, root, "java", source),
    durationMs: 1,
  };
  const capsule = formatPracticeCapsule([analysis], 260);

  assert.ok(capsule);
  assert.ok(capsule.tokenEstimate <= 260);
  assert.match(capsule.text, /^<engineering-practice status="advisory">/);
  assert.match(capsule.text, /Comments that restate the code/);
  assert.match(capsule.text, /OrderService\.java/);
  assert.doesNotMatch(capsule.text, /notificationGateway\.publish|APPROVED/);
  assert.match(capsule.text, /<\/engineering-practice>$/);

  const review = formatOneShotPracticeReview([analysis], 400);
  assert.ok(review);
  assert.ok(review.tokenEstimate <= 400);
  assert.match(review.text, /^<engineering-practice-review status="one-shot">/);
  assert.match(review.text, /perform one concise final self-review/i);
  assert.match(review.text, /<engineering-practice status="advisory">/);
  assert.doesNotMatch(review.text, /notificationGateway\.publish|APPROVED/);
});

test("Practice Review Runtime allows one relevant continuation per task generation", () => {
  assert.equal(
    classifyPracticeMutationInput("edit", {
      edits: [{ oldText: 'return "before";', newText: 'return "after";' }],
    }),
    "irrelevant",
  );
  assert.equal(
    classifyPracticeMutationInput("edit", {
      edits: [{ oldText: "gateway.publish(order);", newText: "gateway.publishApproved(order);" }],
    }),
    "relevant",
  );
  assert.equal(classifyPracticeMutationInput("edit", {}), "unknown");

  const runtime = new PracticeReviewRuntime();
  runtime.recordMutation("ignored-before-task.java");
  assert.deepEqual(runtime.current().mutations, []);

  assert.equal(runtime.beginTask(), 1);
  runtime.recordMutation("b.java");
  runtime.recordMutation("a.java", "irrelevant");
  runtime.recordMutation("a.java", "relevant");
  assert.deepEqual(runtime.current(), {
    generation: 1,
    mutations: [
      { path: resolve("a.java"), relevance: "relevant" },
      { path: resolve("b.java"), relevance: "unknown" },
    ],
    requested: false,
  });
  assert.deepEqual(
    planPracticeReviewBoundary({
      task: runtime.current(),
      outcome: "completed",
      continuationPending: false,
      successfulReads: new Set([resolve("a.java"), resolve("b.java")]),
      maxTargets: 1,
      isEligible: () => true,
    }),
    { action: "analyze", targets: [resolve("a.java")] },
  );
  assert.equal(runtime.requestOnce(), true);
  assert.equal(runtime.requestOnce(), false);

  assert.equal(runtime.beginTask(), 2);
  runtime.recordMutation("simple.java", "irrelevant");
  assert.deepEqual(
    planPracticeReviewBoundary({
      task: runtime.current(),
      outcome: "completed",
      continuationPending: false,
      successfulReads: new Set([resolve("simple.java")]),
      maxTargets: 4,
      isEligible: () => true,
    }),
    { action: "skip", reason: "no-relevant-mutation" },
  );
  assert.equal(runtime.current().requested, false);
  runtime.reset();
  assert.equal(runtime.current().generation, 0);
});

test("Practice analysis fails open and shares Context budget without displacing Snapshot", () => {
  const root = tempProject();
  mkdirSync(join(root, "src", "main", "java"), { recursive: true });
  const target = join(root, "src", "main", "java", "OrderService.java");
  writeFileSync(
    target,
    `class OrderService { @Transactional void run() { orderMapper.update(order); remoteGateway.publish(order); } }`,
  );
  const currentSnapshot = snapshot(root, target);
  const analysis = analyzePracticeSnapshot(currentSnapshot);
  assert.equal(analysis.reason, undefined);
  assert.ok(analysis.signals.some((item) => item.id === "practice.transaction-side-effect"));

  const config = loadSpikeConfig(root, true).config;
  const built = buildDynamicContextResult(
    config,
    createSpikeState(),
    [currentSnapshot],
    root,
    [analysis],
  );
  assert.equal(built.includedSnapshots.length, 1);
  assert.ok(built.includedPracticeSignalIds.length > 0);
  assert.match(built.content, /<local-convention/);
  assert.match(built.content, /<engineering-practice status="advisory">/);
  assert.ok(estimateTokens(built.content) <= config.maxContextTokens);

  const fallbackAnalysis = analyzePracticeTarget(target, root, "java");
  const fallbackOnly = buildDynamicContextResult(
    config,
    createSpikeState(),
    [],
    root,
    [fallbackAnalysis],
  );
  assert.equal(fallbackOnly.includedSnapshots.length, 0);
  assert.ok(fallbackOnly.includedPracticeSignalIds.length > 0);
  assert.match(fallbackOnly.content, /<local-convention status="unavailable"/);
  assert.match(fallbackOnly.content, /target-only and does not provide Scope or peer evidence/);
  assert.match(fallbackOnly.content, /<engineering-practice status="advisory">/);
  assert.ok(estimateTokens(fallbackOnly.content) <= config.maxContextTokens);

  const prospective = analyzePracticeSnapshot({ ...currentSnapshot, targetKind: "prospective" });
  assert.deepEqual(prospective.signals, []);
  assert.equal(prospective.reason, "prospective-target");

  const testTarget = join(root, "src", "test", "java", "OrderServiceTest.java");
  mkdirSync(join(root, "src", "test", "java"), { recursive: true });
  writeFileSync(testTarget, "class OrderServiceTest { void retryFallback() {} }");
  const nonProduction = analyzePracticeSnapshot(snapshot(root, testTarget));
  assert.deepEqual(nonProduction.signals, []);
  assert.equal(nonProduction.reason, "non-production-target");

  const off = buildDynamicContextResult(
    { ...config, practiceReview: { ...config.practiceReview, mode: "off" } },
    createSpikeState(),
    [currentSnapshot],
    root,
    [analysis],
  );
  assert.equal(off.includedSnapshots.length, 1);
  assert.deepEqual(off.includedPracticeSignalIds, []);
  assert.doesNotMatch(off.content, /engineering-practice/);
});
