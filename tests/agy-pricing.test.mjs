import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  entryPoints: [`${root}AgyPricing.ts`],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const compiled = new Module(`${root}agy-pricing-test.cjs`);
compiled._compile(bundle.outputFiles[0].text, `${root}agy-pricing-test.cjs`);
const { calculateAgyCost, getAgyAccountingTotal } = compiled.exports;

test("AGY accounting total adds cache reads to the raw total", () => {
  // Official headless docs show a per-step payload where total_tokens is
  // input_tokens + output_tokens and cache_read_tokens is separate.
  assert.equal(
    getAgyAccountingTotal({
      input: 278,
      output: 4,
      thinking: 0,
      cacheRead: 30_214,
      total: 282,
    }),
    30_496
  );
});

test("AGY cost prices uncached input and cache reads separately", () => {
  const usage = {
    input: 4_160_000,
    output: 551_300,
    thinking: 274_500,
    cacheRead: 50_950_000,
    total: 4_711_300,
  };
  const cost = calculateAgyCost("gemini-3.8-flash-high", usage);
  assert.ok(cost !== null);
  assert.ok(Math.abs(cost - 9.008625) < 1e-9, `unexpected cost: ${cost}`);
  assert.equal(
    calculateAgyCost("gemini-3.8-flash-high", { ...usage, thinking: 0 }),
    cost
  );
});

test("missing raw AGY total falls back to input plus output before cache", () => {
  assert.equal(
    getAgyAccountingTotal({
      input: 100,
      output: 25,
      thinking: 10,
      cacheRead: 900,
      total: 0,
    }),
    1_025
  );
});

test("AGY pricing strips -xhigh and -max effort suffixes", () => {
  const usage = { input: 1_000_000, output: 1_000_000, thinking: 0, cacheRead: 0, total: 2_000_000 };
  const base = calculateAgyCost("gemini-3.8-flash-high", usage);
  assert.equal(calculateAgyCost("gemini-3.8-flash-xhigh", usage), base);
  assert.equal(calculateAgyCost("gemini-3.8-flash-max", usage), base);
});

test("AGY pricing covers Gemini 4, Orchestrator, and Claude 4.6 models", () => {
  const usage = { input: 1_000_000, output: 1_000_000, thinking: 0, cacheRead: 1_000_000, total: 2_000_000 };
  const nov2026 = Date.UTC(2026, 10, 25);
  const dec2026 = Date.UTC(2026, 11, 2);

  assert.ok(Math.abs(calculateAgyCost("gemini-4-hydrogen-medium", usage, nov2026) - 9.075) < 1e-9);
  assert.ok(Math.abs(calculateAgyCost("gemini-4-hydrogen-high", usage, dec2026) - 9.075) < 1e-9);
  assert.ok(Math.abs(calculateAgyCost("gemini-pro-orchestrator-neon", usage, nov2026) - 18.15) < 1e-9);
  assert.ok(Math.abs(calculateAgyCost("gemini-4-argon-high", usage, nov2026) - 12.1) < 1e-9);
  assert.ok(Math.abs(calculateAgyCost("gemini-4-argon-high", usage, dec2026) - 24.2) < 1e-9);
  assert.ok(Math.abs(calculateAgyCost("claude-sonnet-4-6", usage, nov2026) - 18.3) < 1e-9);
  assert.ok(Math.abs(calculateAgyCost("claude-opus-4-6-thinking", usage, nov2026) - 30.5) < 1e-9);
});

test("Gemini 3.8 Flash pricing follows its 2027 standard-rate cutover", () => {
  const usage = { input: 1_000_000, output: 1_000_000, thinking: 0, cacheRead: 1_000_000, total: 2_000_000 };
  const beforeCutover = Date.UTC(2026, 11, 31, 23, 59, 59);
  const atCutover = Date.UTC(2027, 0, 1);

  assert.equal(calculateAgyCost("gemini-3.8-flash", usage, beforeCutover), 4.575);
  assert.equal(calculateAgyCost("gemini-3.8-flash", usage, atCutover), 9.15);
});

test("Gemini 3.1 Pro estimate uses the official <=200K standard tier", () => {
  const usage = { input: 1_000_000, output: 1_000_000, thinking: 0, cacheRead: 1_000_000, total: 2_000_000 };
  assert.equal(calculateAgyCost("gemini-3.1-pro-preview", usage), 14.2);
});
