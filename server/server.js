const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 8787;
const TOKEN = process.env.CINEISLE_TOKEN || process.env.LINJIAN_CINEMA_TOKEN || "";
const APP_VERSION = "0.4.7-session-archive";
const DATA_DIR = path.resolve(process.env.CINEISLE_DATA_DIR || path.join(__dirname, "data"));

app.use(cors());
app.use(express.json({ limit: "6mb" }));
app.use(express.static("public"));

const rooms = new Map();
const roomEventStates = new Map();
const ROOM_ID_RE = /^[A-Z0-9_-]{1,64}$/;

function normalizeRoomId(value) {
  const id = String(value || "").trim().toUpperCase();
  if (!ROOM_ID_RE.test(id)) throw new Error("ROOM_INVALID");
  return id;
}

function blankContext() {
  return {
    currentSubtitle:"", recentSubtitles:[], subtitleUpdatedAt:null,
    latestFrame:null, frameHistory:[], frameUpdatedAt:null, frameSource:"",
    screenshotRequestId:null, screenshotRequestedAt:null,
    actor:"", observedAt:null,
    playbackDebug:{events:[], range:null, lastError:"", updatedAt:null}
  };
}

function newRoom(id) {
  const createdAt = now();
  return {
    id, sessionId: crypto.randomUUID(), sessionStartedAt: createdAt,
    createdAt, updatedAt: createdAt, title:"未命名影片", fileName:"",
    duration:0, currentTime:0, paused:true, lastActor:"", assistantName:"观影助手", members:[],
    messages:[], notes:[], card:null, playbackHistory:[], theme:"cream", partner:"观影人 A × 观影人 B", mood:"夜航", inviteNote:"今晚一起登岛看一场电影。",
    context: blankContext()
  };
}

function eventState(roomId) {
  const id = String(roomId || "").toUpperCase();
  if (!roomEventStates.has(id)) {
    roomEventStates.set(id, { seq: 0, events: [], waiters: new Set() });
  }
  return roomEventStates.get(id);
}

function roomEvent(r, type, data = {}) {
  if (!r || !r.id) return null;
  const state = eventState(r.id);
  const event = { seq: ++state.seq, type, at: now(), data };
  state.events.push(event);
  while (state.events.length > 200) state.events.shift();
  for (const wake of Array.from(state.waiters)) wake();
  persistRoom(r);
  return event;
}

function code() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random()*chars.length)]).join("");
}
function now(){ return new Date().toISOString(); }
function cleanAssistantName(v) {
  v = String(v || "").trim().slice(0,80);
  return v || "观影助手";
}
function applyAssistantName(r, source) {
  if (source && Object.prototype.hasOwnProperty.call(source, "assistantName")) {
    r.assistantName = cleanAssistantName(source.assistantName);
  }
  return r.assistantName || "观影助手";
}
function defaultAssistant(r) {
  return cleanAssistantName(r && r.assistantName);
}
function ensure(id) {
  id = normalizeRoomId(id);
  if (!rooms.has(id)) rooms.set(id, newRoom(id));
  return rooms.get(id);
}
function publicBaseUrl(req) {
  const envUrl = process.env.CINEISLE_PUBLIC_URL || process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
  if (envUrl) return String(envUrl).replace(/\/+$/, "");
  if (!req) return "";
  const proto = req.get && (req.get("x-forwarded-proto") || req.protocol || "https");
  const host = req.get && req.get("host");
  return host ? `${proto}://${host}` : "";
}
function safeText(v, max = 1200) {
  return String(v || "").replace(/[​-‍﻿]/g, "").trim().slice(0, max);
}
function cleanStoredMessage(input) {
  if (!input || typeof input !== "object") return null;
  const text = safeText(input.text, 500);
  if (!text) return null;
  return {
    id: safeText(input.id, 100) || crypto.randomUUID(),
    name: safeText(input.name, 80) || "观影人",
    text,
    danmaku: input.danmaku === true || text.startsWith("弹幕："),
    time: Math.max(0, Number(input.time || 0)),
    at: safeText(input.at, 80) || now()
  };
}
function cleanStoredNote(input) {
  if (!input || typeof input !== "object") return null;
  const text = safeText(input.text, 800);
  if (!text) return null;
  return {
    id: safeText(input.id, 100) || crypto.randomUUID(),
    name: safeText(input.name, 80) || "观影人",
    text,
    type: safeText(input.type, 40) || "note",
    time: Math.max(0, Number(input.time || 0)),
    at: safeText(input.at, 80) || now()
  };
}
function cleanStoredCard(input, fallbackTitle) {
  if (!input || typeof input !== "object") return null;
  const rating = Number(input.rating || 0);
  return {
    title: safeText(input.title, 120) || fallbackTitle || "未命名影片",
    rating: Number.isFinite(rating) ? Math.min(5, Math.max(0, rating)) : 4.5,
    template: ["ticket", "receipt", "postcard"].includes(input.template) ? input.template : "ticket",
    partner: safeText(input.partner, 100),
    mood: safeText(input.mood, 100),
    inviteNote: safeText(input.inviteNote, 300),
    quote: safeText(input.quote, 800),
    note: safeText(input.note, 1600),
    zhiQuote: safeText(input.zhiQuote, 800),
    linQuote: safeText(input.linQuote, 800),
    zhiNote: safeText(input.zhiNote, 1600),
    linNote: safeText(input.linNote, 1600),
    generatedAt: safeText(input.generatedAt, 80) || now()
  };
}
function cleanPlaybackHistory(input) {
  if (!input || typeof input !== "object") return null;
  const currentTime = Number(input.currentTime || 0);
  return {
    id: safeText(input.id, 100) || crypto.randomUUID(),
    event: safeText(input.event, 40) || "progress",
    actor: safeText(input.actor, 80) || "观影人",
    currentTime: Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0,
    paused: input.paused !== false,
    fileName: safeText(input.fileName, 180),
    at: safeText(input.at, 80) || now()
  };
}
function mergeStoredItems(restored, current, cleaner, max) {
  const items = new Map();
  for (const raw of [...(Array.isArray(restored) ? restored : []), ...(Array.isArray(current) ? current : [])]) {
    const item = cleaner(raw);
    if (item) items.set(item.id, item);
  }
  const merged = Array.from(items.values()).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return Number.isFinite(max) ? merged.slice(-max) : merged;
}

function persistedRoom(r) {
  const context = r.context || {};
  return {
    ...r,
    messages: Array.isArray(r.messages) ? r.messages.map(cleanStoredMessage).filter(Boolean) : [],
    notes: Array.isArray(r.notes) ? r.notes.map(cleanStoredNote).filter(Boolean) : [],
    card: cleanStoredCard(r.card, r.title),
    playbackHistory: Array.isArray(r.playbackHistory) ? r.playbackHistory.map(cleanPlaybackHistory).filter(Boolean) : [],
    context: {
      currentSubtitle: safeText(context.currentSubtitle, 500),
      recentSubtitles: Array.isArray(context.recentSubtitles) ? context.recentSubtitles.map(x => safeText(x, 500)).filter(Boolean).slice(-8) : [],
      subtitleUpdatedAt: safeText(context.subtitleUpdatedAt, 80) || null,
      latestFrame: null,
      frameHistory: [],
      frameUpdatedAt: null,
      frameSource: "",
      screenshotRequestId: null,
      screenshotRequestedAt: null,
      actor: safeText(context.actor, 80),
      observedAt: safeText(context.observedAt, 80) || null,
      playbackDebug: cleanPlaybackDebug(context.playbackDebug)
    }
  };
}

