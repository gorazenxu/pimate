import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { Module } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
// Optional negative control: the same behavior tests must fail on the
// pre-fix source. Compile it in memory, without checking out or editing files.
const sourceOptions = process.env.PIMATE_TEST_BASELINE === "1"
  ? { stdin: { contents: execFileSync("git", ["show", "HEAD:PiAgentView.ts"],
      { cwd: root, encoding: "utf8" }), resolveDir: root, loader: "ts" } }
  : { entryPoints: [`${root}PiAgentView.ts`] };
const bundle = await build({ ...sourceOptions, bundle: true,
  write: false, platform: "node", format: "cjs", external: ["obsidian"] });
let markdownRender = async () => {};
const notices = [];
class Base {}
const obsidian = { ItemView: Base, Modal: Base, SuggestModal: Base,
  Notice: class { constructor(text) { notices.push(text); } },
  MarkdownRenderer: { render: (...args) => markdownRender(...args) } };
const compiled = new Module(`${root}chat-ui-test.cjs`);
compiled.filename = `${root}chat-ui-test.cjs`;
compiled.paths = Module._nodeModulePaths(root);
const requireOriginal = compiled.require.bind(compiled);
compiled.require = name => name === "obsidian" ? obsidian : requireOriginal(name);
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { PiAgentView } = compiled.exports;
globalThis.window = globalThis;
globalThis.activeDocument = new EventTarget();
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => {
  resolve = a; reject = b;
}); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

// Minimal DOM double, including attachment and node replacement semantics.
class Element {
  children = []; parentElement = null; textContent = ""; attrs = new Map(); connected = false;
  ownerDocument = { createElement: () => new Element() };
  classes = new Set();
  classList = { add: (...names) => names.forEach(n => this.classes.add(n)),
    remove: (...names) => names.forEach(n => this.classes.delete(n)),
    contains: name => this.classes.has(name) };
  removeClass(name) { this.classList.remove(name); }
  get isConnected() { return this.connected || !!this.parentElement?.isConnected; }
  get childNodes() { return this.children; }
  contains(node) { return node === this || this.children.some(c => c.contains(node)); }
  append(child) { child.remove(); child.parentElement = this; this.children.push(child); }
  createDiv(options) { const el = new Element();
    const cls = typeof options === "string" ? options : options?.cls;
    if (cls) el.classList.add(...cls.split(" ")); this.append(el); return el; }
  createSpan(options) { return this.createDiv(options); }
  setText(text) { this.textContent = text; }
  setAttribute(key, value) { this.attrs.set(key, value); }
  getAttribute(key) { return this.attrs.get(key) ?? null; }
  remove() { if (this.parentElement) {
    this.parentElement.children = this.parentElement.children.filter(c => c !== this);
    this.parentElement = null;
  } }
  empty() { for (const child of [...this.children]) child.remove(); this.textContent = ""; }
  replaceChildren(...children) { this.empty(); children.forEach(c => this.append(c)); }
}
function view(client = null) {
  const v = Object.create(PiAgentView.prototype);
  const tab = { id: "one", client, engine: client?.engine || "pi", isStreaming: false };
  Object.assign(v, { tabs: [tab], activeTabId: tab.id, client, tabStarts: new Map(),
    viewClosed: false, tabSwitchSeq: 0, historyLoadSeq: 0, streamRenderVersions: new WeakMap(),
    modelPopupSeq: 0, effortPopupSeq: 0, effortPopupPending: false,
    plugin: { settings: { language: "en", maxHistoryDisplay: 0, streamingRenderMode: "auto" } },
    renderedMessages: [], chatContainer: new Element(), renderTimeout: null, lastRenderTime: 0 });
  v.chatContainer.connected = true;
  v.captureBottomFollow = () => () => {};
  v.normalizeAssistantMarkdown = text => text;
  v.setStatus = () => {};
  v.applyTabRuntimePreferences = async () => {};
  v.loadAvailableCommands = async () => {};
  v.renderEmptyState = () => {};
  v.renderHistoryBanner = () => {};
  v.scrollToBottom = () => {};
  v.renderMessageFromHistory = msg => v.renderedMessages.push(msg);
  return { v, tab };
}
function fakeClient(gate = null) {
  const c = new EventEmitter();
  c.engine = "pi"; c.starts = 0; c.destroys = 0; c.running = false;
  c.isRunning = () => c.running;
  c.start = async () => { c.starts++; if (gate) await gate.promise; c.running = true; };
  c.destroy = async () => { c.destroys++; c.running = false; };
  return c;
}

