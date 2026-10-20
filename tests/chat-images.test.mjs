import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = process.env.PIMATE_TEST_BASELINE === "1"
  ? execFileSync("git", ["show", "HEAD:PiAgentView.ts"], { cwd: root, encoding: "utf8" })
  : 'export * from "./PiAgentView";';
const bundle = await build({
  stdin: { contents: source + '\nexport * from "./PimateMessageImages";', resolveDir: root, loader: "ts" },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["obsidian"],
});
class Base {}
const obsidian = { ItemView: Base, Modal: Base, SuggestModal: Base,
  Notice: class { constructor(text) { assert.fail(`Unexpected notice: ${text}`); } },
  MarkdownRenderer: { render: async () => {} }, setIcon: () => {} };
const compiled = new Module(`${root}chat-images-test.cjs`);
compiled.filename = `${root}chat-images-test.cjs`;
compiled.paths = Module._nodeModulePaths(root);
const originalRequire = compiled.require.bind(compiled);
compiled.require = name => name === "obsidian" ? obsidian : originalRequire(name);
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { PiAgentView, getMessageImages, stripPiImageDimensionNotes } = compiled.exports;
globalThis.window = globalThis;

// Small DOM double. Tests call the real addMessage, live-event and history
// rendering paths, not a source-string assertion or an attachment stub.
class Element {
  constructor(tag = "div") { this.tag = tag; }
  children = []; parentElement = null; attrs = new Map(); classes = new Set(); ownText = "";
  scrollTop = 0; scrollHeight = 100;
  classList = { contains: name => this.classes.has(name),
    add: (...names) => names.forEach(name => this.classes.add(name)),
    remove: (...names) => names.forEach(name => this.classes.delete(name)) };
  addClass(name) { this.classList.add(name); }
  removeClass(name) { this.classList.remove(name); }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(""); }
  set textContent(text) { this.empty(); this.ownText = text; }
  get nextElementSibling() {
    const siblings = this.parentElement?.children || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  append(child) { child.remove(); child.parentElement = this; this.children.push(child); }
  insertBefore(child, anchor) {
    if (child === anchor) return;
    child.remove(); const index = this.children.indexOf(anchor);
    child.parentElement = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
  }
  createEl(tag, options = {}) {
    const child = new Element(tag);
    const cls = typeof options === "string" ? options : options.cls;
    if (cls) child.classList.add(...cls.split(" "));
    if (options.text) child.ownText = options.text;
    for (const [name, value] of Object.entries(options.attr || {})) child.setAttribute(name, value);
    this.append(child); return child;
  }
  createDiv(options) { return this.createEl("div", options); }
  createSpan(options) { return this.createEl("span", options); }
  setText(text) { this.textContent = text; }
  setAttribute(name, value) { this.attrs.set(name, value); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  empty() { for (const child of [...this.children]) child.remove(); this.ownText = ""; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(selector.startsWith(".") ? child.classes.has(selector.slice(1)) : child.tag === selector) ? [child] : [],
      ...child.querySelectorAll(selector),
    ]);
  }
}

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=";
const note = "[Image: original 1080x2392, displayed at 903x2000. Multiply coordinates by 1.20 to map to original image.]";
const image = { type: "image", data: png, mimeType: "image/png" };
const message = (text = "Check this", images = [image]) => ({ role: "user",
  content: [{ type: "text", text: `${text}\n\n${images.map(() => note).join("\n")}` }, ...images] });

function view(client = { engine: "pi" }) {
  const v = Object.create(PiAgentView.prototype);
  const tab = { id: "images", engine: client.engine, client, isStreaming: false };
  Object.assign(v, { tabs: [tab], activeTabId: tab.id, client, tabSwitchSeq: 0,
    viewClosed: false, historyLoadSeq: 0, renderedMessages: [], pendingQueuedMessages: [],
    activeBranchHistory: null, forkMessagesByEntryId: new Map(), chatContainer: new Element(),
    streamRenderVersions: new WeakMap(),
    plugin: { settings: { language: "en", maxHistoryDisplay: 100 } } });
  v.clearEmptyState = () => {};
  v.captureBottomFollow = () => () => {};
  v.scrollToBottom = () => {};
  v.renderEmptyState = () => {};
  v.renderHistoryBanner = () => {};
  v.updateButtons = () => {};
  return { v, tab };
}
function assertPreview(rendered, count, text) {
  const rows = rendered.el.querySelectorAll(".pi-agent-message-attachments");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].querySelectorAll("img").length, count);
  assert.equal(rendered.el.children.indexOf(rows[0]) < rendered.el.children.indexOf(rendered.contentEl), true);
  for (const img of rows[0].querySelectorAll("img")) {
    assert.equal(img.getAttribute("src"), `data:image/png;base64,${png}`);
    assert.equal(img.getAttribute("loading"), "lazy");
  }
  assert.equal(rendered.contentEl.textContent, text);
  assert.equal(rendered.contentEl.textContent.includes("Multiply coordinates"), false);
}

test("image parsing accepts native raster payloads without trusting URLs, paths or SVG", () => {
  const content = [null, image, { ...image, data: "https://example.test/image.png" },
    { ...image, mimeType: "image/svg+xml" }, { ...image, data: "a" }, { ...image, data: "a=" },
    { type: "image", data: "", mimeType: "image/png" },
    { type: "text", text: "file:///private/example.png" }, { ...image, mimeType: "text/html" }];
  const before = JSON.stringify(content);
  assert.deepEqual(getMessageImages(content), [{ data: png, mimeType: "image/png" }]);
  assert.deepEqual(getMessageImages("not image blocks"), []);
  assert.equal(JSON.stringify(content), before);
});

