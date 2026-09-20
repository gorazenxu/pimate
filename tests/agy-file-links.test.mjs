import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  entryPoints: [`${root}AgyFileLinkUtils.ts`],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const compiled = new Module(`${root}agy-file-links-test.cjs`);
compiled._compile(bundle.outputFiles[0].text, `${root}agy-file-links-test.cjs`);
const { normalizeAgyFileLinks } = compiled.exports;

const vault = "/Users/Example/Obsidian Vault";
const encodedPath =
  "file:///Users/Example/Obsidian%20Vault/03-%E8%AE%A4%E7%9F%A5%E7%B3%BB%E5%88%97/R30-%E5%89%AA%E6%98%A0AI.md";

test("normalizes encoded AGY file links split across lines", () => {
  const input = `[R30 剪映AI直接粘贴版]\n(${encodedPath})`;
  assert.equal(
    normalizeAgyFileLinks(input, vault),
    "[[03-认知系列/R30-剪映AI.md|R30 剪映AI直接粘贴版]]"
  );
});

test("normalizes bare Vault file URLs without exposing the absolute path", () => {
  assert.equal(
    normalizeAgyFileLinks(encodedPath, vault),
    "[[03-认知系列/R30-剪映AI.md]]"
  );
});

test("hides local file URLs outside the active Vault", () => {
  assert.equal(
    normalizeAgyFileLinks(
      `[private file]\n(file:///Users/Example/Private/secret.md)`,
      vault
    ),
    "private file"
  );
});

test("does not rewrite file URLs inside fenced code blocks", () => {
  const input = "```text\n" + encodedPath + "\n```";
  assert.equal(normalizeAgyFileLinks(input, vault), input);
});
