// Seeded pseudo-random helpers for fuzz tests. A failing run is reproduced by its seed alone.

export type Rng = () => number;

/** mulberry32: small, fast and good enough for test-data generation. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error("pick from an empty list");
  return items[int(rng, 0, items.length - 1)] as T;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-./\\ :*?{}[]()!@#$%^&+=~`'\"<>|,;\n\t";
const UNICODE = ["é", "中", "文", "한", "😀", "\u0000", "‮", "﻿", " ", "ß", "İ"];

export function randomString(rng: Rng, maxLength = 24): string {
  const length = int(rng, 0, maxLength);
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += chance(rng, 0.1) ? pick(rng, UNICODE) : ALPHABET[int(rng, 0, ALPHABET.length - 1)];
  }
  return text;
}

/** Arbitrary JSON-compatible value, nested up to `depth` levels. */
export function randomJson(rng: Rng, depth = 3): unknown {
  const kind = int(rng, 0, depth > 0 ? 8 : 5);
  switch (kind) {
    case 0:
      return null;
    case 1:
      return chance(rng, 0.5);
    case 2:
      return pick(rng, [0, 1, -1, 2, 10, 100, 1e6, -1e9, 1.5, 1e308, Number.MAX_SAFE_INTEGER]);
    case 3:
      return randomString(rng);
    case 4:
      return pick(rng, ["observe", "guard", "off", "suggest", "auto-once", "info", "silent", "java", "typescript", "vue", ""]);
    case 5:
      return [];
    case 6:
      return Array.from({ length: int(rng, 0, 4) }, () => randomJson(rng, depth - 1));
    default: {
      const entries = Array.from({ length: int(rng, 0, 4) }, () => [randomString(rng, 8), randomJson(rng, depth - 1)] as const);
      return Object.fromEntries(entries);
    }
  }
}

// `FUZZ_SCALE=20 npm test` multiplies every fuzz loop for a deeper one-off run; CI uses the default.
const SCALE = Math.max(1, Number(process.env.FUZZ_SCALE ?? 1) || 1);

/** Run `body` for `iterations` seeds derived from `baseSeed`; on failure the seed is part of the error. */
export function forEachSeed(baseSeed: number, iterations: number, body: (rng: Rng, seed: number) => void): void {
  for (let index = 0; index < iterations * SCALE; index += 1) {
    const seed = baseSeed + index;
    try {
      body(mulberry32(seed), seed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`fuzz seed ${seed} failed: ${message}`, { cause: error });
    }
  }
}

export async function forEachSeedAsync(
  baseSeed: number,
  iterations: number,
  body: (rng: Rng, seed: number) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < iterations * SCALE; index += 1) {
    const seed = baseSeed + index;
    try {
      await body(mulberry32(seed), seed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`fuzz seed ${seed} failed: ${message}`, { cause: error });
    }
  }
}
