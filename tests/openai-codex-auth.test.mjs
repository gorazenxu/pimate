import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: 'export * from "./OpenAICodexAuth";',
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const compiled = new Module(`${root}openai-codex-auth-test.cjs`);
compiled.paths = Module._nodeModulePaths(root);
compiled._compile(
  bundle.outputFiles[0].text,
  compiled.filename = `${root}openai-codex-auth-test.cjs`
);
const {
  createOpenAICodexOAuthCredentials,
  extractOpenAICodexAccountId,
  migrateLegacyOpenAICodexCredential,
} = compiled.exports;

function jwtWithPayload(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

test("extracts the official nested ChatGPT account id claim", () => {
  const access = jwtWithPayload({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_123" },
  });
  assert.equal(extractOpenAICodexAccountId(access), "acct_test_123");
});

test("creates the OAuth credential shape consumed by Pi", () => {
  const access = jwtWithPayload({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_456" },
  });
  assert.deepEqual(
    createOpenAICodexOAuthCredentials({
      access,
      refresh: "refresh_test",
      expires: 1770000000000,
    }),
    {
      type: "oauth",
      access,
      refresh: "refresh_test",
      expires: 1770000000000,
      accountId: "acct_test_456",
    }
  );
});

test("repairs the legacy API-key-wrapped OAuth entry", () => {
  const access = jwtWithPayload({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_legacy" },
  });
  const migrated = migrateLegacyOpenAICodexCredential({
    type: "api_key",
    key: JSON.stringify({
      type: "oauth",
      access,
      refresh: "refresh_legacy",
      expires: 1770000000000,
    }),
  });
  assert.deepEqual(migrated, {
    type: "oauth",
    access,
    refresh: "refresh_legacy",
    expires: 1770000000000,
    accountId: "acct_legacy",
  });
});

test("does not reinterpret a normal API key as OAuth", () => {
  assert.equal(
    migrateLegacyOpenAICodexCredential({ type: "api_key", key: "sk-test" }),
    null
  );
});