function roomFile(id) {
  return path.join(DATA_DIR, `${normalizeRoomId(id)}.json`);
}

function roomMarkdownFile(id) {
  return path.join(DATA_DIR, `${normalizeRoomId(id)}.md`);
}

function atomicWrite(target, contents) {
  const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, contents, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, target);
}

function persistRoom(r) {
  if (!r || !r.id) return;
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  atomicWrite(roomFile(r.id), JSON.stringify(persistedRoom(r), null, 2));
  atomicWrite(roomMarkdownFile(r.id), roomToMarkdown(r));
}

function hydrateRoom(raw, fallbackId) {
  if (!raw || typeof raw !== "object") return null;
  const id = normalizeRoomId(raw.id || fallbackId);
  const base = newRoom(id);
  const r = {
    ...base,
    ...raw,
    id,
    sessionId: safeText(raw.sessionId, 100) || base.sessionId,
    sessionStartedAt: safeText(raw.sessionStartedAt, 80) || safeText(raw.createdAt, 80) || base.createdAt,
    createdAt: safeText(raw.createdAt, 80) || base.createdAt,
    updatedAt: safeText(raw.updatedAt, 80) || base.updatedAt,
    title: safeText(raw.title, 120) || base.title,
    fileName: safeText(raw.fileName, 180),
    assistantName: cleanAssistantName(raw.assistantName),
    partner: safeText(raw.partner, 100) || base.partner,
    mood: safeText(raw.mood, 100) || base.mood,
    inviteNote: safeText(raw.inviteNote, 300) || base.inviteNote,
    messages: mergeStoredItems(raw.messages, [], cleanStoredMessage),
    notes: mergeStoredItems(raw.notes, [], cleanStoredNote),
    card: cleanStoredCard(raw.card, raw.title),
    playbackHistory: mergeStoredItems(raw.playbackHistory, [], cleanPlaybackHistory),
    context: { ...blankContext(), ...(raw.context || {}), latestFrame:null, frameHistory:[], screenshotRequestId:null, screenshotRequestedAt:null }
  };
  r.duration = Math.max(0, Number(raw.duration || 0));
  r.currentTime = Math.max(0, Number(raw.currentTime || 0));
  r.paused = raw.paused !== false;
  return r;
}

function loadPersistedRooms() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    for (const file of fs.readdirSync(DATA_DIR)) {
      if (!/^[A-Z0-9_-]{1,64}\.json$/.test(file)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
        const r = hydrateRoom(raw, file.replace(/\.json$/, ""));
        if (r) rooms.set(r.id, r);
      } catch (error) {
        console.warn(`Skipping unreadable CineIsle archive ${file}: ${error.message}`);
      }
    }
  } catch (error) {
    console.warn(`CineIsle archive unavailable at ${DATA_DIR}: ${error.message}`);
  }
}

function recordPlayback(r, event, actor) {
  const item = cleanPlaybackHistory({
    id: crypto.randomUUID(), event, actor, currentTime:r.currentTime,
    paused:r.paused, fileName:r.fileName, at:now()
  });
  r.playbackHistory = Array.isArray(r.playbackHistory) ? r.playbackHistory : [];
  r.playbackHistory.push(item);
  return item;
}
function frameSignature(roomId, frameId) {
  if (!TOKEN) return "";
  return crypto.createHmac("sha256", TOKEN).update(`${roomId}:${frameId}`).digest("hex").slice(0, 24);
}
function hasFrameAccess(req, roomId, frameId) {
  if (isAuthed(req)) return true;
  const sig = String((req.query && req.query.sig) || "");
  return Boolean(TOKEN && sig && sig === frameSignature(roomId, frameId));
}
function framePath(r, frame) {
  if (!r || !frame || !frame.id) return "";
  const sig = frameSignature(r.id, frame.id);
  return `/api/rooms/${encodeURIComponent(r.id)}/frames/${encodeURIComponent(frame.id)}.jpg${sig ? `?sig=${sig}` : ""}`;
}
function frameUrl(req, r, frame) {
  const path = framePath(r, frame);
  const base = publicBaseUrl(req);
  return base && path ? base + path : path;
}
function findFrame(r, frameId) {
  if (!r || !r.context) return null;
  const id = String(frameId || "");
  const frames = [];
  if (r.context.latestFrame) frames.push(r.context.latestFrame);
  if (Array.isArray(r.context.frameHistory)) frames.push(...r.context.frameHistory);
  return frames.find(f => String(f && f.id) === id) || null;
}
function cleanPlaybackDebug(input) {
  const out = { events: [], range: null, lastError: "", updatedAt: now() };
  if (!input || typeof input !== "object") return out;
  if (Array.isArray(input.events)) {
    out.events = input.events.slice(-24).map(e => ({
      at: safeText(e.at || e.time || "", 80),
      event: safeText(e.event || e.type || "", 60),
      position: Number(e.position || e.currentTime || 0),
      readyState: Number(e.readyState || 0),
      networkState: Number(e.networkState || 0),
      message: safeText(e.message || e.detail || "", 240)
    })).filter(e => e.event);
  }
  if (input.range && typeof input.range === "object") {
    out.range = {
      checked: Boolean(input.range.checked),
      ok: input.range.ok === true,
      status: Number(input.range.status || 0),
      acceptRanges: safeText(input.range.acceptRanges || "", 80),
      contentRange: safeText(input.range.contentRange || "", 160),
      note: safeText(input.range.note || "", 240)
    };
  }
  out.lastError = safeText(input.lastError || "", 500);
  return out;
}
function frameForResponse(req, r, frame, includeData) {
  if (!frame) return null;
  const imageUrl = frame.imageUrl || frameUrl(req, r, frame);
  return {
    id: frame.id,
    mime: frame.mime,
    width: frame.width,
    height: frame.height,
    size: frame.size,
    source: frame.source || (r && r.context && r.context.frameSource) || "",
    note: frame.note || "",
    uploadedAt: frame.uploadedAt || (r && r.context && r.context.frameUpdatedAt) || null,
    imageUrl,
    image_url: imageUrl,
    url: imageUrl,
    path: framePath(r, frame),
    ocrText: frame.ocrText || "",
    extractedText: frame.extractedText || frame.ocrText || "",
    fallbackText: frame.fallbackText || "",
    dataUrl: includeData ? frame.dataUrl : undefined
  };
}
function compactContext(ctx, includeFrameData, req, roomId) {
  ctx = ctx || {};
  const fakeRoom = roomId ? { id: roomId, context: ctx } : { id: "", context: ctx };
  const latestFrame = frameForResponse(req, fakeRoom, ctx.latestFrame, includeFrameData);
  const recentFrames = Array.isArray(ctx.frameHistory) ? ctx.frameHistory.slice(-5).map(f => frameForResponse(req, fakeRoom, f, false)) : [];
  return {
    currentSubtitle: ctx.currentSubtitle || "",
    recentSubtitles: Array.isArray(ctx.recentSubtitles) ? ctx.recentSubtitles.slice(-8) : [],
    subtitleUpdatedAt: ctx.subtitleUpdatedAt || null,
    actor: ctx.actor || "",
    observedAt: ctx.observedAt || null,
    frameUpdatedAt: ctx.frameUpdatedAt || null,
    frameSource: ctx.frameSource || "",
    screenshotRequestId: ctx.screenshotRequestId || null,
    screenshotRequestedAt: ctx.screenshotRequestedAt || null,
    playbackDebug: ctx.playbackDebug || { events: [], range: null, lastError: "", updatedAt: null },
    recentFrames,
    latestFrame
  };
}
function pub(r, req){
  return {...r, messages:r.messages.slice(-80), notes:r.notes.slice(-80), playbackHistory:(r.playbackHistory || []).slice(-80), context: compactContext(r.context, false, req, r.id)};
}