test("same tab shares startup, and removed tabs dispose delayed clients", async () => {
  const gate = deferred(), client = fakeClient(gate), { v, tab } = view();
  let created = 0;
  v.createClient = () => { created++; return client; };
  const a = v.ensureTabClient(tab), b = v.ensureTabClient(tab);
  await tick();
  assert.equal(created, 1); assert.equal(client.starts, 1);
  v.tabs = [];
  gate.resolve(); await Promise.all([a, b]);
  assert.equal(client.destroys, 1); assert.equal(v.tabStarts.size, 0);
  v.recordTabRuntimeState = () => assert.fail("orphan callback reached view");
  client.emit("event", { type: "agent_start" });
});

test("failed startup is cleaned up and can be retried", async () => {
  const { v, tab } = view(), failed = fakeClient(), replacement = fakeClient();
  failed.start = async () => { throw new Error("failed"); };
  let created = 0; v.createClient = () => ++created === 1 ? failed : replacement;
  await assert.rejects(v.ensureTabClient(tab, { requireSessionRestore: true }), /failed/);
  assert.equal(tab.client, null); assert.equal(failed.destroys, 1);
  await v.ensureTabClient(tab);
  assert.equal(tab.client, replacement); assert.equal(created, 2);
});

test("failed history preserves visible replies; successful empty history replaces them", async () => {
  for (const engine of ["pi", "antigravity"]) {
    const client = { engine, getMessages: async () => ({ success: false }) };
    const { v } = view(client); const reply = v.chatContainer.createDiv();
    v.renderedMessages = ["existing"]; v.activeBranchHistory = ["branch"];
    await v.reloadMessagesFromClient();
    assert.deepEqual(v.renderedMessages, ["existing"]);
    assert.ok(v.chatContainer.contains(reply));
    assert.deepEqual(v.activeBranchHistory, ["branch"]);
    client.getMessages = async () => ({ success: true, data: { messages: [] } });
    await v.reloadMessagesFromClient();
    assert.deepEqual(v.renderedMessages, []); assert.equal(v.chatContainer.contains(reply), false);
  }
});

test("failed branch RPC is not treated as authoritative empty history", async () => {
  const client = { engine: "pi", getEntries: async () => ({ success: false }),
    getMessages: async () => ({ success: false }) };
  const { v } = view(client); v.renderedMessages = ["existing"];
  await v.reloadMessagesFromClient({ forceRpc: true });
  assert.deepEqual(v.renderedMessages, ["existing"]);
});

test("history snapshot does not erase a turn that started while loading", async () => {
  const gate = deferred(), client = { engine: "pi", getMessages: () => gate.promise };
  const { v, tab } = view(client); v.renderedMessages = ["live reply"];
  const loading = v.reloadMessagesFromClient(); tab.isStreaming = true;
  gate.resolve({ success: true, data: { messages: ["old snapshot"] } }); await loading;
  assert.deepEqual(v.renderedMessages, ["live reply"]);
});

test("valid branch history retains authoritative empty-branch semantics", async () => {
  const client = { engine: "pi", getEntries: async () => ({ success: true,
    data: { entries: [], leafId: null } }),
    getMessages: async () => assert.fail("empty branch must not fall back") };
  const { v } = view(client); v.buildActiveBranchHistory = () => ({ messages: [], activeEntryCount: 0 });
  v.renderedMessages = ["old branch"];
  await v.reloadMessagesFromClient({ forceRpc: true });
  assert.deepEqual(v.renderedMessages, []);
});

test("current Markdown preview commits normally before fast streaming resumes", async () => {
  const { v } = view(), block = v.chatContainer.createDiv(); v.currentTextBlock = block;
  markdownRender = async (_app, _raw, target) => target.createDiv().setText("preview");
  v.renderMarkdownWithCursor("first\n", block); await tick();
  assert.equal(block.children[0].textContent, "preview");
  v.convertCurrentTextBlockToFastStreaming(); v.lastRenderTime = 0;
  v.appendStreamingDelta("first\nnext", "next");
  assert.ok(block.contains(v.streamingTextEl));
  assert.equal(v.streamingTextEl.textContent, "first\nnext");
});

