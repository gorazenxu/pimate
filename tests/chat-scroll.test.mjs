import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({ entryPoints: [`${root}ChatScrollFollower.ts`], bundle: true, write: false, platform: "node", format: "cjs" });
const compiled = new Module(`${root}scroll-test.cjs`);
compiled._compile(bundle.outputFiles[0].text, `${root}scroll-test.cjs`);
const { ChatScrollFollower } = compiled.exports;

class Viewport extends EventTarget {
  scrollHeight = 1000;
  clientHeight = 400;
  top = 600;
  get scrollTop() { return this.top; }
  set scrollTop(value) { this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
  userScroll(top) { this.scrollTop = top; this.dispatchEvent(new Event("scroll")); }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("successive tool rows follow even when new content grows by more than the threshold", t => {
  const el = new Viewport(), follower = new ChatScrollFollower(el, () => true);
  t.after(() => follower.dispose());
  for (let i = 0; i < 20; i++) {
    const follow = follower.capture();
    el.scrollHeight += 120;
    follow();
    assert.equal(el.scrollTop, el.scrollHeight - el.clientHeight);
  }
});

test("reading earlier messages pauses follow; returning to bottom resumes it", t => {
  const el = new Viewport(), follower = new ChatScrollFollower(el, () => true);
  t.after(() => follower.dispose());
  el.userScroll(100);
  const paused = follower.capture();
  el.scrollHeight += 200;
  paused();
  assert.equal(el.scrollTop, 100);
  el.userScroll(800);
  const resumed = follower.capture();
  el.scrollHeight += 200;
  resumed();
  assert.equal(el.scrollTop, 1000);
});

test("upward scroll cancels pending compensation and asynchronous Markdown follow", async t => {
  const el = new Viewport(), follower = new ChatScrollFollower(el, () => true);
  t.after(() => follower.dispose());
  const markdownFinished = follower.capture();
  follower.scroll(true, true);
  el.userScroll(150);
  el.scrollHeight += 600;
  markdownFinished();
  await delay(180);
  assert.equal(el.scrollTop, 150);
});

test("upward wheel intent cancels follow even before a scroll event", async t => {
  const el = new Viewport(), follower = new ChatScrollFollower(el, () => true);
  t.after(() => follower.dispose());
  follower.scroll(true, true);
  const wheel = new Event("wheel");
  Object.defineProperty(wheel, "deltaY", { value: -20 });
  el.dispatchEvent(wheel);
  el.scrollHeight += 300;
  await delay(180);
  assert.equal(el.scrollTop, 600);
});

test("delayed layout growth follows without interpreting growth as user scrolling", async t => {
  const el = new Viewport(), follower = new ChatScrollFollower(el, () => true);
  t.after(() => follower.dispose());
  follower.scroll(true, true);
  el.scrollHeight += 500;
  await delay(180);
  assert.equal(el.scrollTop, 1100);
});

test("disabled auto-scroll and disposed views ignore pending work", async () => {
  const el = new Viewport();
  let enabled = false;
  const follower = new ChatScrollFollower(el, () => enabled);
  const follow = follower.capture();
  el.scrollHeight += 200;
  follow();
  follower.scroll(true, true);
  assert.equal(el.scrollTop, 600);
  enabled = true;
  follower.scroll(true, true);
  follower.dispose();
  el.scrollHeight += 300;
  await delay(180);
  assert.equal(el.scrollTop, 800);
});