function markdownInline(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").replace(/([\\`*_{}\[\]<>])/g, "\\$1").trim();
}

function markdownBlock(value) {
  const text = String(value ?? "").trim();
  return text ? text.split(/\r?\n/).map(line => `> ${line}`).join("\n") : "> （无）";
}

function progressLabel(sec) {
  sec = Math.max(0, Math.floor(Number(sec || 0)));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${m}:${String(s).padStart(2,"0")}`;
}

function roomToMarkdown(r) {
  const lines = [
    `# ${markdownInline(r.title || "未命名影片")} · 观影记录`,
    "",
    `- 房间：${markdownInline(r.id)}`,
    `- 场次 ID：${markdownInline(r.sessionId || r.id)}`,
    `- 开始时间：${markdownInline(r.sessionStartedAt || r.createdAt || "")}`,
    `- 最后更新：${markdownInline(r.updatedAt || "")}`,
    `- 影片文件：${markdownInline(r.fileName || "未记录")}`,
    `- 片长：${progressLabel(r.duration)}`,
    `- 最后进度：${progressLabel(r.currentTime)}（${r.paused === false ? "播放中" : "已暂停"}）`,
    `- 观影人：${markdownInline(r.partner || "未记录")}`,
    `- AI 搭子：${markdownInline(r.assistantName || "观影助手")}`,
    `- 氛围：${markdownInline(r.mood || "未记录")}`,
    "",
    "## 开场备注",
    "",
    markdownBlock(r.inviteNote),
    "",
    "## 聊天与弹幕",
    ""
  ];
  const messages = Array.isArray(r.messages) ? r.messages : [];
  if (!messages.length) lines.push("（无）");
  for (const m of messages) {
    const danmaku = m.danmaku === true || String(m.text || "").startsWith("弹幕：");
    const text = String(m.text || "").replace(/^弹幕：/, "");
    lines.push(`- [${progressLabel(m.time)}] [${markdownInline(m.at)}] **${markdownInline(m.name || "观影人")} · ${danmaku ? "弹幕" : "聊天"}**：${markdownInline(text)}`);
  }
  lines.push("", "## 笔记", "");
  const notes = Array.isArray(r.notes) ? r.notes : [];
  if (!notes.length) lines.push("（无）");
  for (const n of notes) {
    lines.push(`- [${progressLabel(n.time)}] [${markdownInline(n.at)}] **${markdownInline(n.name || "观影人")}**：${markdownInline(n.text)}`);
  }
  lines.push("", "## 播放记录", "");
  const playback = Array.isArray(r.playbackHistory) ? r.playbackHistory : [];
  if (!playback.length) lines.push(`- [${progressLabel(r.currentTime)}] [${markdownInline(r.updatedAt)}] ${r.paused === false ? "播放" : "暂停"} · ${markdownInline(r.lastActor || "观影人")}`);
  for (const item of playback) {
    lines.push(`- [${progressLabel(item.currentTime)}] [${markdownInline(item.at)}] ${markdownInline(item.event)} · ${markdownInline(item.actor)} · ${item.paused === false ? "播放中" : "已暂停"}`);
  }
  lines.push("", "## 观影卡", "");
  if (!r.card) {
    lines.push("（无）");
  } else {
    const c = r.card;
    lines.push(
      `- 标题：${markdownInline(c.title)}`,
      `- 模板：${markdownInline(c.template)}`,
      `- 评分：${markdownInline(c.rating)}`,
      `- 生成时间：${markdownInline(c.generatedAt)}`,
      "",
      "### 摘录",
      "",
      markdownBlock(c.quote || c.zhiQuote || c.linQuote),
      "",
      "### 观后感",
      "",
      markdownBlock(c.note || c.zhiNote || c.linNote)
    );
  }
  return `${lines.join("\n")}\n`;
}

loadPersistedRooms();

function watchSnapshot(r, req) {
  const context = compactContext(r.context, false, req, r.id);
  delete context.playbackDebug;
  return {
    id: r.id,
    title: r.title,
    fileName: r.fileName,
    duration: r.duration,
    currentTime: r.currentTime,
    paused: r.paused,
    lastActor: r.lastActor,
    assistantName: r.assistantName,
    messages: r.messages.slice(-16),
    notes: r.notes.slice(-8),
    context
  };
}

function normalizeWatchTypes(value) {
  const fallback = ["message", "playback", "screenshot"];
  if (!Array.isArray(value) || value.length === 0) return fallback;
  return value.map(x => safeText(x, 40)).filter(Boolean).slice(0, 12);
}

async function waitForRoomEvent(args, req) {
  const roomId = String(args.room || args.room_id || "").trim().toUpperCase();
  const r = rooms.get(roomId);
  if (!r) throw new Error("ROOM_NOT_FOUND");

  const state = eventState(roomId);
  const rawCursor = args.after ?? args.cursor;
  const hasCursor = rawCursor !== undefined && rawCursor !== null && rawCursor !== "";
  const after = hasCursor ? Math.max(0, Number(rawCursor) || 0) : state.seq;
  const eventTypes = normalizeWatchTypes(args.eventTypes || args.events);
  const timeoutSeconds = Math.min(45, Math.max(5, Number(args.timeoutSeconds || 40)));

  const matchedEvents = () => state.events
    .filter(event => event.seq > after && eventTypes.includes(event.type))
    .slice(-20);

  if (!hasCursor) {
    return {
      ok: true,
      baseline: true,
      timedOut: false,
      cursor: state.seq,
      eventTypes,
      events: [],
      room: watchSnapshot(r, req)
    };
  }

  let events = matchedEvents();
  if (events.length === 0) {
    await new Promise(resolve => {
      let settled = false;
      let timer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.waiters.delete(wake);
        resolve();
      };
      const wake = () => {
        if (matchedEvents().length) finish();
      };
      state.waiters.add(wake);
      timer = setTimeout(finish, timeoutSeconds * 1000);
    });
    events = matchedEvents();
  }

  return {
    ok: true,
    baseline: false,
    timedOut: events.length === 0,
    cursor: state.seq,
    eventTypes,
    events,
    room: watchSnapshot(r, req)
  };
}
function getTokenFromReq(req) {
  return (req.headers.authorization || "").replace(/^Bearer\s+/i,"")
    || req.headers["x-cineisle-token"]
    || req.headers["x-linjian-token"]
    || (req.query && req.query.token)
    || (req.body && req.body.token)
    || (req.body && req.body.params && req.body.params.token)
    || (req.body && req.body.arguments && req.body.arguments.token)
    || "";
}

