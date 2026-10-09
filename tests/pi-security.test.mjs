import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({ stdin: { contents: 'export * from "./PiAuthFile"; export * from "./SkillsCommand";', resolveDir: root },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["fs", "child_process"] });
let failRename = false, onSync = null;
const invocations = [];
const compiled = new Module(`${root}pi-security-test.cjs`);
compiled.paths = Module._nodeModulePaths(root);
const originalRequire = compiled.require.bind(compiled);
compiled.require = name => name === "fs" ? { ...fs,
  renameSync: (...args) => { if (failRename) throw new Error("synthetic rename failure"); return fs.renameSync(...args); },
  fsyncSync: fd => { fs.fsyncSync(fd); onSync?.(); } }
  : name === "child_process" ? { execFile: (cmd, args, options, callback) => {
    invocations.push({ cmd, args, options }); callback(null, "ok", "");
  } } : originalRequire(name);
compiled._compile(bundle.outputFiles[0].text, compiled.filename = `${root}pi-security-test.cjs`);
const { updatePiAuthFile, skillsArgs, resolveSkillsRunner, runSkillsCommand } = compiled.exports;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "pimate-auth-test-"));
  t.after(() => { failRename = false; onSync = null; fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, file: path.join(dir, "auth.json") };
}

test("credential updates retain unrelated and refreshed fields with private permissions", t => {
  const { file, dir } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ other: { token: "test-original" } }), { mode: 0o644 });
  updatePiAuthFile(file, data => { data.one = { key: "test-one" }; });
  // Another producer adds data between user operations, not a stale UI snapshot.
  const external = JSON.parse(fs.readFileSync(file)); external.other.token = "test-refreshed";
  fs.writeFileSync(file, JSON.stringify(external));
  updatePiAuthFile(file, data => { data.two = { key: "test-two" }; delete data.one; });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), {
    other: { token: "test-refreshed" }, two: { key: "test-two" },
  });
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ["auth.json"]);
});

test("failed atomic replacement keeps old credentials and removes temporary file", t => {
  const { file, dir } = fixture(t); const original = '{"other":{"key":"test-secret"}}';
  fs.writeFileSync(file, original); failRename = true;
  assert.throws(() => updatePiAuthFile(file, data => { data.new = {}; }), /Could not save/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(fs.readdirSync(dir), ["auth.json"]);
});

test("malformed or linked auth file is refused rather than overwritten", t => {
  const { file, dir } = fixture(t); fs.writeFileSync(file, "invalid test data");
  assert.throws(() => updatePiAuthFile(file, data => { data.one = {}; }), /Invalid auth/);
  assert.equal(fs.readFileSync(file, "utf8"), "invalid test data");
  if (process.platform !== "win32") {
    const linked = path.join(dir, "linked.json"); fs.symlinkSync(file, linked);
    assert.throws(() => updatePiAuthFile(linked, data => { data.one = {}; }), /safely/);
    assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
  }
});

test("external refresh during write is preserved and reported as a failed save", t => {
  const { file, dir } = fixture(t); fs.writeFileSync(file, '{"other":"old"}');
  onSync = () => fs.writeFileSync(file, '{"other":"refreshed"}');
  assert.throws(() => updatePiAuthFile(file, data => { data.one = {}; }), /Could not save/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { other: "refreshed" });
  assert.deepEqual(fs.readdirSync(dir), ["auth.json"]);
});

test("skills uses one argv value, no Shell, and bounded command execution", () => {
  const query = 'two words "quoted"; $(test-only) & inert';
  runSkillsCommand("find", query, {}, error => assert.equal(error, null));
  const called = invocations.at(-1);
  assert.deepEqual(called.args.slice(-3), ["skills", "find", query]);
  assert.equal(called.options.shell, false); assert.equal(called.options.timeout, 15_000);
  assert.equal(called.options.maxBuffer, 2 * 1024 * 1024);
  assert.deepEqual(skillsArgs("add", "owner/repo@skill", true),
    ["skills", "add", "owner/repo@skill", "-y", "--agent", "pi", "-g"]);
  assert.doesNotThrow(() => skillsArgs("add", "https://github.com/owner/repo"));
  for (const input of ["--help", "", "owner/repo;evil", "owner/repo\nother", "$(inert)"]) {
    assert.throws(() => skillsArgs("add", input));
  }
});

test("Windows resolves Node and npm script without executing cmd shim", () => {
  const files = new Set(["C:\\Node\\node.exe", "C:\\npm\\node_modules\\npm\\bin\\npx-cli.js"]);
  assert.deepEqual(resolveSkillsRunner({ platform: "win32", pathValue: '"C:\\Node";C:\\npm', exists: p => files.has(p) }),
    { cmd: "C:\\Node\\node.exe", prefix: ["C:\\npm\\node_modules\\npm\\bin\\npx-cli.js"] });
  assert.throws(() => resolveSkillsRunner({ platform: "win32", pathValue: "C:\\missing", exists: () => false }), /Cannot locate/);
});

test("invalid source reports error without spawning anything", () => {
  const count = invocations.length;
  let reported;
  runSkillsCommand("add", "repo;inert", {}, error => { reported = error; });
  assert.ok(reported instanceof Error); assert.equal(invocations.length, count);
});
