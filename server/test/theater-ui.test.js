const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const publicDir = path.resolve(__dirname, "..", "public");
const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
const css = fs.readFileSync(path.join(publicDir, "app.css"), "utf8");
const js = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
const sw = fs.readFileSync(path.join(publicDir, "sw.js"), "utf8");

test("ships the theater layout controls and responsive states", () => {
  for (const id of ["theaterModeBtn", "layoutResizer", "collapseSideBtn", "chatRailBtn", "railUnreadBadge", "chatPeek"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "g")) || []).length, 1);
  }
  assert.match(css, /body\.theater-mode/);
  assert.match(css, /body\.theater-mode\.side-collapsed/);
  assert.match(css, /@media \(max-width: 860px\)/);
  assert.match(js, /function toggleTheaterMode\(/);
  assert.match(js, /function bindLayoutResizer\(/);
});

test("keeps chat readable while collapsed and protects Chinese composition", () => {
  assert.match(js, /function showChatPeek\(/);
  assert.match(js, /state\.chatUnread/);
  assert.match(js, /!e\.isComposing/);
  assert.match(js, /有 \$\{count\} 条新消息/);
});

test("uses a fresh network-first PWA cache", () => {
  assert.match(sw, /cineisle-pwa-v0\.5\.0-mingche-theater/);
  const fetchIndex = sw.indexOf("fetch(event.request)");
  const cacheIndex = sw.indexOf("caches.match(event.request)");
  assert.ok(fetchIndex >= 0 && cacheIndex > fetchIndex);
});
