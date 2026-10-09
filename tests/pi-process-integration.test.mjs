import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Real OS pipes/signals, but a local fixture instead of Pi: no model calls,
// Vault writes, installed CLI, or user credential access.
const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({ entryPoints: [`${root}PiAgentClient.ts`], bundle: true,
  write: false, platform: "node", format: "cjs", external: ["child_process"] });
const children = [];
const fixture = `
process.on('SIGTERM', () => {});
const rl = require('node:readline').createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({type:'fixture_ready'}) + '\\n');
rl.on('line', line => {
  const req = JSON.parse(line);
  if (req.type === 'get_messages') {
    if (process.env.FIXTURE_MODE === 'crash') return process.exit(23);
    process.stdout.write(JSON.stringify({type:'response', id:req.id,
      command:req.type, success:true, data:{messages:[{role:'assistant',content:'fixture'}]}}) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;
let mode = "reply";
const compiled = new Module(`${root}pi-process-integration.cjs`);
compiled.paths = Module._nodeModulePaths(root);
const originalRequire = compiled.require.bind(compiled);
compiled.require = name => name === "child_process" ? {
  spawn: () => {
    const child = spawn(process.execPath, ["-e", fixture], {
      cwd: root, env: { FIXTURE_MODE: mode }, stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    return child;
  },
} : originalRequire(name);
compiled._compile(bundle.outputFiles[0].text, compiled.filename = `${root}pi-process-integration.cjs`);
const { PiAgentClient } = compiled.exports;
globalThis.window = globalThis;
const options = { skip: process.platform === "win32", timeout: 10_000 };

async function startFixture(t, selectedMode = "reply") {
  mode = selectedMode;
  const client = new PiAgentClient({ piPath: "/nonexistent/pimate-fixture", cwd: root });
  // Cleanup only children created by this fixture, even after assertion failure.
  const first = children.length;
  t.after(async () => {
    try { await client.destroy(); } finally {
      for (const child of children.slice(first)) {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
        }
      }
    }
  });
  const ready = once(client, "event");
  await client.start();
  assert.equal((await ready)[0].type, "fixture_ready");
  return client;
}

test("real POSIX child: RPC pipes work and ignored SIGTERM escalates to SIGKILL", options, async t => {
  const c = await startFixture(t), child = children.at(-1);
  const result = await c.getMessages();
  assert.deepEqual(result.data.messages, [{ role: "assistant", content: "fixture" }]);
  await c.destroy();
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(c.process, null);
});

test("real POSIX child: abnormal exit rejects RPC and removes pending timers", options, async t => {
  const c = await startFixture(t, "crash"), child = children.at(-1);
  await assert.rejects(c.getMessages(), /exited/);
  assert.equal(child.exitCode, 23);
  assert.equal(c.pendingRequests.size, 0);
  assert.equal(c.isRunning(), false);
});

test("real POSIX child: restart closes old process and new pipes remain usable", options, async t => {
  const c = await startFixture(t), old = children.at(-1);
  const ready = once(c, "event");
  await c.restart();
  assert.equal((await ready)[0].type, "fixture_ready");
  const current = children.at(-1);
  assert.notEqual(current.pid, old.pid);
  assert.equal(old.signalCode, "SIGKILL");
  // Delayed callbacks from a retired pipe must not replace current state.
  old.stdout.emit("data", Buffer.from('{"type":"retired_event"}\n'));
  old.emit("close", 1);
  assert.equal(c.process, current);
  assert.equal((await c.getMessages()).data.messages[0].content, "fixture");
});
