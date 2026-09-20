import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Exercise the real adapter with synthetic AGY frames, without starting AGY,
// spending tokens, writing vault files, or reading the user's conversations.
const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  stdin: { contents: 'export * from "./AgyAgentClient"; export * from "./AgyDiagnostics"; export * from "./AgyUsageStore";', resolveDir: root },
  bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent",
});
const compiled = new Module(`${root}agy-test.cjs`);
compiled.paths = Module._nodeModulePaths(root);
compiled._compile(bundle.outputFiles[0].text, compiled.filename = `${root}agy-test.cjs`);
const { AgyAgentClient, AgyDiagnosticStore, AgyUsageStore, classifyAgyFailure, sanitizeAgyDiagnostic } = compiled.exports;
const records = [];
const writeDiagnostic = AgyDiagnosticStore.record;
AgyDiagnosticStore.record = (entry) => records.push(entry);
const usageSnapshots = [];
const writeUsage = AgyUsageStore.record;
const readUsage = AgyUsageStore.getLatest;
AgyUsageStore.record = (snapshot) => usageSnapshots.push(snapshot);
AgyUsageStore.getLatest = async () => null;
test.after(() => {
  AgyDiagnosticStore.record = writeDiagnostic;
  AgyUsageStore.record = writeUsage;
  AgyUsageStore.getLatest = readUsage;
});

function session() {
  records.length = 0;
  usageSnapshots.length = 0;
  const client = new AgyAgentClient({ trackUsage: false });
  const events = [], writes = [];
  client.process = { stdin: { write: (value) => writes.push(value) } };
  client.on("event", (event) => events.push(event));
  client.beginPrompt("Synthetic request");
  return { client, events, writes };
}
function terminal(client, status, error = "", response) {
  client.handleAgyEvent({ event: "result", result: { status, error, response } });
}
const errors = (events) => events.filter(e => e.assistantMessageEvent?.type === "error").map(e => e.assistantMessageEvent);

test("stream interruption and remote cancellation never imply a local Stop", () => {
  for (const [reason, status, expected] of [
    ["The stream was interrupted. Please continue the task you were working on.", "ERROR", "network"],
    ["Operation aborted by user", "ERROR", "interrupted"],
    ["", "CANCELLED", "interrupted"],
    ["context canceled", "ERROR", "interrupted"],
    ["timeout waiting for response", "ERROR", "timeout"],
    ["Process exited with code 1", "ERROR", "process"],
    ["INVALID_ARGUMENT (400)", "ERROR", "unknown"],
    ["Your previous response was blocked by content safety filters", "ERROR", "content_safety"],
  ]) {
    assert.equal(classifyAgyFailure(reason, false, status), expected);
    assert.equal(classifyAgyFailure(reason, true, status), "cancelled");
  }
});

test("safety-filtered terminal result keeps visible text, is not retryable, and persists observed usage", () => {
  const client = new AgyAgentClient({
    conversationId: "11111111-1111-4111-8111-111111111111",
    modelId: "gemini-3.8-flash-high",
  });
  const events = [];
  client.process = { stdin: { write: () => {} } };
  // This test exercises the usage journal only; keep its synthetic prompt
  // from touching the user's independent request ledger.
  client.persistRequestRecord = () => {};
  client.on("event", (event) => events.push(event));
  client.beginPrompt("Synthetic request");
  client.handleAgyEvent({
    event: "step_update",
    step_update: {
      step_type: "agent_response",
      text_delta: "A visible answer before the safety result.",
      usage: {
        input_tokens: 120,
        output_tokens: 80,
        thinking_tokens: 20,
        cache_read_tokens: 900,
        total_tokens: 200,
      },
    },
  });
  terminal(
    client,
    "ERROR",
    "Your previous response was blocked by content safety filters: The model output could not be generated. Retries remaining: 3"
  );
  const error = errors(events)[0];
  assert.equal(error.errorCategory, "content_safety");
  assert.equal(error.receivedModelOutput, true);
  assert.equal(error.retryable, false);
  assert.equal(usageSnapshots.length, 1);
  assert.deepEqual(usageSnapshots[0].cumulative, {
    input: 120, output: 80, thinking: 20, cacheRead: 900, total: 200,
  });
  assert.equal(records[0].category, "content_safety");
});

