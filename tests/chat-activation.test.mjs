import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({ entryPoints: [`${root}main.ts`], bundle: true,
  write: false, platform: "node", format: "cjs", external: ["obsidian"] });
class Base {}
const stub = { Plugin: Base, ItemView: Base, Modal: Base, SuggestModal: Base,
  PluginSettingTab: Base, Setting: Base, Notice: Base };
const compiled = new Module(`${root}activation-test.cjs`);
compiled.paths = Module._nodeModulePaths(root);
const originalRequire = compiled.require.bind(compiled);
compiled.require = name => name === "obsidian" ? stub : originalRequire(name);
compiled._compile(bundle.outputFiles[0].text, compiled.filename = `${root}activation-test.cjs`);
const Plugin = compiled.exports.default;

for (const existing of [false, true]) {
  test(`open chat reveals collapsed sidebar (${existing ? "existing" : "new"} leaf)`, async () => {
    const calls = [];
    const leaf = { view: {}, setViewState: async state => { calls.push("create");
      assert.equal(state.type, "pimate-chat-view"); } };
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const workspace = {
      getLeavesOfType: () => existing ? [leaf] : [],
      getRightLeaf: () => leaf,
      revealLeaf: async target => { assert.equal(target, leaf); calls.push("reveal"); await gate; },
      setActiveLeaf: target => { assert.equal(target, leaf); calls.push("active"); },
    };
    const plugin = Object.create(Plugin.prototype); plugin.app = { workspace };
    const opened = plugin.activateView();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, existing ? ["reveal"] : ["create", "reveal"]);
    release(); assert.equal(await opened, leaf.view);
    assert.equal(calls.at(-1), "active");
  });
}