test("only image-backed trailing Pi resize hints are hidden; failures and literal examples survive", () => {
  assert.equal(stripPiImageDimensionNotes(`Check\n\n${note}`, 1), "Check");
  assert.equal(stripPiImageDimensionNotes(`Check\n\n${note}\n${note}`, 2), "Check");
  assert.equal(stripPiImageDimensionNotes(note, 0), note);
  assert.equal(stripPiImageDimensionNotes(`Quote: ${note}\nKeep this`, 1), `Quote: ${note}\nKeep this`);
  assert.equal(stripPiImageDimensionNotes(`\`\`\`text\n${note}`, 1), `\`\`\`text\n${note}`);
  assert.equal(stripPiImageDimensionNotes(`~~~text\n${note}`, 1), `~~~text\n${note}`);
  const omitted = "[Image omitted: could not be resized below the inline image size limit.]";
  assert.equal(stripPiImageDimensionNotes(omitted, 1), omitted);
});

test("live Pi echo uses native images even without pending originals and keeps RPC content untouched", () => {
  const { v, tab } = view(); const payload = message("我给你的图你再看看");
  const before = JSON.stringify(payload);
  v.handleMessageStart({ type: "message_start", message: payload }, tab);
  assertPreview(v.renderedMessages[0], 1, "我给你的图你再看看");
  assert.equal(JSON.stringify(payload), before);
  assert.deepEqual(tab.pendingUserImages, []);
});

test("history restores multiple images and image-only messages without mutating the transcript", () => {
  for (const text of ["Compare these", ""]) {
    const { v } = view(); const payload = message(text, [image, image]);
    const before = JSON.stringify(payload);
    v.renderMessageFromHistory(payload);
    assertPreview(v.renderedMessages[0], 2, text);
    assert.equal(JSON.stringify(payload), before);
  }
});

test("queued image echo reuses its existing bubble and attachment row exactly once", () => {
  const { v, tab } = view(); const payload = message();
  v.addOptimisticQueuedMessage("Check this", "Check this", [{ data: png, mimeType: "image/png" }]);
  const rendered = v.renderedMessages[0];
  const row = rendered.el.querySelectorAll(".pi-agent-message-attachments")[0];
  v.handleMessageStart({ type: "message_start", message: payload }, tab);
  assert.equal(v.renderedMessages.length, 1);
  assert.equal(v.renderedMessages[0], rendered);
  assert.equal(v.pendingQueuedMessages.length, 0);
  assert.equal(rendered.el.classList.contains("is-queued"), false);
  assert.equal(rendered.el.querySelectorAll(".pi-agent-message-attachments")[0], row);
  assertPreview(rendered, 1, "Check this");
  assert.equal(rendered.el.getAttribute("data-rpc-message"), payload.content[0].text);
});

test("legacy Pi text echoes and AGY text echoes retain pending image previews", () => {
  for (const engine of ["pi", "antigravity"]) {
    const { v, tab } = view({ engine });
    tab.pendingUserImages = [{ data: png, mimeType: "image/png" }];
    v.handleMessageStart({ type: "message_start", message: { role: "user", content: "Check this" } }, tab);
    assertPreview(v.renderedMessages[0], 1, "Check this");
    assert.deepEqual(tab.pendingUserImages, []);
  }
});

test("text-only history keeps resize-looking text when there is no recoverable image", () => {
  const { v } = view();
  v.renderMessageFromHistory({ role: "user", content: `Example ${note}` });
  assert.equal(v.renderedMessages[0].el.querySelectorAll("img").length, 0);
  assert.equal(v.renderedMessages[0].contentEl.textContent, `Example ${note}`);
});

test("reply-settled reload and repeated RPC history loads retain thumbnails without duplicates", async () => {
  const payload = message();
  const client = { engine: "pi", getMessages: async () => ({ success: true, data: { messages: [payload] } }) };
  const { v, tab } = view(client);
  v.handleMessageStart({ type: "message_start", message: payload }, tab);
  v.refreshStateDisplay = async () => {};
  v.refreshForkMessages = async () => {};
  v.forkScopeVersion = 1;
  await v.refreshForkMessagesAndReloadHistory();
  await v.reloadMessagesFromClient();
  assert.equal(v.renderedMessages.length, 1);
  assert.equal(v.chatContainer.querySelectorAll("img").length, 1);
  assertPreview(v.renderedMessages[0], 1, "Check this");
});

test("JSONL and active-branch RPC history both restore image thumbnails", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pimate-image-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const payload = message();
  const sessionFile = join(dir, "synthetic.jsonl");
  await writeFile(sessionFile, JSON.stringify({ type: "message", id: "image-entry", message: payload }) + "\n");
  const { v, tab } = view({ engine: "pi", getEntries: async () => ({ success: true,
    data: { entries: [{ type: "message", id: "image-entry", message: payload }], leafId: "image-entry" } }) });
  tab.sessionFile = sessionFile;
  await v.reloadMessagesFromClient();
  assertPreview(v.renderedMessages[0], 1, "Check this");
  await v.reloadMessagesFromClient({ forceRpc: true });
  assert.equal(v.renderedMessages.length, 1);
  assertPreview(v.renderedMessages[0], 1, "Check this");
});

test("loading earlier history restores image cards in the older messages", async () => {
  const { v } = view(); const earlier = message("Earlier image"), later = { role: "user", content: "Later" };
  v.activeBranchHistory = [earlier, later];
  v.historyShownCount = 1;
  v.historyTotalCount = 2;
  v.historyBannerEl = v.chatContainer.createDiv();
  v.renderMessageFromHistory(later);
  await v.loadMoreHistory(1);
  assert.equal(v.renderedMessages.length, 2);
  assertPreview(v.renderedMessages[0], 1, "Earlier image");
  assert.equal(v.historyShownCount, 2);
});
