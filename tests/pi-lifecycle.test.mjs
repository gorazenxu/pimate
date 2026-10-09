import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({ entryPoints: [`${root}PiAgentClient.ts`], bundle: true,
  write: false, platform: "node", format: "cjs", external: ["child_process"] });
const children = [];
class Child extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); stdin = new EventEmitter();
  killed = false; exitCode = null; signalCode = null; signals = []; writes = [];
  ignoreTerm = false; ignoreKill = false;
  constructor() { super(); this.stdin.write = (text, callback) => { this.writes.push(text); callback?.(null); }; }
  close(code = 0, signal = null) { this.exitCode = code; this.signalCode = signal; this.emit("close", code); }
  kill(signal) { this.killed = true; this.signals.push(signal);
    if (!(signal === "SIGTERM" ? this.ignoreTerm : this.ignoreKill)) this.close(null, signal);
    return true;
  }
}
const compiled = new Module(`${root}pi-lifecycle-test.cjs`);
compiled.paths = Module._nodeModulePaths(root);
const originalRequire = compiled.require.bind(compiled);
compiled.require = name => name === "child_process" ? { ...childProcess,
  spawn: () => { const child = new Child(); children.push(child); return child; } } : originalRequire(name);
compiled._compile(bundle.outputFiles[0].text, compiled.filename = `${root}pi-lifecycle-test.cjs`);
const { PiAgentClient } = compiled.exports;
globalThis.window = globalThis;
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const makeClient = () => new PiAgentClient({ piPath: "/nonexistent/pimate-test-pi", cwd: root });

test("concurrent starts share one process and exit rejects RPC immediately", async () => {
  const c = makeClient(), before = children.length;
  await Promise.all([c.start(), c.start(), c.start()]);
  assert.equal(children.length, before + 1);
  const rpc = c.getMessages(); const rejected = assert.rejects(rpc, /exited/);
  children.at(-1).close(1); await rejected;
  assert.equal(c.pendingRequests.size, 0); assert.equal(c.isRunning(), false);
  await c.destroy();
});

test("destroy escalates SIGTERM to SIGKILL despite killed=true", async () => {
  const c = makeClient(); await c.start(); const p = children.at(-1); p.ignoreTerm = true;
  await Promise.all([c.destroy(), c.destroy()]);
  assert.deepEqual(p.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(p.signalCode, "SIGKILL");
});

test("normal exit is not force killed and repeated cleanup is idempotent", async () => {
  const c = makeClient(); await c.start(); const p = children.at(-1);
  await c.destroy(); await c.destroy();
  assert.deepEqual(p.signals, ["SIGTERM"]);
});

test("restart ignores old close/data/error and resets partial UTF-8 and JSON", async () => {
  const c = makeClient(), events = [], errors = [];
  c.on("event", e => events.push(e)); c.on("error", e => errors.push(e));
  await c.start(); const old = children.at(-1);
  old.stdout.emit("data", Buffer.from('{"type":"event","secret":'));
  old.stdout.emit("data", Buffer.from([0xe4, 0xb8]));
  await c.restart(); const current = children.at(-1);
  old.emit("close", 1); old.emit("error", new Error("old error"));
  old.stdout.emit("data", Buffer.from('{"type":"event","old":true}\n'));
  current.stdout.emit("data", Buffer.from('{"type":"event","new":true}\n'));
  assert.equal(c.process, current); assert.deepEqual(events, [{ type: "event", new: true }]);
  assert.deepEqual(errors, []); await c.destroy();
});

test("destroy during startup cancels readiness and leaves no process", async () => {
  const c = makeClient(); const started = c.start();
  const rejected = assert.rejects(started, /destroyed/i); await tick();
  const p = children.at(-1); await c.destroy(); await rejected;
  assert.equal(c.process, null); assert.deepEqual(p.signals, ["SIGTERM"]);
});

test("invalid stdout and stderr never print response or credential contents", async () => {
  const c = makeClient(); await c.start(); const p = children.at(-1);
  const logs = [], warn = console.warn; console.warn = (...args) => logs.push(args.join(" "));
  try {
    p.stdout.emit("data", Buffer.from('private-prompt sk-secret\n'));
    p.stderr.emit("data", Buffer.from('private-prompt sk-secret'));
  } finally { console.warn = warn; await c.destroy(); }
  assert.equal(logs.length, 2); assert.doesNotMatch(logs.join(" "), /private-prompt|sk-secret/);
});

test("asynchronous pipe write failures reject pending RPC", async () => {
  const c = makeClient(); await c.start(); const p = children.at(-1);
  p.stdin.write = (_text, callback) => callback(new Error("EPIPE"));
  await assert.rejects(c.getMessages(), /could not be written/);
  assert.equal(c.pendingRequests.size, 0); await c.destroy();
});

test("unresponsive force kill fails within a bound and can be cleaned up again", async () => {
  const c = makeClient(); await c.start(); const p = children.at(-1);
  p.ignoreTerm = true; p.ignoreKill = true;
  await assert.rejects(c.destroy(), /did not exit/);
  assert.equal(c.process, p); p.ignoreKill = false;
  await c.destroy(); assert.equal(c.process, null);
});

test("explicit shutdown cancels queued restart instead of resurrecting a process", async () => {
  const c = makeClient(); await c.start(); const p = children.at(-1);
  p.ignoreTerm = true; const before = children.length;
  const restarting = c.restart(); const rejected = assert.rejects(restarting, /cancelled/);
  await tick(); await c.destroy(); await rejected;
  assert.equal(children.length, before); assert.equal(c.process, null);
});
