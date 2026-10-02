#!/usr/bin/env node
// Synthetic-repository benchmark for the analysis hot paths. Run it after `npm run build`; it is a local tool,
// not part of CI, because wall-clock numbers depend on the machine.
//
//   node scripts/benchmark-analysis.mjs [--files 19000] [--language java|typescript|both] [--runs 3] [--json]
//
// It builds a throw-away repository under the OS temp directory (nothing outside it is read or written) and
// reports, per language: the cold analysis (index build + candidate ranking + Snapshot), a warm repeat, the
// re-analysis after editing the target and after creating a sibling file, the Snapshot freshness check that
// runs before every model request, and heap growth.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObserveAnalyzer } from "../dist/src/observe/analyzer.js";
import { checkSnapshotFreshness } from "../dist/src/observe/snapshot-cache.js";
import { estimateTokens } from "../dist/src/observe/snapshot-formatter.js";
import { createDefaultConfig } from "../dist/src/runtime/config.js";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const files = Number(option("files", "19000"));
const runs = Math.max(1, Number(option("runs", "3")));
const language = option("language", "both");
const asJson = process.argv.includes("--json");
if (!Number.isInteger(files) || files < 50) {
  console.error("--files must be an integer of at least 50");
  process.exit(2);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function timed(action) {
  const started = performance.now();
  const value = action();
  return { ms: performance.now() - started, value };
}

function javaRepository(root) {
  writeFileSync(join(root, "pom.xml"), "<project/>");
  const modules = 200;
  for (let index = 0; index < files; index += 1) {
    const directory = join(root, "src", "main", "java", "com", "acme", `m${index % modules}`, "service");
    if (index < modules) mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `S${index}ServiceImpl.java`),
      `package com.acme.m${index % modules}.service;\nimport org.slf4j.Logger;\n@Service\npublic class S${index}ServiceImpl implements S${index}Service {\n  private final Logger log = null;\n}\n`,
    );
  }
  const directory = join(root, "src", "main", "java", "com", "acme", "m0", "service");
  return { target: join(directory, "S0ServiceImpl.java"), sibling: join(directory, "BrandNewServiceImpl.java"), languages: ["java"] };
}

function typescriptRepository(root) {
  writeFileSync(join(root, "package.json"), '{"name":"bench","dependencies":{"vue":"3.4.0"}}');
  const modules = 200;
  for (let index = 0; index < files; index += 1) {
    const directory = join(root, "src", "views", `m${index % modules}`);
    if (index < modules) mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `index${index}.vue`),
      `<script setup lang="ts">\nimport { ref } from "vue";\nconst value = ref(${index});\n</script>\n<template><div>{{ value }}</div></template>\n`,
    );
  }
  const directory = join(root, "src", "views", "m0");
  return { target: join(directory, "index0.vue"), sibling: join(directory, "brand-new.vue"), languages: ["typescript", "vue"] };
}

function measure(name, build) {
  const root = mkdtempSync(join(tmpdir(), "pi-convention-bench-"));
  try {
    const heapBefore = process.memoryUsage().heapUsed;
    const { target, sibling, languages } = build(root);
    const config = createDefaultConfig();
    config.includeLanguages = languages;
    const samples = { cold: [], warm: [], afterEdit: [], afterCreate: [], freshness: [] };
    let snapshotStatus = "none";
    let indexBuilds = 0;

    for (let run = 0; run < runs; run += 1) {
      const analyzer = new ObserveAnalyzer();
      const cold = timed(() => analyzer.analyzeTarget(target, root, config));
      samples.cold.push(cold.ms);
      snapshotStatus = cold.value.snapshot?.status ?? cold.value.reason ?? "none";
      samples.warm.push(timed(() => analyzer.analyzeTarget(target, root, config)).ms);

      writeFileSync(target, `${target.endsWith(".vue") ? "<template><div/></template>" : "package edited; class Edited {}"}\n// edited ${run}\n`);
      analyzer.noteFileChanged(target);
      samples.afterEdit.push(timed(() => analyzer.analyzeTarget(target, root, config)).ms);

      writeFileSync(sibling, target.endsWith(".vue") ? "<template><div/></template>\n" : "package edited; class Brand {}\n");
      analyzer.noteFileChanged(sibling);
      const afterCreate = timed(() => analyzer.analyzeTarget(target, root, config));
      samples.afterCreate.push(afterCreate.ms);

      const snapshot = afterCreate.value.snapshot;
      if (snapshot) {
        samples.freshness.push(timed(() => {
          for (let repeat = 0; repeat < 100; repeat += 1) checkSnapshotFreshness(snapshot, snapshot.configFingerprint);
        }).ms / 100);
      }
      indexBuilds = analyzer.indexBuildCount;
    }

    const heapMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
    return {
      scenario: name,
      files,
      runs,
      snapshotStatus,
      indexBuildsInLastRun: indexBuilds,
      coldMs: Math.round(median(samples.cold)),
      warmMs: Math.round(median(samples.warm)),
      afterEditMs: Math.round(median(samples.afterEdit)),
      afterNewFileMs: Math.round(median(samples.afterCreate)),
      freshnessCheckMs: Number(median(samples.freshness).toFixed(3)),
      heapGrowthMb: Math.max(0, Math.round(heapMb)), // negative means a GC ran during the run
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const scenarios = [];
if (language === "java" || language === "both") scenarios.push(measure("java", javaRepository));
if (language === "typescript" || language === "both") scenarios.push(measure("typescript+vue", typescriptRepository));

const tokenText = "中文 mixed with latin text. ".repeat(20_000);
const tokenTiming = timed(() => estimateTokens(tokenText));
const summary = {
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  scenarios,
  estimateTokens: { characters: tokenText.length, ms: Number(tokenTiming.ms.toFixed(2)) },
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`node ${summary.node} on ${summary.platform}; median of ${runs} run(s)`);
  for (const item of scenarios) {
    console.log(
      `${item.scenario.padEnd(15)} ${String(item.files).padStart(6)} files | cold ${item.coldMs} ms | warm ${item.warmMs} ms | ` +
        `after edit ${item.afterEditMs} ms | after new file ${item.afterNewFileMs} ms | freshness ${item.freshnessCheckMs} ms | ` +
        `heap +${item.heapGrowthMb} MB | snapshot ${item.snapshotStatus} | index builds ${item.indexBuildsInLastRun}`,
    );
  }
  console.log(`estimateTokens over ${summary.estimateTokens.characters} characters: ${summary.estimateTokens.ms} ms`);
}