function isAuthed(req) {
  if (!TOKEN) return true;
  return getTokenFromReq(req) === TOKEN;
}

function auth(req,res,next){
  if (!isAuthed(req)) return res.status(403).json({ok:false,error:"CINEISLE_BAD_TOKEN"});
  next();
}

app.get("/", (req,res)=>res.sendFile(__dirname + "/public/index.html"));
app.get("/server-info", (req,res)=>res.json({ok:true, app:"CineIsle Server", version:APP_VERSION, rooms:rooms.size, tokenRequired:Boolean(TOKEN), persistence:{enabled:true, directory:process.env.CINEISLE_DATA_DIR ? "configured" : "local"}, mcp:"/mcp", health:"/api/health", time:now()}));
app.get("/api/health",(req,res)=>res.json({ok:true, app:"CineIsle Server", version:APP_VERSION, rooms:rooms.size, tokenRequired:Boolean(TOKEN), persistence:{enabled:true, directory:process.env.CINEISLE_DATA_DIR ? "configured" : "local"}, time:now()}));

app.post("/api/rooms", auth, (req,res)=>{
  const r = ensure(code());
  r.title = safeText(req.body.title, 120) || r.title;
  r.theme = safeText(req.body.theme, 40) || r.theme;
  applyAssistantName(r, req.body);
  r.partner = safeText(req.body.partner, 100) || r.partner;
  r.mood = safeText(req.body.mood, 100) || r.mood;
  r.inviteNote = safeText(req.body.inviteNote, 300) || r.inviteNote;
  roomEvent(r, "room", { actor: req.body.partner || "观影人", title: r.title });
  res.json({ok:true, room: pub(r, req)});
});
app.get("/api/rooms/:id/export.md", auth, (req,res)=>{
  const id = normalizeRoomId(req.params.id);
  const r = rooms.get(id);
  if (!r) return res.status(404).json({ok:false,error:"ROOM_NOT_FOUND"});
  const safeTitle = safeText(r.title, 80).replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "cineisle";
  const filename = `${safeTitle}-${r.id}.md`;
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(roomToMarkdown(r));
});
app.get("/api/rooms/:id", auth, (req,res)=>{
  const r = rooms.get(normalizeRoomId(req.params.id));
  if (!r) return res.status(404).json({ok:false,error:"ROOM_NOT_FOUND"});
  res.json({ok:true, room: pub(r, req)});
});
app.post("/api/rooms/:id/restore", auth, (req,res)=>{
  const snapshot = req.body && typeof req.body.room === "object" ? req.body.room : req.body || {};
  const r = ensure(req.params.id);
  const hadPlayback = Boolean(r.fileName) || Number(r.duration || 0) > 0 || Number(r.currentTime || 0) > 0;
  const incomingTitle = safeText(snapshot.title, 120);
  if (incomingTitle && (r.title === "未命名影片" || !r.title)) r.title = incomingTitle;
  if (!r.fileName && snapshot.fileName) r.fileName = safeText(snapshot.fileName, 180);
  if (!r.duration && Number(snapshot.duration) > 0) r.duration = Math.max(0, Number(snapshot.duration));
  if (!r.currentTime && Number(snapshot.currentTime) > 0) r.currentTime = Math.max(0, Number(snapshot.currentTime));
  if (typeof snapshot.paused === "boolean" && !hadPlayback) r.paused = snapshot.paused;
  if (r.assistantName === "观影助手" && snapshot.assistantName) r.assistantName = cleanAssistantName(snapshot.assistantName);
  if ((!r.partner || r.partner === "观影人 A × 观影人 B") && snapshot.partner) r.partner = safeText(snapshot.partner, 100);
  if ((!r.mood || r.mood === "夜航") && snapshot.mood) r.mood = safeText(snapshot.mood, 100);
  if ((!r.inviteNote || r.inviteNote === "今晚一起登岛看一场电影。") && snapshot.inviteNote) r.inviteNote = safeText(snapshot.inviteNote, 300);
  r.messages = mergeStoredItems(snapshot.messages, r.messages, cleanStoredMessage);
  r.notes = mergeStoredItems(snapshot.notes, r.notes, cleanStoredNote);
  r.playbackHistory = mergeStoredItems(snapshot.playbackHistory, r.playbackHistory, cleanPlaybackHistory);
  if (snapshot.card) {
    const restoredCard = cleanStoredCard(snapshot.card, r.title);
    const currentCardAt = Date.parse((r.card && r.card.generatedAt) || "") || 0;
    const restoredCardAt = Date.parse((restoredCard && restoredCard.generatedAt) || "") || 0;
    if (!r.card || restoredCardAt > currentCardAt) r.card = restoredCard;
  }
  r.updatedAt = now();
  roomEvent(r, "room", { actor:req.body.name || "观影人", title:r.title, restored:true });
  res.json({ok:true, restored:true, room:pub(r, req)});
});
app.post("/api/rooms/:id/message", auth, (req,res)=>{
  const r = ensure(req.params.id);
  applyAssistantName(r, req.body);
  const rawText = safeText(req.body.text, 500);
  if (!rawText) return res.status(400).json({ok:false,error:"MESSAGE_REQUIRED"});
  const text = req.body.danmaku && !rawText.startsWith("弹幕：")
    ? `弹幕：${rawText}`
    : rawText;
  const m = cleanStoredMessage({ id:crypto.randomUUID(), name:req.body.name, text, danmaku:req.body.danmaku === true, time:r.currentTime, at:now() });
  r.messages.push(m); r.updatedAt = now();
  roomEvent(r, "message", m);
  res.json({ok:true, message:m, room:pub(r, req)});
});
app.post("/api/rooms/:id/playback", auth, (req,res)=>{
  const r = ensure(req.params.id);
  const previous = { currentTime:r.currentTime, paused:r.paused, fileName:r.fileName };
  applyAssistantName(r, req.body);
  if (typeof req.body.currentTime === "number") r.currentTime = Math.max(0, req.body.currentTime);
  if (typeof req.body.duration === "number") r.duration = Math.max(0, req.body.duration);
  if (typeof req.body.paused === "boolean") r.paused = req.body.paused;
  if (req.body.title) r.title = String(req.body.title).slice(0,100);
  if (req.body.fileName) r.fileName = String(req.body.fileName).slice(0,180);
  if (req.body.partner) r.partner = String(req.body.partner).slice(0,80);
  if (req.body.mood) r.mood = String(req.body.mood).slice(0,80);
  if (req.body.inviteNote) r.inviteNote = String(req.body.inviteNote).slice(0,240);
  r.lastActor = req.body.actor || req.body.name || "观影人";
  if (req.body.playbackDebug) {
    r.context = r.context || {};
    r.context.playbackDebug = cleanPlaybackDebug(req.body.playbackDebug);
  }
  r.updatedAt = now();
  const playbackChanged = previous.paused !== r.paused
    || Math.abs(Number(previous.currentTime || 0) - Number(r.currentTime || 0)) >= 8
    || previous.fileName !== r.fileName;
  if (playbackChanged) {
    const event = previous.fileName !== r.fileName ? "载入影片"
      : previous.paused !== r.paused ? (r.paused ? "暂停" : "播放") : "跳转";
    const history = recordPlayback(r, event, r.lastActor);
    roomEvent(r, "playback", { currentTime:r.currentTime, paused:r.paused, actor:r.lastActor, fileName:r.fileName, historyId:history.id });
  } else persistRoom(r);
  res.json({ok:true, room:pub(r, req)});
});
app.post("/api/rooms/:id/note", auth, (req,res)=>{
  const r = ensure(req.params.id);
  applyAssistantName(r, req.body);
  const noteText = safeText(req.body.text, 800);
  if (!noteText) return res.status(400).json({ok:false,error:"NOTE_REQUIRED"});
  const noteTime = Number(req.body.time);
  const n = cleanStoredNote({ id:crypto.randomUUID(), name:req.body.name, text:noteText, type:req.body.type, time:Number.isFinite(noteTime) ? noteTime : r.currentTime, at:now() });
  r.notes.push(n); r.updatedAt = now();
  roomEvent(r, "note", n);
  res.json({ok:true, note:n, room:pub(r, req)});
});
app.post("/api/rooms/:id/card", auth, (req,res)=>{
  const r = ensure(req.params.id);
  applyAssistantName(r, req.body);
  r.card = cleanStoredCard({
    title:req.body.title || r.title,
    rating:req.body.rating || 4.5,
    template:req.body.template || "ticket",
    partner:req.body.partner || r.partner || "",
    mood:req.body.mood || r.mood || "",
    inviteNote:req.body.inviteNote || r.inviteNote || "",
    quote:req.body.quote || "",
    note:req.body.note || "",
    zhiQuote:req.body.viewerAQuote || req.body.zhiQuote || req.body.userQuote || "",
    linQuote:req.body.viewerBQuote || req.body.linQuote || req.body.aiQuote || "",
    zhiNote:req.body.viewerANote || req.body.zhiNote || req.body.userNote || "",
    linNote:req.body.viewerBNote || req.body.linNote || req.body.aiNote || "",
    generatedAt:now()
  }, r.title);
  r.updatedAt = now();
  roomEvent(r, "card", { title:r.card.title, rating:r.card.rating, template:r.card.template });
  res.json({ok:true, card:r.card, room:pub(r, req)});
});