test("content safety failures are never offered for replay even without streamed text", () => {
  const { client, events } = session();
  terminal(client, "ERROR", "Blocked by content safety filters");
  assert.equal(errors(events)[0].errorCategory, "content_safety");
  assert.equal(errors(events)[0].retryable, false);
});

test("completed text followed by stream failure retains reason, reply, and disallows replay", async () => {
  const { client, events, writes } = session();
  client.handleAgyEvent({ event: "step_update", step_update: { step_type: "tool", step_index: 1, state: "DONE", tool_name: "write_to_file" } });
  client.handleAgyEvent({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "Files updated. Finished." } });
  client.recordTurnStderr("ERROR: logging before google.Init: I0905 09:00:00 quota_manager.go: doRefreshQuota\ncontext canceled\n");
  const reason = "The stream was interrupted. Please continue the task you were working on.";
  terminal(client, "ERROR", reason);
  assert.equal(errors(events)[0].reason, reason);
  assert.equal(errors(events)[0].errorCategory, "network");
  assert.equal(errors(events)[0].retryable, false);
  assert.equal(errors(events)[0].receivedModelOutput, true);
  assert.equal(errors(events)[0].hadToolActivity, true);
  assert.equal(writes.length, 1);
  assert.equal(records[0].stopRequested, false);
  assert.equal(records[0].error, reason);
  assert.equal(records[0].status, "ERROR");
  assert.equal(records[0].hadToolActivity, true);
  assert.equal(records[0].receivedModelOutput, true);
  assert.ok(!JSON.stringify(records[0]).includes("Files updated"));
  assert.ok(!errors(events)[0].diagnostic?.includes("doRefreshQuota"));
  assert.equal(events.filter(e => e.type === "agent_settled").length, 1);
  const history = (await client.getMessages()).data.messages;
  const reply = history.find((message) => message.role === "assistant");
  assert.equal(reply?.content.find((block) => block.type === "text")?.text, "Files updated. Finished.");
});

test("final-only failed response is rendered and retained in history", async () => {
  const { client, events } = session();
  terminal(client, "ERROR", "The stream was interrupted", "The answer was completed before close.");
  const textDeltas = events
    .filter((event) => event.assistantMessageEvent?.type === "text_delta")
    .map((event) => event.assistantMessageEvent.delta);
  assert.deepEqual(textDeltas, ["The answer was completed before close."]);
  assert.equal(errors(events)[0].receivedModelOutput, true);
  const history = (await client.getMessages()).data.messages;
  assert.equal(
    history.find((message) => message.role === "assistant")?.content[0]?.text,
    "The answer was completed before close."
  );
});

test("invalidating AGY history reloads the native transcript after a tab switch", async () => {
  const client = new AgyAgentClient({
    conversationId: "synthetic-conversation",
    trackUsage: false,
  });
  client.process = { stdin: { write: () => {} } };
  let loads = 0;
  let persisted = [];
  client.loadTranscriptHistory = () => {
    loads++;
    return persisted;
  };

  await client.getMessages({ limit: 100 });
  assert.equal(loads, 1);
  client.beginPrompt("A request with a late transcript flush");
  client.handleAgyEvent({
    event: "step_update",
    step_update: { step_type: "agent_response", text_delta: "Reply survives switching." },
  });
  terminal(client, "ERROR", "The stream was interrupted");

  persisted = [
    { role: "user", content: [{ type: "text", text: "A request with a late transcript flush" }] },
    { role: "assistant", content: [{ type: "text", text: "Reply survives switching." }] },
  ];
  client.invalidateHistoryCache();
  const reloaded = (await client.getMessages({ limit: 100 })).data.messages;
  assert.equal(loads, 2);
  assert.equal(
    reloaded.filter((message) => message.role === "assistant").length,
    1
  );
  assert.equal(reloaded.at(-1).content[0].text, "Reply survives switching.");
});

test("actual abort is cancelled, suppresses diagnostics, and resets on the next prompt", async () => {
  const { client, events } = session();
  client.recordTurnStderr("error: unrelated browser problem\n");
  // The already-exited-child branch settles without signalling a real process.
  client.process.exitCode = 0;
  await client.abort();
  assert.equal(errors(events)[0].errorCategory, "cancelled");
  assert.equal(errors(events)[0].diagnostic, undefined);
  assert.equal(errors(events)[0].retryable, false);
  assert.equal(records[0].stopRequested, true);
  client.beginPrompt("Next synthetic request");
  terminal(client, "ERROR", "The stream was interrupted");
  assert.equal(errors(events)[1].errorCategory, "network");
  assert.equal(records[1].stopRequested, false);
});

