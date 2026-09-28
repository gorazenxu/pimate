import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  stdin: { contents: 'export * from "./AgyAccountBridge";', resolveDir: root },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const compiled = new Module(`${root}agy-account-bridge-test.cjs`);
compiled.paths = Module._nodeModulePaths(root);
compiled._compile(bundle.outputFiles[0].text, `${root}agy-account-bridge-test.cjs`);
const { installAgyAccountBridge, readAgyAccountBridge, removeAgyAccountBridge } = compiled.exports;

test("AGY account display captures only status-line email and restores settings", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pimate agy account-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.json");
  const original = { model: "test-model", statusLine: { type: "", command: "", enabled: true } };
  await fs.writeFile(settingsPath, JSON.stringify(original));

  if (process.platform !== "win32") {
    const oldPath = process.env.PATH;
    delete process.env.PATH;
    try {
      installAgyAccountBridge(dir);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  } else {
    installAgyAccountBridge(dir);
  }
  assert.equal(readAgyAccountBridge(dir).enabled, true);
  const changed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.equal(changed.model, original.model);
  assert.equal(changed.statusLine.stack_with_default, true);
  assert.match(changed.statusLine.command, /pimate-account-status\.(?:sh|cjs)/);

  removeAgyAccountBridge(dir);
  assert.equal(readAgyAccountBridge(dir).enabled, false);
  if (process.platform !== "win32") {
    const oldPath = process.env.PATH;
    delete process.env.PATH;
    try {
      installAgyAccountBridge(dir);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  } else {
    installAgyAccountBridge(dir);
  }
  assert.equal(readAgyAccountBridge(dir).enabled, true);

  const script = path.join(dir, "cache", process.platform === "win32" ? "pimate-account-status.cjs" : "pimate-account-status.sh");
  const runner = process.platform === "win32" ? "node" : script;
  const runnerArgs = process.platform === "win32" ? [script] : [];
  execFileSync(runner, runnerArgs, {
    ...(process.platform === "win32" ? {} : { env: { ...process.env, PATH: "" } }),
    input: JSON.stringify({ email: "person@example.com", plan_tier: "Pro", cwd: "/private/example" }),
  });
  assert.equal(readAgyAccountBridge(dir).email, "person@example.com");
  const cache = JSON.parse(await fs.readFile(path.join(dir, "cache", "pimate-account-status.json"), "utf8"));
  assert.deepEqual(Object.keys(cache).sort(), ["capturedAt", "email"]);

  await fs.writeFile(settingsPath, JSON.stringify({ ...changed, modelProvider: "gemini" }));
  assert.equal(readAgyAccountBridge(dir).email, undefined);
  await fs.writeFile(settingsPath, JSON.stringify(changed));

  execFileSync(runner, runnerArgs, { input: JSON.stringify({ product: "antigravity" }) });
  assert.equal(readAgyAccountBridge(dir).email, undefined);

  removeAgyAccountBridge(dir);
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, "utf8")), original);
  assert.equal(readAgyAccountBridge(dir).enabled, false);
});

test("AGY account display preserves an existing custom status line", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pimate-agy-account-custom-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const settingsPath = path.join(dir, "settings.json");
  const original = { statusLine: { type: "command", command: "/custom/statusline", enabled: true } };
  await fs.writeFile(settingsPath, JSON.stringify(original));
  assert.equal(readAgyAccountBridge(dir).customStatusLine, true);
  assert.throws(() => installAgyAccountBridge(dir), /custom status-line/);
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, "utf8")), original);
});