app.post("/api/rooms/:id/context", auth, (req,res)=>{
  const r = ensure(req.params.id);
  const previousSubtitle = String((r.context && r.context.currentSubtitle) || "");
  applyAssistantName(r, req.body);
  const ctx = r.context || (r.context = {});
  if (typeof req.body.currentTime === "number") r.currentTime = Math.max(0, req.body.currentTime);
  if (typeof req.body.duration === "number") r.duration = Math.max(0, req.body.duration);
  if (typeof req.body.paused === "boolean") r.paused = req.body.paused;
  if (req.body.title) r.title = String(req.body.title).slice(0,100);
  if (req.body.fileName) r.fileName = String(req.body.fileName).slice(0,180);
  ctx.recentSubtitles = Array.isArray(req.body.recentSubtitles)
    ? req.body.recentSubtitles.map(x => String(x || "").slice(0,500)).filter(Boolean).slice(-8)
    : [];
  let subtitleText = String(req.body.currentSubtitle || "").slice(0,500);
  if (!subtitleText && ctx.recentSubtitles.length) {
    subtitleText = String(ctx.recentSubtitles[ctx.recentSubtitles.length - 1] || "").slice(0,500);
  }
  ctx.currentSubtitle = subtitleText;
  ctx.actor = String(req.body.actor || req.body.name || "观影人").slice(0,80);
  ctx.observedAt = req.body.observedAt || now();
  ctx.subtitleUpdatedAt = now();
  if (req.body.playbackDebug) ctx.playbackDebug = cleanPlaybackDebug(req.body.playbackDebug);
  r.lastActor = ctx.actor;
  r.updatedAt = now();
  if (ctx.currentSubtitle && ctx.currentSubtitle !== previousSubtitle) {
    roomEvent(r, "subtitle", { currentTime:r.currentTime, text:ctx.currentSubtitle, actor:ctx.actor });
  } else persistRoom(r);
  res.json({ok:true, context: compactContext(ctx, false, req, r.id), room: pub(r, req)});
});

app.post("/api/rooms/:id/screenshot", auth, (req,res)=>{
  const r = ensure(req.params.id);
  applyAssistantName(r, req.body);
  const ctx = r.context || (r.context = {});
  const raw = String(req.body.dataUrl || req.body.imageBase64 || "");
  if (!raw) return res.status(400).json({ok:false,error:"IMAGE_REQUIRED"});
  const dataUrl = raw.startsWith("data:") ? raw : `data:${req.body.mime || "image/jpeg"};base64,${raw}`;
  if (dataUrl.length > 5_500_000) return res.status(413).json({ok:false,error:"IMAGE_TOO_LARGE"});
  const frameId = Date.now()+"";
  const ocrText = safeText(req.body.ocrText || req.body.extractedText || req.body.screenshotText || "", 3000);
  const recentSubtitles = Array.isArray(ctx.recentSubtitles) ? ctx.recentSubtitles.slice(-5).join("\n") : "";
  const fallbackText = safeText([
    ocrText ? `截图文字：${ocrText}` : "",
    ctx.currentSubtitle ? `当前字幕：${ctx.currentSubtitle}` : "",
    recentSubtitles ? `最近字幕：\n${recentSubtitles}` : "",
    req.body.note ? `上传备注：${req.body.note}` : ""
  ].filter(Boolean).join("\n\n"), 4000);
  ctx.latestFrame = {
    id: frameId,
    dataUrl,
    mime: String(req.body.mime || (dataUrl.match(/^data:([^;]+)/)||[])[1] || "image/jpeg").slice(0,50),
    width: Number(req.body.width || 0),
    height: Number(req.body.height || 0),
    size: dataUrl.length,
    source: String(req.body.source || "accessibility").slice(0,80),
    note: String(req.body.note || "").slice(0,240),
    ocrText,
    extractedText: ocrText,
    fallbackText,
    uploadedAt: now()
  };
  ctx.latestFrame.imageUrl = frameUrl(req, r, ctx.latestFrame);
  ctx.latestFrame.image_url = ctx.latestFrame.imageUrl;
  ctx.frameUpdatedAt = ctx.latestFrame.uploadedAt;
  ctx.frameSource = ctx.latestFrame.source;
  ctx.frameHistory = Array.isArray(ctx.frameHistory) ? ctx.frameHistory : [];
  ctx.frameHistory.push(ctx.latestFrame);
  while (ctx.frameHistory.length > 5) ctx.frameHistory.shift();
  ctx.screenshotRequestId = null;
  ctx.screenshotRequestedAt = null;
  ctx.actor = String(req.body.actor || req.body.name || ctx.actor || "观影人").slice(0,80);
  ctx.observedAt = now();
  r.updatedAt = now();
  roomEvent(r, "screenshot", { frameId, actor:ctx.actor, source:ctx.frameSource, uploadedAt:ctx.frameUpdatedAt });
  res.json({ok:true, frame: compactContext(ctx, false, req, r.id).latestFrame, ocrText, fallbackText, room: pub(r, req)});
});

