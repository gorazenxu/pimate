import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = process.env.PIMATE_AGY_HISTORY_BASELINE === "1"
  ? execFileSync("git", ["show", "HEAD:AgyAgentClient.ts"], { cwd: root, encoding: "utf8" })
  : 'export * from "./AgyAgentClient";';
const bundle = await build({ stdin: { contents: source + '\nexport * from "./AgyHistoryMerge";',
  resolveDir: root, loader: "ts" }, bundle: true, write: false, platform: "node", format: "cjs" });
const compiled = new Module(`${root}agy-history-merge-test.cjs`);
compiled.filename = `${root}agy-history-merge-test.cjs`;
compiled.paths = Module._nodeModulePaths(root);
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { AgyAgentClient, mergeAgyHistory } = compiled.exports;
const user = text => ({ role: "user", content: [{ type: "text", text }] });
const assistant = text => ({ role: "assistant", content: [{ type: "text", text }] });
const textOf = message => message.content.filter(block => block.type === "text").map(block => block.text).join("");

function session(initial = [user("Earlier request"), assistant("Earlier answer")]) {
  const client = new AgyAgentClient({ trackUsage: false, conversationId: "synthetic-history-merge" });
  let persisted = [...initial];
  client.loadTranscriptHistory = limit => limit > 0 ? persisted.slice(-limit) : [...persisted];
  client.recordTerminalDiagnostic = () => {};
  const writes = [], events = [];
  client.process = { stdin: { write: payload => writes.push(payload) } };
  client.on("event", event => events.push(event));
  const reload = async () => {
    client.invalidateHistoryCache();
    return (await client.getMessages({ limit: 0 })).data.messages;
  };
  const terminal = (status = "SUCCESS", response = "New answer") => client.handleAgyEvent({
    event: "result", result: { status, response, error: status === "SUCCESS" ? "" : "The stream was interrupted" },
  });
  return { client, writes, events, reload, terminal, persist: messages => { persisted = messages; } };
}

for (const outcome of ["in-flight", "success", "error"]) {
  test(`stale nonempty transcript retains the current user input (${outcome}), without replay`, async () => {
    const s = session();
    await s.client.prompt("New request");
    if (outcome !== "in-flight") s.terminal(outcome === "success" ? "SUCCESS" : "ERROR");
    for (let i = 0; i < 3; i++) {
      const history = await s.reload();
      assert.equal(history.filter(message => message.role === "user" && textOf(message) === "New request").length, 1);
      if (outcome !== "in-flight") assert.equal(textOf(history.at(-1)), "New answer");
    }
    assert.equal(s.writes.length, 1);
    assert.equal(JSON.parse(s.writes[0]).message.content, "New request");
  });
}

test("native flush confirms the local turn and retires it without duplicate input or reply", async () => {
  const s = session([]);
  await s.client.prompt("New request"); s.terminal();
  assert.deepEqual(await s.reload(), [user("New request"), assistant("New answer")]);
  s.persist([user("New request"), assistant("New answer")]);
  assert.deepEqual(await s.reload(), [user("New request"), assistant("New answer")]);
  assert.equal(s.client.historyOverlayTurns.length, 0);
  assert.deepEqual(await s.reload(), [user("New request"), assistant("New answer")]);
  assert.equal(s.writes.length, 1);
});

test("a native user-only flush cannot remove the unflushed final answer", async () => {
  const s = session([]);
  await s.client.prompt("New request"); s.terminal();
  s.persist([user("New request")]);
  assert.deepEqual(await s.reload(), [user("New request"), assistant("New answer")]);
  assert.equal(s.client.historyOverlayTurns.length, 1);
  s.persist([user("New request"), assistant("New answer")]);
  await s.reload(); assert.equal(s.client.historyOverlayTurns.length, 0);
});

test("an in-flight native user remains anchored until its terminal reply is known", async () => {
  const s = session([]);
  await s.client.prompt("New request");
  s.persist([user("New request")]);
  await s.reload();
  assert.equal(s.client.historyOverlayTurns.length, 1);
  s.terminal();
  assert.deepEqual(await s.reload(), [user("New request"), assistant("New answer")]);
});

test("a temporarily empty transcript does not confirm or erase local-only turns", async () => {
  const s = session();
  await s.client.prompt("New request"); s.terminal();
  s.persist([]);
  const messages = await s.reload();
  assert.equal(messages.length, 4);
  assert.equal(textOf(messages[2]), "New request");
  assert.equal(s.client.historyOverlayTurns.length, 1);
  assert.deepEqual(await s.reload(), messages);
});

test("identical consecutive prompts and replies remain separate when only the first has flushed", async () => {
  const s = session([]);
  await s.client.prompt("OK"); s.terminal("SUCCESS", "Done");
  s.persist([user("OK"), assistant("Done")]);
  await s.client.prompt("OK"); s.terminal("SUCCESS", "Done");
  const expected = [user("OK"), assistant("Done"), user("OK"), assistant("Done")];
  assert.deepEqual(await s.reload(), expected);
  s.persist(expected);
  assert.deepEqual(await s.reload(), expected);
  assert.equal(s.client.historyOverlayTurns.length, 0);
  assert.equal(s.writes.length, 2);
});

