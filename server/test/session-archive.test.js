const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

const serverDir = path.resolve(__dirname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function startServer({ port, dataDir, token }) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: serverDir,
    env: { ...process.env, PORT:String(port), CINEISLE_DATA_DIR:dataDir, CINEISLE_TOKEN:token },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return child;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  child.kill("SIGKILL");
  throw new Error(`server did not become ready: ${logs}`);
}

function stopServer(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2000).unref();
  });
}

async function api(base, route, token, options = {}) {
  const response = await fetch(base + route, {
    ...options,
    headers: {
      Authorization:`Bearer ${token}`,
      ...(options.body ? { "Content-Type":"application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body, text };
}

test("archives a complete viewing session, protects export, and restores after restart", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cineisle-archive-"));
  const token = "test-secret-token";
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child = await startServer({ port, dataDir, token });
  t.after(async () => {
    await stopServer(child);
    fs.rmSync(dataDir, { recursive:true, force:true });
  });

  const created = await api(base, "/api/rooms", token, {
    method:"POST",
    body:JSON.stringify({ title:"第五集", partner:"明", assistantName:"澈", mood:"夜航" })
  });
  assert.equal(created.response.status, 200);
  const room = created.body.room.id;

  const roomDenied = await fetch(`${base}/api/rooms/${room}`);
  assert.equal(roomDenied.status, 403);

  await api(base, `/api/rooms/${room}/playback`, token, {
    method:"POST",
    body:JSON.stringify({ currentTime:93, duration:3600, paused:false, fileName:"episode-05.mp4", actor:"明" })
  });
  await api(base, `/api/rooms/${room}/message`, token, {
    method:"POST",
    body:JSON.stringify({ name:"明", text:"这一幕我记得", danmaku:false })
  });
  await api(base, `/api/rooms/${room}/message`, token, {
    method:"POST",
    body:JSON.stringify({ name:"澈", text:"看到了", danmaku:true })
  });
  await api(base, `/api/rooms/${room}/note`, token, {
    method:"POST",
    body:JSON.stringify({ name:"明", text:"留意门后的声音", time:95 })
  });
  await api(base, `/api/rooms/${room}/card`, token, {
    method:"POST",
    body:JSON.stringify({ title:"第五集", quote:"喜欢的台词", note:"一起看完啦", rating:4.5, template:"ticket" })
  });

  const denied = await fetch(`${base}/api/rooms/${room}/export.md`);
  assert.equal(denied.status, 403);

  const exported = await api(base, `/api/rooms/${room}/export.md`, token);
  assert.equal(exported.response.status, 200);
  assert.match(exported.response.headers.get("content-type"), /^text\/markdown/);
  assert.match(exported.text, /明 · 聊天/);
  assert.match(exported.text, /澈 · 弹幕/);
  assert.match(exported.text, /\[1:33\]/);
  assert.match(exported.text, /留意门后的声音/);
  assert.match(exported.text, /一起看完啦/);
  assert.match(exported.text, /播放记录/);

  const mcpExport = await api(base, "/mcp", token, {
    method:"POST",
    body:JSON.stringify({ jsonrpc:"2.0", id:1, method:"tools/call", params:{ name:"export_room_markdown", arguments:{ room } } })
  });
  assert.equal(mcpExport.response.status, 200);
  assert.match(mcpExport.body.result.content[0].text, /这一幕我记得/);

  const archivePath = path.join(dataDir, `${room}.json`);
  const markdownArchivePath = path.join(dataDir, `${room}.md`);
  assert.equal(fs.existsSync(archivePath), true);
  assert.equal(fs.existsSync(markdownArchivePath), true);
  const archiveText = fs.readFileSync(archivePath, "utf8");
  const markdownArchiveText = fs.readFileSync(markdownArchivePath, "utf8");
  assert.doesNotMatch(archiveText, /test-secret-token/);
  assert.doesNotMatch(archiveText, /data:image\//);
  assert.match(markdownArchiveText, /明 · 聊天/);
  assert.match(markdownArchiveText, /澈 · 弹幕/);
  assert.match(markdownArchiveText, /留意门后的声音/);
  assert.match(markdownArchiveText, /一起看完啦/);

  await stopServer(child);
  child = await startServer({ port, dataDir, token });
  const restored = await api(base, `/api/rooms/${room}`, token);
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.room.title, "第五集");
  assert.equal(restored.body.room.messages.length, 2);
  assert.equal(restored.body.room.notes.length, 1);
  assert.equal(restored.body.room.card.note, "一起看完啦");
  assert.equal(restored.body.room.currentTime, 93);
  assert.ok(restored.body.room.playbackHistory.length >= 1);
});