app.post("/api/rooms/:id/screenshot-request", auth, (req,res)=>{
  const r = rooms.get(normalizeRoomId(req.params.id));
  if (!r) return res.status(404).json({ok:false,error:"ROOM_NOT_FOUND"});
  const requestId = Date.now() + "";
  r.context.screenshotRequestId = requestId;
  r.context.screenshotRequestedAt = now();
  r.context.frameSource = "request-pending";
  applyAssistantName(r, req.body);
  r.context.actor = req.body.actor || req.body.name || defaultAssistant(r);
  r.updatedAt = now();
  roomEvent(r, "screenshot_request", { requestId, actor:r.context.actor, requestedAt:r.context.screenshotRequestedAt });
  res.json({ok:true, requestId, requestedAt:r.context.screenshotRequestedAt, room:pub(r, req)});
});
app.get("/api/rooms/:id/screenshot-request", auth, (req,res)=>{
  const r = rooms.get(normalizeRoomId(req.params.id));
  if (!r) return res.status(404).json({ok:false,error:"ROOM_NOT_FOUND"});
  const since = String(req.query.since || "");
  const requestId = r.context.screenshotRequestId || "";
  res.json({
    ok:true,
    pending: Boolean(requestId && requestId !== since),
    requestId,
    requestedAt: r.context.screenshotRequestedAt || null
  });
});

app.get("/api/rooms/:id/context", auth, (req,res)=>{
  const r = rooms.get(normalizeRoomId(req.params.id));
  if (!r) return res.status(404).json({ok:false,error:"ROOM_NOT_FOUND"});
  const includeFrame = String(req.query.includeFrame || req.query.includeScreenshot || "") === "1";
  res.json({ok:true, room: pub(r, req), context: compactContext(r.context, includeFrame, req, r.id)});
});

app.get("/api/rooms/:id/playback-debug", auth, (req,res)=>{
  const r = rooms.get(normalizeRoomId(req.params.id));
  if (!r) return res.status(404).json({ok:false,error:"ROOM_NOT_FOUND"});
  res.json({ok:true, playbackDebug: (r.context && r.context.playbackDebug) || {events:[], range:null, lastError:"", updatedAt:null}});
});

function sendFrameImage(req, res, r, frame) {
  if (!r || !frame || !frame.dataUrl) return res.status(404).json({ok:false,error:"FRAME_NOT_FOUND"});
  if (!hasFrameAccess(req, r.id, frame.id)) return res.status(403).json({ok:false,error:"CINEISLE_BAD_TOKEN"});
  const m = String(frame.dataUrl).match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return res.status(500).json({ok:false,error:"BAD_FRAME_DATA"});
  const buf = Buffer.from(m[2], "base64");
  res.setHeader("Content-Type", m[1] || frame.mime || "image/jpeg");
  res.setHeader("Cache-Control", "no-store");
  res.send(buf);
}

app.get("/api/rooms/:id/latest-frame.jpg", (req,res)=>{
  const r = rooms.get(normalizeRoomId(req.params.id));
  const frame = r && r.context && r.context.latestFrame;
  return sendFrameImage(req, res, r, frame);
});

app.get("/api/rooms/:id/frames/:frameId.jpg", (req,res)=>{
  const r = rooms.get(normalizeRoomId(req.params.id));
  const frame = findFrame(r, req.params.frameId);
  return sendFrameImage(req, res, r, frame);
});


