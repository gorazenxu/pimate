import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { Module } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({ entryPoints: [path.join(root, "PiModelsFile.ts")], bundle: true, write: false, platform: "node", format: "cjs", external: ["fs"] });
const compiled = new Module(path.join(root, "models-test.cjs"));
compiled.filename = path.join(root, "models-test.cjs");
let onSync = null;
const originalRequire = compiled.require.bind(compiled);
compiled.require = name => name === "fs" ? { ...fs, fsyncSync: fd => { fs.fsyncSync(fd); onSync?.(); } } : originalRequire(name);
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { updatePiModelsFile } = compiled.exports;

test("provider updates preserve other providers and root fields", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pimate-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "models.json");
  fs.writeFileSync(file, JSON.stringify({ other: 42, providers: { first: { baseUrl: "new" } } }));
  updatePiModelsFile(file, "second", { baseUrl: "example" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { other: 42, providers: { first: { baseUrl: "new" }, second: { baseUrl: "example" } } });
  updatePiModelsFile(file, "second", null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { other: 42, providers: { first: { baseUrl: "new" } } });
});

test("malformed or linked models files are never overwritten", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pimate-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "models.json");
  fs.writeFileSync(file, "{ broken");
  assert.throws(() => updatePiModelsFile(file, "example", {}));
  assert.equal(fs.readFileSync(file, "utf8"), "{ broken");
  if (process.platform !== "win32") {
    const linked = path.join(dir, "linked.json"); fs.symlinkSync(file, linked);
    assert.throws(() => updatePiModelsFile(linked, "example", {}));
  }
  assert.equal(fs.readFileSync(file, "utf8"), "{ broken");
});

test("external edits during save are detected and preserved", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pimate-models-"));
  t.after(() => { onSync = null; fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, "models.json"); fs.writeFileSync(file, '{"providers":{"a":{}}}');
  onSync = () => fs.writeFileSync(file, '{"providers":{"externallyUpdated":{}}}');
  assert.throws(() => updatePiModelsFile(file, "b", {}), /changed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { providers: { externallyUpdated: {} } });
  assert.deepEqual(fs.readdirSync(dir), ["models.json"]);
});
