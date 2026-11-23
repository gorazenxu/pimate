import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const binary = process.env.PIMATE_REAL_PI_TEST_PATH;
const bundle = await build({ entryPoints: [path.join(root, "PiAgentClient.ts")], bundle: true, write: false, platform: "node", format: "cjs", external: ["child_process"] });
let sandbox;
const compiled = new Module(path.join(root, "real-pi-test.cjs"));
compiled.filename = path.join(root, "real-pi-test.cjs");
const originalRequire = compiled.require.bind(compiled);
compiled.require = name => name === "child_process" ? { ...childProcess,
  spawn: (executable, args, options) => childProcess.spawn(executable, [...args, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp", "--offline"], {
    ...options, cwd: path.join(sandbox, "work"), env: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: path.join(sandbox, "agent"), PI_TELEMETRY: "0", PI_OFFLINE: "1" },
  }) } : originalRequire(name);
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { PiAgentClient } = compiled.exports;
globalThis.window = globalThis;

test("real Pi: missing provider fails safely and synthetic session can be restored", { skip: !binary, timeout: 30000 }, async t => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pimate-real-pi-"));
  fs.mkdirSync(path.join(sandbox, "work"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const invalid = new PiAgentClient({ piPath: binary, cwd: sandbox, provider: "pimate-missing-provider", modelId: "missing-model" });
  try {
    await assert.rejects(invalid.start(), /configured provider or model/);
  } finally { await invalid.destroy(); }

  const session = path.join(sandbox, "work", "synthetic.jsonl");
  const original = [
    { type: "session", version: 3, id: "c6f6985d-ce8c-43fb-b5f0-1ba8bfb7c03b", timestamp: "2026-01-01T00:00:00.000Z", cwd: path.join(sandbox, "work") },
    { type: "message", id: "12345678", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "isolated synthetic history" }], timestamp: 1767225601000 } },
  ].map(line => JSON.stringify(line)).join("\n") + "\n";
  fs.writeFileSync(session, original);
  const client = new PiAgentClient({ piPath: binary, cwd: sandbox });
  try {
    await client.start();
    assert.ok(fs.existsSync(session), "session must survive Pi startup");
    const result = await client.switchSession(session);
    assert.equal(result.success, true);
    const history = await client.getMessages();
    assert.equal(history.success, true);
    const entries = await client.getEntries();
    assert.ok(JSON.stringify(history.data).includes("isolated synthetic history"), JSON.stringify({ switchResult: result, history: history.data, entries: entries.data, synthetic: fs.readFileSync(session, "utf8") }));
    assert.ok(fs.readFileSync(session, "utf8").includes("isolated synthetic history"));
  } finally { await client.destroy(); }
});