function mcpTools() {
  return [
    {
      name: "create_room",
      description: "创建一个映屿 CineIsle 观影房间",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "电影或房间标题" },
          theme: { type: "string", description: "主题皮肤，可选 cream/night/galaxy/matcha/film/dusk" },
          partner: { type: "string", description: "观影人显示名" },
          assistantName: { type: "string", description: "AI 观影搭子的名字，不填时为观影助手" },
          mood: { type: "string", description: "今晚观影氛围" },
          inviteNote: { type: "string", description: "观影邀请卡开场备注" }
        }
      }
    },
    {
      name: "get_room_state",
      description: "读取观影房间状态、播放进度、聊天、笔记和小卡片",
      inputSchema: {
        type: "object",
        properties: {
          room: { type: "string", description: "房间号" }
        },
        required: ["room"]
      }
    },
    {
      name: "export_room_markdown",
      description: "导出一个观影场次的完整 Markdown 记录，包含聊天、弹幕、笔记、观影卡和播放进度事件",
      inputSchema: {
        type: "object",
        properties: {
          room: { type: "string", description: "房间号" }
        },
        required: ["room"]
      }
    },
    {
      name: "wait_for_room_event",
      description: "陪看模式长轮询：等待房间出现新聊天、播放操作或截图；首次不传 cursor 会立即返回基线与 cursor，后续循环传回 cursor。无人操作时会在超时后返回最新字幕上下文，适合 AI 持续陪看。",
      inputSchema: {
        type: "object",
        properties: {
          room: { type: "string", description: "房间号" },
          cursor: { type: "number", description: "上一次返回的 cursor；首次调用不要填写" },
          timeoutSeconds: { type: "number", description: "最长等待秒数，范围 5-45，默认 40" },
          eventTypes: {
            type: "array",
            items: { type: "string", enum: ["message", "playback", "subtitle", "screenshot", "screenshot_request", "note", "card", "room"] },
            description: "立即唤醒的事件类型；默认 message、playback、screenshot"
          }
        },
        required: ["room"]
      }
    },
    {
      name: "send_room_message",
      description: "向观影房间发送聊天或弹幕",
      inputSchema: {
        type: "object",
        properties: {
          room: { type: "string", description: "房间号" },
          name: { type: "string", description: "发送者昵称" },
          text: { type: "string", description: "消息内容" },
          danmaku: { type: "boolean", description: "是否作为弹幕发送" }
        },
        required: ["room", "text"]
      }
    },
    {
      name: "control_playback",
      description: "同步控制播放状态，例如暂停、继续、跳转到某个秒数",
      inputSchema: {
        type: "object",
        properties: {
          room: { type: "string", description: "房间号" },
          currentTime: { type: "number", description: "播放进度，单位秒" },
          paused: { type: "boolean", description: "是否暂停" },
          actor: { type: "string", description: "操作者" }
        },
        required: ["room"]
      }
    },
    {
      name: "add_note",
      description: "给观影房间添加一条观影笔记",
      inputSchema: {
        type: "object",
        properties: {
          room: { type: "string", description: "房间号" },
          name: { type: "string", description: "记录者昵称" },
          text: { type: "string", description: "笔记内容" },
          time: { type: "number", description: "对应播放时间，单位秒" }
        },
        required: ["room", "text"]
      }
    },
    {
      name: "request_screenshot",
      description: "请求手机端立即上传一张当前屏幕截图；类似掌心窗 peek，但只在用户开启映屿截图权限后生效",
      inputSchema: {
        type: "object",
        properties: {
          room: { type: "string", description: "房间号" },
          actor: { type: "string", description: "请求者" }
        },
        required: ["room"]
      }
    },
    {
      name: "get_viewing_context",
      description: "读取映屿 CineIsle 当前观影上下文：播放状态、当前字幕、最近字幕，以及可选的低频画面截图",
      inputSchema: {
        type: "object",
        properties: {
          room: { type: "string", description: "房间号" },
          includeScreenshot: { type: "boolean", description: "是否额外包含最近一张截图的 dataUrl；默认返回 image_url 与 OCR/兜底文本，dataUrl 可不传" }
        },
        required: ["room"]
      }
    },

    {
      name: "get_screenshot_text",
      description: "读取最近一张映屿截图的可访问 image_url、OCR/兜底文本和元数据；用于模型无法直接看 MCP 图片时仍能理解画面",
      inputSchema: {
        type: "object",
        properties: {
          room: { type: "string", description: "房间号" }
        },
        required: ["room"]
      }
    },
    {
      name: "get_playback_debug",
      description: "读取最近播放器事件、卡顿/错误和 Range 检测信息，用于排查播放十秒后卡住等问题",
      inputSchema: {
        type: "object",
        properties: {
          room: { type: "string", description: "房间号" }
        },
        required: ["room"]
      }
    },
    {
      name: "generate_card",
      description: "生成或更新观影小卡片",
      inputSchema: {
        type: "object",
        properties: {
          room: { type: "string", description: "房间号" },
          title: { type: "string", description: "卡片标题" },
          rating: { type: "number", description: "评分" },
          quote: { type: "string", description: "摘录" },
          note: { type: "string", description: "观影感想" },
          template: { type: "string", description: "卡片模板：ticket/receipt/postcard" },
          viewerAQuote: { type: "string", description: "观影人 A 喜欢的台词" },
          viewerBQuote: { type: "string", description: "观影人 B 喜欢的台词" },
          viewerANote: { type: "string", description: "观影人 A 观后感" },
          viewerBNote: { type: "string", description: "观影人 B 观后感" },
          zhiQuote: { type: "string", description: "兼容旧字段：观影人 A 喜欢的台词" },
          linQuote: { type: "string", description: "兼容旧字段：观影人 B 喜欢的台词" },
          partner: { type: "string", description: "观影人显示名" },
          mood: { type: "string", description: "观影氛围" },
          inviteNote: { type: "string", description: "观影邀请卡开场备注" }
        },
        required: ["room"]
      }
    }
  ];
}

function stripFrameData(obj) {
  try {
    const copy = JSON.parse(JSON.stringify(obj));
    const frame = copy && copy.context && copy.context.latestFrame;
    if (frame && frame.dataUrl) frame.dataUrl = "[image attached]";
    const roomFrame = copy && copy.room && copy.room.context && copy.room.context.latestFrame;
    if (roomFrame && roomFrame.dataUrl) roomFrame.dataUrl = "[image attached]";
    return copy;
  } catch (e) { return obj; }
}

function imagePartFromResult(obj) {
  try {
    const frame = obj && obj.context && obj.context.latestFrame;
    if (!frame || !frame.dataUrl) return null;
    const m = String(frame.dataUrl).match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return null;
    return { type: "image", mimeType: m[1] || frame.mime || "image/jpeg", data: m[2] };
  } catch (e) { return null; }
}

function mcpText(obj) {
  return {
    content: [
      {
        type: "text",
        text: typeof obj === "string" ? obj : JSON.stringify(stripFrameData(obj), null, 2)
      }
    ]
  };
}

function mcpPayload(obj) {
  const out = mcpText(obj);
  const img = imagePartFromResult(obj);
  if (img) out.content.push(img);
  return out;
}