test("repeated prompts beyond the limited 100-message tail use the complete baseline", async () => {
  const native = Array.from({ length: 125 }, () => [user("OK"), assistant("Done")]).flat();
  const s = session(native);
  await s.client.getMessages({ limit: 100 });
  await s.client.prompt("OK"); s.terminal("SUCCESS", "Done");
  const messages = await s.reload();
  assert.equal(messages.length, 252);
  assert.equal(messages.filter(message => message.role === "user").length, 126);
  s.persist([...native, user("OK"), assistant("Done")]);
  assert.equal((await s.reload()).length, 252);
  assert.equal(s.client.historyOverlayTurns.length, 0);
});

test("a missing earlier reply stays before a later flushed user turn", async () => {
  const s = session([]);
  await s.client.prompt("First"); s.terminal("SUCCESS", "First answer");
  await s.client.prompt("Second"); s.terminal("SUCCESS", "Second answer");
  s.persist([user("First"), user("Second"), assistant("Second answer")]);
  assert.deepEqual(await s.reload(), [user("First"), assistant("First answer"), user("Second"), assistant("Second answer")]);
  assert.equal(s.writes.length, 2);
});

test("partial native answer is extended in place while preserving native tool and thinking blocks", async () => {
  const native = [user("New request"), { role: "assistant", content: [
    { type: "thinking", thinking: "Native thought" },
    { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "example.md" } },
    { type: "text", text: "New" },
  ] }];
  const original = JSON.stringify(native);
  const overlay = { ordinal: 1, user: user("New request"), assistant: assistant("New answer"), completed: true };
  const merged = mergeAgyHistory(native, [overlay]);
  assert.equal(merged.messages.length, 2);
  assert.equal(textOf(merged.messages[1]), "New answer");
  assert.deepEqual(merged.messages[1].content.slice(0, 2), native[1].content.slice(0, 2));
  assert.equal(merged.pendingTurns.length, 1);
  assert.equal(JSON.stringify(native), original);
});

test("native response thinking and tool metadata do not duplicate the observed final reply", () => {
  const native = [user("New request"), { role: "assistant", content: [
    { type: "thinking", thinking: "Native thought" }, { type: "text", text: "New answer" },
  ] }];
  const merged = mergeAgyHistory(native, [{ ordinal: 1, user: user("New request"),
    assistant: assistant("New answer"), completed: true }]);
  assert.deepEqual(merged.messages, native);
  assert.equal(merged.pendingTurns.length, 0);
});

test("different native input at the expected turn cannot silently acknowledge a local input", () => {
  const merged = mergeAgyHistory([user("Other input")], [{ ordinal: 1,
    user: user("Local input"), completed: true }]);
  assert.deepEqual(merged.messages, [user("Other input"), user("Local input")]);
  assert.equal(merged.pendingTurns.length, 1);
});

test("queue drain keeps each accepted input once and history reads never run queued tools again", async () => {
  const s = session([]);
  await s.client.prompt("First");
  await s.client.prompt("Second", { streamingBehavior: "followUp" });
  assert.equal(s.writes.length, 1);
  s.terminal("SUCCESS", "First answer");
  assert.equal(s.writes.length, 2);
  s.terminal("SUCCESS", "Second answer");
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await s.reload(), [user("First"), assistant("First answer"), user("Second"), assistant("Second answer")]);
  }
  assert.equal(s.writes.length, 2);
});

test("a failed stdin write rolls back only the unsent history turn and does not replay", async () => {
  const s = session([]);
  s.client.process.stdin.write = () => { throw new Error("Synthetic pipe failure"); };
  await assert.rejects(s.client.prompt("Unsent request"), /Synthetic pipe failure/);
  assert.equal(s.client.historyOverlayTurns.length, 0);
  assert.equal((await s.reload()).length, 0);
  assert.equal(s.writes.length, 0);
});

test("resetting for another conversation clears all native and unconfirmed history", async () => {
  const s = session([]);
  await s.client.prompt("Only in the first conversation"); s.terminal();
  s.client.resetHistoryCache();
  s.client.conversationId = "another-synthetic-conversation";
  s.persist([user("Other conversation")]);
  assert.deepEqual(await s.reload(), [user("Other conversation")]);
  assert.equal(s.client.historyOverlayTurns.length, 0);
  assert.equal(s.client.activeHistoryTurn, null);
  assert.equal(s.writes.length, 1);
});

test("native USER_REQUEST wrappers reconcile with local inputs after a partial JSONL flush", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pimate-agy-late-flush-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = session([]);
  s.client.getAgyDataDir = () => dir;
  delete s.client.loadTranscriptHistory;
  const folder = join(dir, "brain", "synthetic-history-merge", ".system_generated", "logs");
  await mkdir(folder, { recursive: true });
  const file = join(folder, "transcript.jsonl");
  const old = JSON.stringify({ type: "USER_INPUT", content: "Earlier request" });
  await writeFile(file, old + "\n");
  await s.client.prompt("New request"); s.terminal();
  const current = JSON.stringify({ type: "USER_INPUT", content: "Metadata\n<USER_REQUEST>\nNew request\n</USER_REQUEST>" });
  await writeFile(file, old + "\n" + current.slice(0, -5));
  assert.equal((await s.reload()).filter(message => message.role === "user").length, 2);
  await writeFile(file, old + "\n" + current + "\n" + JSON.stringify({
    type: "PLANNER_RESPONSE", content: "New answer", thinking: "Native thought", tool_calls: [],
  }) + "\n");
  const restored = await s.reload();
  assert.equal(restored.length, 3);
  assert.equal(textOf(restored[1]), "New request");
  assert.equal(s.client.historyOverlayTurns.length, 0);
  assert.equal(s.writes.length, 1);
});