test("late history cannot overwrite newer loads or a different tab", async () => {
  const old = deferred(); const client = { engine: "pi", getMessages: () => old.promise };
  const { v } = view(client);
  const first = v.reloadMessagesFromClient();
  client.getMessages = async () => ({ success: true, data: { messages: ["new"] } });
  await v.reloadMessagesFromClient();
  old.resolve({ success: true, data: { messages: ["old"] } }); await first;
  assert.deepEqual(v.renderedMessages, ["new"]);
  const late = deferred(); client.getMessages = () => late.promise;
  const second = v.reloadMessagesFromClient(); v.activeTabId = "other";
  late.resolve({ success: true, data: { messages: ["wrong tab"] } }); await second;
  assert.deepEqual(v.renderedMessages, ["new"]);
});

test("newline promotion followed by text keeps attached nodes and rejects stale Markdown", async () => {
  const { v } = view(), block = v.chatContainer.createDiv();
  v.currentTextBlock = block; v.convertCurrentTextBlockToFastStreaming();
  const render = deferred(); let staging;
  markdownRender = async (_app, _raw, target) => { staging = target; await render.promise;
    target.createDiv().setText("old preview"); };
  block.setAttribute("data-stream-raw", "first\n");
  v.appendStreamingDelta("first\n", "\n");
  assert.equal(block.classList.contains("pi-agent-streaming-block"), false);
  v.convertCurrentTextBlockToFastStreaming();
  v.lastRenderTime = 0;
  v.appendStreamingDelta("first\nnext", "next");
  assert.equal(v.streamingTextEl.textContent, "first\nnext");
  assert.ok(block.contains(v.streamingTextEl)); assert.notEqual(staging, block);
  render.resolve(); await tick();
  assert.ok(block.contains(v.streamingTextEl));
  assert.equal(v.streamingTextEl.textContent, "first\nnext");
});

test("finalization invalidates pending preview, including after tab reset", async () => {
  for (const reset of [false, true]) {
    const { v } = view(), block = v.chatContainer.createDiv(), gate = deferred();
    markdownRender = async (_app, _raw, target) => { await gate.promise;
      target.createDiv().setText("stale"); };
    v.renderMarkdownWithCursor("partial", block);
    if (reset) v.resetActiveRenderState(); else v.invalidateStreamRender(block);
    const final = block.createDiv(); final.setText("final");
    gate.resolve(); await tick(); assert.ok(block.contains(final));
  }
});

test("closed or switched model popup ignores late results and delayed listeners", async () => {
  const gate = deferred(), client = { engine: "pi", getAvailableModels: () => gate.promise };
  const { v } = view(client); v.getModelsCacheForEngine = () => [];
  v.setModelsCacheForEngine = () => assert.fail("stale cache write");
  v.renderModelPopup = () => assert.fail("closed popup reopened");
  const anchor = v.chatContainer.createDiv();
  const task = v.toggleModelPopup(anchor); v.closeModelPopup();
  gate.resolve({ success: true, data: { models: [{ id: "model" }] } }); await task;
  await tick(); assert.equal(v.modelPopupEl, null);
});

test("repeated effort clicks cancel pending open; changing tab prevents reopening", async () => {
  for (const switchTab of [false, true]) {
    const { v } = view({ engine: "pi" }), gate = deferred();
    v.syncTabStateFromPi = () => gate.promise;
    v.renderEffortPopup = () => assert.fail("stale effort popup opened");
    const anchor = v.chatContainer.createDiv();
    const first = v.toggleEffortPopup(anchor);
    if (switchTab) v.activeTabId = "other";
    else await v.toggleEffortPopup(anchor);
    gate.resolve(); await first; assert.equal(v.effortPopupPending, false);
  }
});