async function callCinemaTool(name, args, req) {
  args = args || {};

  if (name === "create_room") {
    const r = ensure(code());
    r.title = safeText(args.title, 120) || r.title;
    r.theme = safeText(args.theme, 40) || r.theme;
    applyAssistantName(r, args);
    r.partner = safeText(args.partner, 100) || r.partner;
    r.mood = safeText(args.mood, 100) || r.mood;
    r.inviteNote = safeText(args.inviteNote, 300) || r.inviteNote;
    roomEvent(r, "room", { actor:defaultAssistant(r), title:r.title });
    return pub(r, req);
  }

  if (name === "get_room_state") {
    const r = rooms.get(normalizeRoomId(args.room || args.room_id));
    if (!r) throw new Error("ROOM_NOT_FOUND");
    return pub(r, req);
  }

  if (name === "export_room_markdown") {
    const r = rooms.get(normalizeRoomId(args.room || args.room_id));
    if (!r) throw new Error("ROOM_NOT_FOUND");
    return { ok:true, room:r.id, sessionId:r.sessionId, filename:`cineisle-${r.id}.md`, markdown:roomToMarkdown(r) };
  }

  if (name === "wait_for_room_event") {
    return waitForRoomEvent(args, req);
  }

  if (name === "send_room_message") {
    const r = ensure(args.room || args.room_id);
    const rawText = safeText(args.text, 500);
    if (!rawText) throw new Error("MESSAGE_REQUIRED");
    const text = args.danmaku && !rawText.startsWith("弹幕：") ? `弹幕：${rawText}` : rawText;
    const m = cleanStoredMessage({ id:crypto.randomUUID(), name:args.name || defaultAssistant(r), text, danmaku:args.danmaku === true, time:r.currentTime, at:now() });
    r.messages.push(m);
    r.updatedAt = now();
    roomEvent(r, "message", m);
    return { message: m, room: pub(r, req) };
  }

  if (name === "control_playback") {
    const r = ensure(args.room || args.room_id);
    const previous = { currentTime:r.currentTime, paused:r.paused };
    if (typeof args.currentTime === "number") r.currentTime = Math.max(0, args.currentTime);
    if (typeof args.paused === "boolean") r.paused = args.paused;
    if (args.partner) r.partner = String(args.partner).slice(0,80);
    if (args.mood) r.mood = String(args.mood).slice(0,80);
    if (args.inviteNote) r.inviteNote = String(args.inviteNote).slice(0,240);
    applyAssistantName(r, args);
    r.lastActor = args.actor || defaultAssistant(r);
    r.updatedAt = now();
    if (previous.paused !== r.paused || Math.abs(Number(previous.currentTime || 0) - Number(r.currentTime || 0)) >= 1) {
      const event = previous.paused !== r.paused ? (r.paused ? "暂停" : "播放") : "跳转";
      const history = recordPlayback(r, event, r.lastActor);
      roomEvent(r, "playback", { currentTime:r.currentTime, paused:r.paused, actor:r.lastActor, historyId:history.id });
    } else persistRoom(r);
    return pub(r, req);
  }

  if (name === "add_note") {
    const r = ensure(args.room || args.room_id);
    const noteText = safeText(args.text, 800);
    if (!noteText) throw new Error("NOTE_REQUIRED");
    const noteTime = Number(args.time);
    const n = cleanStoredNote({ id:crypto.randomUUID(), name:args.name || defaultAssistant(r), text:noteText, type:args.type, time:Number.isFinite(noteTime) ? noteTime : r.currentTime, at:now() });
    r.notes.push(n);
    r.updatedAt = now();
    roomEvent(r, "note", n);
    return { note: n, room: pub(r, req) };
  }

  if (name === "request_screenshot") {
    const r = rooms.get(normalizeRoomId(args.room || args.room_id));
    if (!r) throw new Error("ROOM_NOT_FOUND");
    const requestId = Date.now() + "";
    r.context.screenshotRequestId = requestId;
    r.context.screenshotRequestedAt = now();
    r.context.frameSource = "request-pending";
    applyAssistantName(r, args);
    r.context.actor = args.actor || defaultAssistant(r);
    r.updatedAt = now();
    roomEvent(r, "screenshot_request", { requestId, actor:r.context.actor, requestedAt:r.context.screenshotRequestedAt });
    return { ok:true, requestId, requestedAt:r.context.screenshotRequestedAt, room:pub(r, req) };
  }

  if (name === "get_viewing_context") {
    const r = rooms.get(normalizeRoomId(args.room || args.room_id));
    if (!r) throw new Error("ROOM_NOT_FOUND");
    const context = compactContext(r.context, Boolean(args.includeScreenshot), req, r.id);
    const latest = context.latestFrame;
    return {
      room: pub(r, req),
      context,
      images: latest ? [latest] : [],
      ocr_results: latest ? [{ frameId: latest.id, text: latest.ocrText || latest.fallbackText || "", imageUrl: latest.imageUrl }] : [],
      model_note: latest ? "如果 MCP 图片被平台转换为 mcp_img 占位符，请优先使用 imageUrl；若仍无法读取图片，请使用 ocr_results / fallbackText。" : "暂无截图。"
    };
  }

  if (name === "get_screenshot_text") {
    const r = rooms.get(normalizeRoomId(args.room || args.room_id));
    if (!r) throw new Error("ROOM_NOT_FOUND");
    const context = compactContext(r.context, false, req, r.id);
    const latest = context.latestFrame;
    return {
      ok: true,
      room: r.id,
      latestFrame: latest,
      images: latest ? [latest] : [],
      ocr_results: latest ? [{ frameId: latest.id, text: latest.ocrText || latest.fallbackText || "", imageUrl: latest.imageUrl }] : [],
      text: latest ? (latest.ocrText || latest.fallbackText || "已收到截图，但没有 OCR 文本；请使用 imageUrl 查看原图。") : "暂无截图。"
    };
  }

  if (name === "get_playback_debug") {
    const r = rooms.get(normalizeRoomId(args.room || args.room_id));
    if (!r) throw new Error("ROOM_NOT_FOUND");
    return { ok: true, room: r.id, playbackDebug: (r.context && r.context.playbackDebug) || {events:[], range:null,lastError:"",updatedAt:null} };
  }

  if (name === "generate_card") {
    const r = ensure(args.room || args.room_id);
    applyAssistantName(r, args);
    r.card = cleanStoredCard({
      title: args.title || r.title,
      rating: args.rating || 4.5,
      template: args.template || "ticket",
      partner: args.partner || r.partner || "",
      mood: args.mood || r.mood || "",
      inviteNote: args.inviteNote || r.inviteNote || "",
      quote: args.quote || "",
      note: args.note || "",
      zhiQuote: args.viewerAQuote || args.zhiQuote || args.userQuote || "",
      linQuote: args.viewerBQuote || args.linQuote || args.aiQuote || args.quote || "",
      zhiNote: args.viewerANote || args.zhiNote || args.userNote || "",
      linNote: args.viewerBNote || args.linNote || args.aiNote || args.note || "",
      generatedAt: now()
    }, r.title);
    r.updatedAt = now();
    roomEvent(r, "card", { title:r.card.title, rating:r.card.rating, template:r.card.template });
    return { card: r.card, room: pub(r, req) };
  }

  throw new Error("UNKNOWN_TOOL: " + name);
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMcpMessage(req, msg) {
  const id = msg.id;
  const method = msg.method || msg.tool || msg.name;
  const params = msg.params || {};
  const args = params.arguments || params || msg.arguments || {};

  // notifications usually have no id; do not answer them
  if (!id && method && method.startsWith("notifications/")) return null;

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: {
        name: "映屿 CineIsle · Viewing Context",
        version: APP_VERSION
      }
    });
  }

  if (method === "tools/list" || method === "list_tools") {
    return rpcResult(id, { tools: mcpTools() });
  }

  if (method === "tools/call") {
    if (!isAuthed(req)) return rpcError(id, -32001, "CINEISLE_BAD_TOKEN");
    const toolName = params.name;
    const toolArgs = params.arguments || {};
    try {
      const result = await callCinemaTool(toolName, toolArgs, req);
      return rpcResult(id, mcpPayload(result));
    } catch (e) {
      return rpcError(id, -32000, e.message);
    }
  }

  // 兼容旧写法：直接 method=create_room / send_room_message
  if (["create_room", "get_room_state", "export_room_markdown", "wait_for_room_event", "send_room_message", "control_playback", "add_note", "generate_card", "get_viewing_context", "request_screenshot", "get_screenshot_text", "get_playback_debug"].includes(method)) {
    if (!isAuthed(req)) return rpcError(id || 1, -32001, "CINEISLE_BAD_TOKEN");
    try {
      const result = await callCinemaTool(method, args, req);
      return id ? rpcResult(id, mcpPayload(result)) : { ok: true, result };
    } catch (e) {
      return id ? rpcError(id, -32000, e.message) : { ok: false, error: e.message };
    }
  }

  return rpcError(id || 1, -32601, "Method not found: " + method);
}

app.get("/mcp", (req, res) => {
  res.type("text/plain").send("CineIsle MCP endpoint is running. Use POST JSON-RPC.");
});

app.post("/mcp", async (req, res) => {
  try {
    const body = req.body || {};
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(msg => handleMcpMessage(req, msg)))).filter(Boolean);
      if (out.length === 0) return res.status(204).end();
      return res.json(out);
    }
    const out = await handleMcpMessage(req, body);
    if (!out) return res.status(204).end();
    return res.json(out);
  } catch (e) {
    return res.status(500).json(rpcError(1, -32000, e.message));
  }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`CineIsle server: http://localhost:${PORT}`));
}

module.exports = { app, rooms, roomToMarkdown, persistedRoom, hydrateRoom, APP_VERSION, DATA_DIR };
