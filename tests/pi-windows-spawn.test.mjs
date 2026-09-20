import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  stdin: { contents: 'export { resolveWindowsSpawn } from "./PiAgentClient";', resolveDir: root },
  bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent",
});
const compiled = new Module(`${root}pi-windows-spawn-test.cjs`);
compiled.paths = Module._nodeModulePaths(root);
compiled._compile(bundle.outputFiles[0].text, compiled.filename = `${root}pi-windows-spawn-test.cjs`);
const { resolveWindowsSpawn } = compiled.exports;

function windowsLayout({ shimDir, packageDir, bin, files = [] }) {
  const paths = new Set([
    `${shimDir}\\pi.cmd`,
    `${shimDir}\\node.exe`,
    `${packageDir}\\package.json`,
    ...files,
  ]);
  return {
    platform: "win32",
    pathValue: `${shimDir};C:\\Windows\\System32`,
    exists: (candidate) => paths.has(candidate),
    readText: (candidate) => {
      assert.equal(candidate, `${packageDir}\\package.json`);
      return JSON.stringify({ bin: { pi: bin } });
    },
  };
}

test("Windows resolves Pi 0.85 through the package bin entry", () => {
  const shimDir = "C:\\Users\\alex\\AppData\\Local\\pi-node\\current";
  const packageDir = `${shimDir}\\node_modules\\@earendil-works\\pi-coding-agent`;
  const bundledCli = `${packageDir}\\dist\\bundle\\cli.js`;
  const result = resolveWindowsSpawn("pi", windowsLayout({
    shimDir,
    packageDir,
    bin: "dist/bundle/cli.js",
    files: [bundledCli, `${packageDir}\\dist\\cli.js`],
  }));

  assert.deepEqual(result, {
    cmd: `${shimDir}\\node.exe`,
    scriptArgs: [bundledCli],
  });
});

test("Windows supports a local node_modules/.bin Pi installation", () => {
  const shimDir = "C:\\work\\vault\\node_modules\\.bin";
  const packageDir = "C:\\work\\vault\\node_modules\\@earendil-works\\pi-coding-agent";
  const bundledCli = `${packageDir}\\dist\\bundle\\cli.js`;
  const result = resolveWindowsSpawn("pi", windowsLayout({
    shimDir,
    packageDir,
    bin: "dist/bundle/cli.js",
    files: [bundledCli],
  }));

  assert.deepEqual(result?.scriptArgs, [bundledCli]);
});

test("Windows retains the legacy unbundled entry as a fallback", () => {
  const shimDir = "C:\\tools\\pi";
  const packageDir = `${shimDir}\\node_modules\\@earendil-works\\pi-coding-agent`;
  const legacyCli = `${packageDir}\\dist\\cli.js`;
  const result = resolveWindowsSpawn("pi", windowsLayout({
    shimDir,
    packageDir,
    bin: "dist/cli.js",
    files: [legacyCli],
  }));

  assert.deepEqual(result?.scriptArgs, [legacyCli]);
});

test("Windows ignores a package bin path that escapes the Pi package", () => {
  const shimDir = "C:\\tools\\pi";
  const packageDir = `${shimDir}\\node_modules\\@earendil-works\\pi-coding-agent`;
  const bundledCli = `${packageDir}\\dist\\bundle\\cli.js`;
  const result = resolveWindowsSpawn("pi", windowsLayout({
    shimDir,
    packageDir,
    bin: "..\\outside.js",
    files: [bundledCli, `${shimDir}\\node_modules\\@earendil-works\\outside.js`],
  }));

  assert.deepEqual(result?.scriptArgs, [bundledCli]);
});