test("actual text_delta event path resumes visible output after newline promotion", async () => {
  for (const mode of ["auto", "fast", "pretty"]) {
    const { v } = view(); v.plugin.settings.streamingRenderMode = mode;
    v.addSpeedDelta = () => {};
    v.currentRawText = ""; v.currentBlockRawText = "";
    v.currentAssistantMsg = { el: v.chatContainer.createDiv(), contentEl: v.chatContainer.createDiv() };
    markdownRender = async (_app, raw, target) => target.createDiv().setText(raw);
    const emit = delta => v.handleMessageUpdate({ assistantMessageEvent: { type: "text_delta", delta } });
    emit("# 标题\n"); await tick();
    v.lastRenderTime = 0;
    emit("换行后的文字"); await tick();
    assert.equal(v.currentBlockRawText, "# 标题\n换行后的文字");
    if (mode !== "pretty") {
      assert.ok(v.currentTextBlock.contains(v.streamingTextEl));
      assert.equal(v.streamingTextEl.textContent, v.currentBlockRawText);
    } else {
      assert.match(v.currentTextBlock.children[0].textContent, /换行后的文字/);
    }
    v.resetActiveRenderState();
  }
});

test("code-fence deltas remain visible without premature Markdown promotion", () => {
  const { v } = view(); v.addSpeedDelta = () => {};
  v.currentRawText = ""; v.currentBlockRawText = "";
  v.currentAssistantMsg = { el: v.chatContainer.createDiv(), contentEl: v.chatContainer.createDiv() };
  markdownRender = () => assert.fail("open fence must not promote");
  for (const delta of ["```js\n", "const value = 1;\n", "console.log(value)"]) {
    v.lastRenderTime = 0;
    v.handleMessageUpdate({ assistantMessageEvent: { type: "text_delta", delta } });
    assert.ok(v.currentTextBlock.contains(v.streamingTextEl));
    assert.equal(v.streamingTextEl.textContent, v.currentBlockRawText);
  }
  v.resetActiveRenderState();
});

test("preview failure preserves text and later deltas still render", async () => {
  const { v } = view(); v.addSpeedDelta = () => {};
  v.currentRawText = ""; v.currentBlockRawText = "";
  v.currentAssistantMsg = { el: v.chatContainer.createDiv(), contentEl: v.chatContainer.createDiv() };
  markdownRender = async () => { throw new Error("renderer failure"); };
  v.handleMessageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "first\n" } });
  await tick();
  assert.equal(v.streamingTextEl.textContent, "first\n");
  v.lastRenderTime = 0;
  v.handleMessageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "next" } });
  assert.equal(v.streamingTextEl.textContent, "first\nnext");
  v.resetActiveRenderState();
});

test("100 overlapping startup requests still create one client", async () => {
  const gate = deferred(), c = fakeClient(gate), { v, tab } = view();
  let created = 0; v.createClient = () => { created++; return c; };
  const tasks = Array.from({ length: 100 }, () => v.ensureTabClient(tab));
  await tick(); assert.equal(created, 1);
  gate.resolve(); await Promise.all(tasks);
  assert.equal(c.starts, 1); assert.equal(v.tabStarts.size, 0);
});

test("20 overlapping history requests commit only the newest snapshot", async () => {
  const gates = Array.from({ length: 20 }, deferred); let index = 0;
  const { v } = view({ engine: "pi", getMessages: () => gates[index++].promise });
  const tasks = gates.map(() => v.reloadMessagesFromClient());
  for (let i = gates.length - 1; i >= 0; i--) {
    gates[i].resolve({ success: true, data: { messages: [`snapshot ${i}`] } });
    await tasks[i];
  }
  assert.deepEqual(v.renderedMessages, ["snapshot 19"]);
});

test("closing the view during startup disposes the client without reporting Ready", async () => {
  const gate = deferred(), c = fakeClient(gate), { v, tab } = view();
  v.createClient = () => c;
  const status = []; v.setStatus = text => status.push(text);
  const task = v.ensureTabClient(tab); await tick(); v.viewClosed = true;
  gate.resolve(); await task;
  assert.equal(c.destroys, 1); assert.equal(status.includes("Ready"), false);
});

test("view close cleans every client even if session saving and one destroy fail", async () => {
  const { v, tab } = view(); const calls = [];
  tab.client = { destroy: async () => { calls.push("first"); throw new Error("failed"); } };
  v.tabs.push({ id: "two", client: { destroy: async () => { calls.push("second"); } } });
  v.persistSessionTabs = async () => { throw new Error("save failed"); };
  const original = console.warn; console.warn = () => {};
  try { await v.onClose(); } finally { console.warn = original; }
  assert.deepEqual(calls.sort(), ["first", "second"]);
  assert.equal(v.client, null); assert.ok(v.tabs.every(t => t.client === null));
  assert.equal(v.viewClosed, true);
});