test("successful final-only response is recorded as success without an error", () => {
  const { client, events } = session();
  terminal(client, "SUCCESS", "", "Final-only text");
  assert.equal(errors(events).length, 0);
  assert.equal(records[0].status, "SUCCESS");
  assert.equal(records[0].responseChars, "Final-only text".length);
  assert.equal(records[0].receivedModelOutput, true);
  assert.ok(!JSON.stringify(records[0]).includes("Final-only text"));
  terminal(client, "ERROR", "late duplicate");
  assert.equal(records.length, 1);
  assert.equal(errors(events).length, 0);
});

test("remote cancellation preserves AGY wording without asserting user action", () => {
  const { client, events } = session();
  terminal(client, "CANCELLED", "Remote task cancelled");
  assert.equal(errors(events)[0].errorCategory, "interrupted");
  assert.equal(errors(events)[0].reason, "Remote task cancelled");
  assert.equal(records[0].stopRequested, false);
});

test("SIGINT result retains backend wording while recording the local stop request", async () => {
  const { client, events } = session();
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    assert.equal(signal, "SIGINT");
    terminal(client, "CANCELLED", "Request interrupted");
    child.exitCode = 0;
    child.emit("close", 0);
    return true;
  };
  client.process = child;
  await client.abort();
  assert.equal(errors(events)[0].errorCategory, "cancelled");
  assert.equal(records[0].error, "Request interrupted");
  assert.equal(records[0].stopRequested, true);
});

test("UI error data redacts email and credentials", () => {
  const { client, events } = session();
  terminal(client, "ERROR", 'Request failed for demo@example.com api_key="private-example-key"');
  assert.ok(!errors(events)[0].reason.includes("demo@example.com"));
  assert.ok(!errors(events)[0].reason.includes("private-example-key"));
});

test("diagnostics remove common secrets, account paths and URL credentials", () => {
  const text = sanitizeAgyDiagnostic([
    'email=demo@example.com access_token="private-example-token"',
    'Authorization: Bearer private-example-bearer',
    '{"refresh_token":"private-example-refresh"}',
    'https://demo:private-example-pass@example.com/path?key=private-example-url',
    '/Users/Example/Private Vault/file.md',
    'C:\\Users\\Example\\Private Vault\\file.md',
  ].join("\n"));
  assert.ok(!/demo@example|private-example|Private Vault/.test(text));
  assert.ok(text.includes("[email]"));
  assert.ok(text.includes("[local path]"));
});

test("journal rotates, redacts before storage and excludes conversation payloads", async (t) => {
  const originals = Object.fromEntries(["mkdir", "stat", "rename", "appendFile"].map(k => [k, fs[k]]));
  t.after(() => Object.assign(fs, originals));
  const calls = [];
  fs.mkdir = async () => {};
  fs.stat = async () => ({ size: 256 * 1024 });
  fs.rename = async (from, to) => { calls.push({ from, to }); };
  fs.appendFile = async (file, line, options) => { calls.push({ file, line, options }); };
  writeDiagnostic.call(AgyDiagnosticStore, {
    at: new Date().toISOString(), conversationId: null,
    source: "result", status: "ERROR", error: "demo@example.com api_key=private-key",
    stopRequested: false, receivedModelOutput: true, hadToolActivity: true, responseChars: 10,
    response: "PRIVATE CONVERSATION", prompt: "PRIVATE PROMPT",
  }, "/synthetic-private-vault");
  await AgyDiagnosticStore.tail;
  assert.equal(calls.length, 2);
  assert.equal(calls[0].to, `${calls[0].from}.previous`);
  const saved = JSON.parse(calls[1].line);
  assert.equal(saved.status, "ERROR");
  assert.equal(calls[1].options.mode, 0o600);
  assert.ok(!/demo@example|private-key|PRIVATE CONVERSATION|PRIVATE PROMPT/.test(calls[1].line));
  assert.ok(!calls[1].file.includes("synthetic-private-vault"));
});
