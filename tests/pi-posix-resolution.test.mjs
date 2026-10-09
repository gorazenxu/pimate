import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({ entryPoints: [join(root, "PiAgentClient.ts")],
  bundle: true, write: false, platform: "node", format: "cjs" });
const compiled = new Module(join(root, "posix-test.cjs"));
compiled.paths = Module._nodeModulePaths(root);
compiled._compile(bundle.outputFiles[0].text, join(root, "posix-test.cjs"));
const { resolvePosixSpawn, piChildPath } = compiled.exports;
const limitedPath = "/usr/bin:/bin:/usr/sbin:/sbin";
const managed = "/fixture-home/.pi/agent/bin/pi";
const node = "/opt/homebrew/bin/node";
function options(files, extra = {}) {
  return { platform: "darwin", pathValue: limitedPath, homeDir: "/fixture-home",
    isExecutable: candidate => files.includes(candidate), realPath: candidate => candidate,
    ...extra };
}

test("GUI PATH discovers managed launcher and supplies Homebrew Node", () => {
  assert.deepEqual(resolvePosixSpawn("pi", options([managed, node])), {
    cmd: managed, scriptArgs: [], nodePath: node,
  });
  assert.equal(piChildPath(limitedPath, node), `/opt/homebrew/bin:${limitedPath}`);
});
test("explicit managed path retains launcher instead of pinning its release", () => {
  assert.equal(resolvePosixSpawn(managed, options([managed, node])).cmd, managed);
});
test("PATH installation wins and npm JS entry still starts via Node", () => {
  const pi = "/usr/local/bin/pi";
  assert.deepEqual(resolvePosixSpawn("pi", options([pi, managed, node], {
    pathValue: `/usr/local/bin:${limitedPath}`,
    realPath: candidate => candidate === pi ? "/npm/pi/dist/bundle/cli.js" : candidate,
  })), { cmd: node, scriptArgs: ["/npm/pi/dist/bundle/cli.js"], nodePath: node });
});
test("custom commands do not resolve to managed Pi; missing Node does not get invented", () => {
  assert.equal(resolvePosixSpawn("other", options([managed, node])), null);
  assert.deepEqual(resolvePosixSpawn("pi", options([managed])), { cmd: managed, scriptArgs: [] });
  assert.equal(resolvePosixSpawn("pi", options([managed], { platform: "win32" })), null);
});
test("Intel Homebrew Node is supported and child PATH is deduplicated", () => {
  const intelNode = "/usr/local/bin/node";
  assert.equal(resolvePosixSpawn("pi", options([managed, intelNode])).nodePath, intelNode);
  assert.equal(piChildPath("/usr/bin:/usr/local/bin:/bin", intelNode), "/usr/local/bin:/usr/bin:/bin");
});
test("real shell launcher finds env node with repaired restricted PATH", {
  skip: process.platform === "win32", timeout: 5000,
}, t => {
  const dir = mkdtempSync(join(tmpdir(), "pimate-managed-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "node-bin"), agentBin = join(dir, ".pi", "agent", "bin");
  mkdirSync(bin); mkdirSync(agentBin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  const launcher = join(agentBin, "pi");
  writeFileSync(launcher, '#!/bin/sh\nexec /usr/bin/env node -e \'console.log("managed-fixture-ok")\'\n', { mode: 0o700 });
  const resolved = resolvePosixSpawn("pi", { homeDir: dir, pathValue: bin });
  assert.equal(resolved.cmd, launcher);
  const result = spawnSync(resolved.cmd, resolved.scriptArgs, {
    env: { PATH: piChildPath("/nonexistent-pimate-path", resolved.nodePath) },
    encoding: "utf8", timeout: 3000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "managed-fixture-ok");
});
