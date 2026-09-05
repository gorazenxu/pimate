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
  assert.ok(Math.abs(cost - 7.47855) < 1e-9, `unexpected cost: ${cost}`);
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
