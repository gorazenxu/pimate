import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: 'export { getPimateUiText, PIMATE_UI_TEXT_KEYS } from "./PimateUiText";',
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const compiled = new Module(`${root}pimate-ui-text-test.cjs`);
compiled.paths = Module._nodeModulePaths(root);
compiled._compile(
  bundle.outputFiles[0].text,
  compiled.filename = `${root}pimate-ui-text-test.cjs`
);
const { getPimateUiText, PIMATE_UI_TEXT_KEYS } = compiled.exports;

test("English UI strings contain no Chinese characters", () => {
  const values = {
    date: "2026-09-30",
    time: "Sep 30, 2026, 9:00 AM",
    error: "sample error",
    fileName: "Pimate Export.md",
    name: "example_tool",
  };

  for (const key of PIMATE_UI_TEXT_KEYS) {
    assert.doesNotMatch(
      getPimateUiText("en", key, values),
      /[\u3400-\u9fff]/,
      `English text for ${key} should not contain Chinese characters`
    );
  }
});

test("localized UI strings interpolate dynamic values", () => {
  assert.equal(
    getPimateUiText("en", "piExtensionError", { error: "sample error" }),
    "Pi extension error: sample error"
  );
  assert.equal(
    getPimateUiText("zh", "exportNoteSuccess", { fileName: "对话.md" }),
    "已导出笔记: 对话.md"
  );
});
