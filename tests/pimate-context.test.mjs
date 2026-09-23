import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: 'export * from "./PimateContextUtils";',
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const compiled = new Module(`${root}pimate-context-test.cjs`);
compiled.paths = Module._nodeModulePaths(root);
compiled._compile(
  bundle.outputFiles[0].text,
  (compiled.filename = `${root}pimate-context-test.cjs`)
);

const {
  getVaultFileExtension,
  getVaultFileIcon,
  getVaultFileTypeLabel,
  isVaultContextFilePath,
} = compiled.exports;

test("accepts common notes, code, Office files, PDFs, and images", () => {
  for (const filePath of [
    "notes/readme.md",
    "data/table.xlsx",
    "draft/report.docx",
    "slides/plan.pptx",
    "assets/scan.pdf",
    "assets/cover.png",
    "scripts/check.py",
  ]) {
    assert.equal(isVaultContextFilePath(filePath), true, filePath);
  }
});

test("rejects internal paths and unsupported files", () => {
  for (const filePath of [
    ".obsidian/plugins/pimate/data.json",
    ".trash/deleted.md",
    ".git/index",
    "node_modules/pkg/index.js",
    "exports/archive.zip",
    "scratch/no-extension",
    "scratch/.DS_Store",
  ]) {
    assert.equal(isVaultContextFilePath(filePath), false, filePath);
  }
});

test("normalizes separators and extension casing", () => {
  assert.equal(getVaultFileExtension("data\\table.XLSX"), "xlsx");
  assert.equal(isVaultContextFilePath("data\\table.XLSX"), true);
  assert.equal(getVaultFileExtension("README"), "");
});

test("returns consistent labels and icons", () => {
  assert.equal(getVaultFileTypeLabel("xlsx"), "table");
  assert.equal(getVaultFileTypeLabel("pptx"), "slides");
  assert.equal(getVaultFileTypeLabel("py"), "code");
  assert.equal(getVaultFileIcon("docx"), "📑");
  assert.equal(getVaultFileIcon("jpg"), "🖼");
  assert.equal(getVaultFileIcon("unknown"), "📎");
});
