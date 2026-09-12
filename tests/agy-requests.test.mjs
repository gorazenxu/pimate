import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "pimate-agy-requests-"));
const previousHome = process.env.HOME;
process.env.HOME = tempHome;

const bundle = await build({
  stdin: {
    contents: 'export * from "./AgyRequestStore";',
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const compiled = new Module(`${root}agy-requests-test.cjs`);
compiled.paths = Module._nodeModulePaths(root);
compiled._compile(bundle.outputFiles[0].text, `${root}agy-requests-test.cjs`);
const { AgyRequestStore, getAgyRequestStorePath } = compiled.exports;

test.after(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await fs.rm(tempHome, { recursive: true, force: true });
});

test("AGY request ledger keeps prompt count separate from usage snapshots", async () => {
  const observedAt = Date.now();
  AgyRequestStore.record({ conversationId: "same-conversation", model: "gemini-test", observedAt });
  AgyRequestStore.record({ conversationId: "same-conversation", model: "gemini-test", observedAt });
  await AgyRequestStore.flush();

  const records = await AgyRequestStore.readAll();
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => !("prompt" in record)));

  const raw = await fs.readFile(getAgyRequestStorePath(), "utf8");
  assert.equal(raw.trim().split(/\r?\n/).length, 2);
  assert.ok(raw.includes('"version":1'));
});
