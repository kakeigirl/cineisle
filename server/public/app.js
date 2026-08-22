(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    serverUrl: "",
    token: "",
    name: "观影人A",
    assistantName: "观影助手",
    roomId: "",
    room: null,
    applyingRemote: false,
    polling: null,
    contextTimer: null,
    lastPlaybackSyncAt: 0,
    lastContextAt: 0,
    lastSubtitleText: "",
    subtitles: [],
    danmakuOn: true,
    seenMessages: new Set(),
    hall: [],
    playbackEvents: [],
    playbackRange: null,
    lastPlaybackError: "",
    lastLocalPlaybackActionAt: 0,
    lastTimeupdateLogAt: 0,
    lastRangeCheckUrl: "",
    lastMessagesKey: "",
    restorePromise: null
  };

  const els = {
    serverUrl: $("serverUrl"), token: $("token"), viewerName: $("viewerName"), assistantName: $("assistantName"),
    joinRoomInput: $("joinRoomInput"), statusLine: $("statusLine"), healthState: $("healthState"), roomTitle: $("roomTitle"), roomBadge: $("roomBadge"),
    video: $("video"), videoFile: $("videoFile"), subtitleFile: $("subtitleFile"), subtitleOverlay: $("subtitleOverlay"), danmakuLayer: $("danmakuLayer"),
    playerState: $("playerState"), chatLog: $("chatLog"), chatInput: $("chatInput"), newMessagesBtn: $("newMessagesBtn"), noteLog: $("noteLog"), noteInput: $("noteInput"),
    quoteInput: $("quoteInput"), cardNoteInput: $("cardNoteInput"), cardTemplate: $("cardTemplate"), cardPreview: $("cardPreview"),
    contextState: $("contextState"), hallList: $("hallList"), installDialog: $("installDialog")
  };

  function cleanUrl(v) { return String(v || "").trim().replace(/\/+$/, ""); }
  function roomCode(v) { return String(v || "").trim().toUpperCase(); }
  function timeLabel(sec) {
    sec = Math.max(0, Math.floor(Number(sec || 0)));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${m}:${String(s).padStart(2,"0")}`;
  }
  function setStatus(text) { els.statusLine.textContent = text; }
  function apiPath(path) {
    const base = state.serverUrl || cleanUrl(location.origin);
    return base + path;
  }
  function headers(json = true) {
    const h = {};
    if (json) h["Content-Type"] = "application/json; charset=utf-8";
    if (state.token) h.Authorization = `Bearer ${state.token}`;
    return h;
  }
  async function request(path, options = {}) {
    const res = await fetch(apiPath(path), { ...options, headers: { ...headers(options.body !== undefined), ...(options.headers || {}) } });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { ok: false, error: text || `HTTP ${res.status}` }; }
    if (!res.ok || data.ok === false) {
      const error = new Error(data.error || `HTTP ${res.status}`);
      error.code = data.error || "HTTP_ERROR";
      error.status = res.status;
      throw error;
    }
    return data;
  }

  function nowIso() { return new Date().toISOString(); }
  function logPlaybackEvent(event, detail = {}) {
    const item = {
      at: nowIso(),
      event,
      position: Number(els.video?.currentTime || 0),
      readyState: Number(els.video?.readyState || 0),
      networkState: Number(els.video?.networkState || 0),
      message: String(detail.message || "").slice(0, 220)
    };
    state.playbackEvents.push(item);
    state.playbackEvents = state.playbackEvents.slice(-30);
    if (["waiting", "stalled", "error"].includes(event)) {
      const msg = item.message ? `：${item.message}` : "";
      els.playerState.textContent = `播放器事件：${event}${msg} · ${timeLabel(item.position)}`;
    }
  }
  function mediaErrorText() {
    const err = els.video && els.video.error;
    if (!err) return "";
    const map = { 1: "MEDIA_ERR_ABORTED", 2: "MEDIA_ERR_NETWORK", 3: "MEDIA_ERR_DECODE", 4: "MEDIA_ERR_SRC_NOT_SUPPORTED" };
    return `${map[err.code] || "MEDIA_ERR_UNKNOWN"}${err.message ? " · " + err.message : ""}`;
  }
  function playbackDebugPayload() {
    return {
      events: state.playbackEvents.slice(-24),
      range: state.playbackRange || { checked: false, ok: false, note: "本地文件或尚未检测 Range" },
      lastError: state.lastPlaybackError || ""
    };
  }
  async function checkRangeForSource(src) {
    if (!src || !/^https?:\/\//i.test(src)) {
      state.playbackRange = { checked: true, ok: true, note: "本地文件 / blob 播放，不需要 HTTP Range。若远程片源卡顿，请检查代理是否返回 206 Partial Content。" };
      return;
    }
    if (state.lastRangeCheckUrl === src) return;
    state.lastRangeCheckUrl = src;
    try {
      const res = await fetch(src, { method: "GET", headers: { Range: "bytes=0-1" } });
      state.playbackRange = {
        checked: true,
        ok: res.status === 206,
        status: res.status,
        acceptRanges: res.headers.get("accept-ranges") || "",
        contentRange: res.headers.get("content-range") || "",
        note: res.status === 206 ? "Range 可用" : "片源/代理可能不支持 Range，长视频可能出现播一小段就卡住。"
      };
    } catch (e) {
      state.playbackRange = { checked: true, ok: false, status: 0, note: `Range 检测失败：${e.message}` };
    }
  }


  function saveSettings() {
    state.serverUrl = cleanUrl(els.serverUrl.value) || cleanUrl(location.origin);
    state.token = els.token.value.trim();
    state.name = els.viewerName.value.trim() || "观影人A";
    state.assistantName = els.assistantName.value.trim() || "观影助手";
    localStorage.setItem("cineisle.settings", JSON.stringify({
      serverUrl: state.serverUrl, token: state.token, name: state.name, assistantName: state.assistantName, roomId: state.roomId
    }));
    setStatus("设置已保存。");
  }
  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem("cineisle.settings") || "{}"); } catch {}
    state.serverUrl = cleanUrl(s.serverUrl) || cleanUrl(location.origin);
    state.token = s.token || "";
    state.name = s.name || "观影人A";
    state.assistantName = s.assistantName || "观影助手";
    state.roomId = roomCode(s.roomId || "");
    els.serverUrl.value = state.serverUrl;
    els.token.value = state.token;
    els.viewerName.value = state.name;
    els.assistantName.value = state.assistantName;
    els.joinRoomInput.value = state.roomId;
    try { state.hall = JSON.parse(localStorage.getItem("cineisle.hall") || "[]"); } catch { state.hall = []; }
    renderHall();
  }
  function roomCacheKey(id) {
    return `cineisle.room.${roomCode(id)}`;
  }
  function roomSnapshot(room) {
    if (!room || !room.id) return null;
    return {
      id: roomCode(room.id),
      createdAt: room.createdAt || "",
      updatedAt: room.updatedAt || nowIso(),
      title: room.title || "未命名影片",
      fileName: room.fileName || "",
      duration: Number(room.duration || 0),
      currentTime: Number(room.currentTime || 0),
      paused: room.paused !== false,
      assistantName: room.assistantName || state.assistantName,
      partner: room.partner || state.name,
      mood: room.mood || "",
      inviteNote: room.inviteNote || "",
      messages: Array.isArray(room.messages) ? room.messages.slice(-80) : [],
      notes: Array.isArray(room.notes) ? room.notes.slice(-80) : [],
      card: room.card || null
    };
  }
  function loadRoomCache(id) {
    try {
      const cached = JSON.parse(localStorage.getItem(roomCacheKey(id)) || "null");
      return cached && cached.id ? cached : null;
    } catch { return null; }
  }
  function saveRoomCache(room) {
    const snapshot = roomSnapshot(room);
    if (!snapshot) return;
    try { localStorage.setItem(roomCacheKey(snapshot.id), JSON.stringify(snapshot)); } catch {}
  }
  function mergeCachedItems(cached, remote, max) {
    const items = new Map();
    for (const item of [...(Array.isArray(cached) ? cached : []), ...(Array.isArray(remote) ? remote : [])]) {
      if (!item || !item.text) continue;
      const key = String(item.id || `${item.at || ""}|${item.name || ""}|${item.text}`);
      items.set(key, item);
    }
    return Array.from(items.values())
      .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))
      .slice(-max);
  }
  function newerCard(cached, remote) {
    if (!cached) return remote || null;
    if (!remote) return cached;
    const cachedAt = Date.parse(cached.generatedAt || "") || 0;
    const remoteAt = Date.parse(remote.generatedAt || "") || 0;
    return remoteAt >= cachedAt ? remote : cached;
  }
  function mergeRoomWithCache(remote) {
    if (!remote || !remote.id) return remote;
    const cached = loadRoomCache(remote.id);
    if (!cached) return remote;
    const remoteHasPlayback = Number(remote.duration || 0) > 0 || Number(remote.currentTime || 0) > 0 || Boolean(remote.fileName);
    return {
      ...cached,
      ...remote,
      createdAt: cached.createdAt || remote.createdAt,
      title: remote.title && remote.title !== "未命名影片" ? remote.title : (cached.title || remote.title),
      fileName: remote.fileName || cached.fileName || "",
      duration: remoteHasPlayback ? Number(remote.duration || 0) : Number(cached.duration || 0),
      currentTime: remoteHasPlayback ? Number(remote.currentTime || 0) : Number(cached.currentTime || 0),
      paused: remoteHasPlayback ? remote.paused !== false : cached.paused !== false,
      assistantName: remote.assistantName && remote.assistantName !== "观影助手" ? remote.assistantName : (cached.assistantName || remote.assistantName),
      partner: remote.partner && remote.partner !== "观影人 A × 观影人 B" ? remote.partner : (cached.partner || remote.partner),
      mood: remote.mood && remote.mood !== "夜航" ? remote.mood : (cached.mood || remote.mood),
      inviteNote: remote.inviteNote && remote.inviteNote !== "今晚一起登岛看一场电影。" ? remote.inviteNote : (cached.inviteNote || remote.inviteNote),
      messages: mergeCachedItems(cached.messages, remote.messages, 80),
      notes: mergeCachedItems(cached.notes, remote.notes, 80),
      card: newerCard(cached.card, remote.card)
    };
  }
  function roomNeedsRestore(remote, merged) {
    if (!remote || !merged) return false;
    const remoteMessageIds = new Set((remote.messages || []).map(x => String(x.id || "")));
    const remoteNoteIds = new Set((remote.notes || []).map(x => String(x.id || "")));
    return (merged.messages || []).some(x => !remoteMessageIds.has(String(x.id || "")))
      || (merged.notes || []).some(x => !remoteNoteIds.has(String(x.id || "")))
      || (!remote.card && Boolean(merged.card))
      || ((Date.parse(merged.card?.generatedAt || "") || 0) > (Date.parse(remote.card?.generatedAt || "") || 0))
      || (!Number(remote.duration || 0) && Number(merged.duration || 0) > 0)
      || (remote.title === "未命名影片" && merged.title && merged.title !== remote.title);
  }
  function restoreRoomSnapshot(id, snapshot) {
    if (state.restorePromise) return state.restorePromise;
    state.restorePromise = request(`/api/rooms/${roomCode(id)}/restore`, {
      method: "POST",
      body: JSON.stringify({ room: roomSnapshot(snapshot), name: state.name, assistantName: state.assistantName })
    }).finally(() => { state.restorePromise = null; });
    return state.restorePromise;
  }
  function reconcileRoom(remote) {
    const merged = mergeRoomWithCache(remote);
    saveRoomCache(merged);
    if (roomNeedsRestore(remote, merged)) {
      restoreRoomSnapshot(remote.id, merged).then(data => {
        if (!data.room) return;
        const restored = mergeRoomWithCache(data.room);
        saveRoomCache(restored);
        state.room = restored;
        renderRoom(restored);
      }).catch(e => { els.playerState.textContent = `本地房间恢复失败：${e.message}`; });
    }
    return merged;
  }

  async function checkHealth() {
    saveSettings();
    els.healthState.textContent = "检查中";
    try {
      const data = await request("/api/health", { method: "GET" });
      els.healthState.textContent = data.tokenRequired ? "后端在线 · Token" : "后端在线";
      setStatus(`后端在线：${data.app || "CineIsle"}，版本 ${data.version || "unknown"}。`);
    } catch (e) {
      els.healthState.textContent = "连接失败";
      setStatus(`后端检查失败：${e.message}`);
    }
  }

  async function createRoom() {
    saveSettings();
    try {
      const title = els.videoFile.files[0]?.name?.replace(/\.[^.]+$/, "") || "映屿观影房间";
      const data = await request("/api/rooms", {
        method: "POST",
        body: JSON.stringify({ title, assistantName: state.assistantName, partner: state.name, mood: "夜航", inviteNote: "今晚一起登岛看一场电影。" })
      });
      enterRoom(data.room.id, data.room);
      setStatus(`房间已创建：${data.room.id}`);
    } catch (e) { setStatus(`创建失败：${e.message}`); }
  }
  async function joinRoom() {
    saveSettings();
    const id = roomCode(els.joinRoomInput.value);
    if (!id) return setStatus("先输入房间号。");
    try {
      const data = await request(`/api/rooms/${id}`, { method: "GET" });
      enterRoom(id, data.room);
      setStatus(`已加入房间：${id}`);
    } catch (e) {
      const cached = loadRoomCache(id);
      if (e.code === "ROOM_NOT_FOUND" && cached) {
        try {
          const data = await restoreRoomSnapshot(id, cached);
          enterRoom(id, data.room);
          setStatus(`房间 ${id} 已从本地记录恢复。`);
          return;
        } catch (restoreError) { setStatus(`恢复失败：${restoreError.message}`); return; }
      }
      setStatus(`加入失败：${e.message}`);
    }
  }
  function enterRoom(id, room) {
    state.roomId = roomCode(id);
    const cached = loadRoomCache(state.roomId);
    state.room = room ? reconcileRoom(room) : (cached || state.room);
    els.joinRoomInput.value = state.roomId;
    saveSettings();
    renderRoom(state.room);
    if (state.polling) clearInterval(state.polling);
    state.polling = setInterval(fetchRoom, 2500);
    if (state.contextTimer) clearInterval(state.contextTimer);
    state.contextTimer = setInterval(syncContextIfNeeded, 1200);
    fetchRoom();
  }
  async function fetchRoom() {
    if (!state.roomId) return;
    try {
      const data = await request(`/api/rooms/${state.roomId}`, { method: "GET" });
      state.room = reconcileRoom(data.room);
      renderRoom(state.room);
      applyRemotePlayback(state.room);
    } catch (e) {
      const cached = loadRoomCache(state.roomId);
      if (e.code === "ROOM_NOT_FOUND" && cached) {
        try {
          const data = await restoreRoomSnapshot(state.roomId, cached);
          state.room = reconcileRoom(data.room);
          renderRoom(state.room);
          els.playerState.textContent = "服务器重启后，已从本机恢复房间记录。";
          return;
        } catch (restoreError) { els.playerState.textContent = `房间恢复失败：${restoreError.message}`; return; }
      }
      els.playerState.textContent = `轮询失败：${e.message}`;
    }
  }

  function renderRoom(room) {
    if (!room) return;
    els.roomTitle.textContent = room.title || "映屿观影房间";
    els.roomBadge.textContent = `ROOM ${room.id || state.roomId}`;
    renderMessages(room.messages || []);
    renderNotes(room.notes || []);
    renderCard(room.card);
  }
  function chatIsNearBottom() {
    const remaining = els.chatLog.scrollHeight - els.chatLog.scrollTop - els.chatLog.clientHeight;
    return remaining < 48;
  }
  function scrollChatToBottom() {
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
    els.newMessagesBtn.hidden = true;
  }
  function renderMessages(messages) {
    const visibleMessages = messages.slice(-80);
    const messagesKey = visibleMessages.map(m => `${m.id || ""}:${m.name || ""}:${m.text || ""}`).join("|");
    if (messagesKey === state.lastMessagesKey) return;
    const wasNearBottom = chatIsNearBottom();
    const previousScrollTop = els.chatLog.scrollTop;
    state.lastMessagesKey = messagesKey;
    els.chatLog.innerHTML = "";
    visibleMessages.forEach(m => {
      const isDanmaku = String(m.text || "").startsWith("弹幕：");
      const text = isDanmaku ? String(m.text).replace(/^弹幕：/, "") : String(m.text || "");
      const item = document.createElement("div");
      item.className = "log-item";
      item.innerHTML = `<div class="log-meta">${escapeHtml(m.name || "观影人")} · ${isDanmaku ? "弹幕" : "聊天"}</div><div>${escapeHtml(text)}</div>`;
      els.chatLog.appendChild(item);
      if (isDanmaku && !state.seenMessages.has(m.id)) {
        state.seenMessages.add(m.id);
        if (state.danmakuOn) flyDanmaku(text);
      }
    });
    if (wasNearBottom) {
      scrollChatToBottom();
    } else {
      els.chatLog.scrollTop = previousScrollTop;
      els.newMessagesBtn.hidden = false;
    }
  }
  function renderNotes(notes) {
    els.noteLog.innerHTML = "";
    notes.slice(-80).forEach(n => {
      const item = document.createElement("div");
      item.className = "log-item";
      item.innerHTML = `<div class="log-meta">${escapeHtml(n.name || "观影人")} · ${timeLabel(n.time)}</div><div>${escapeHtml(n.text || "")}</div>`;
      els.noteLog.appendChild(item);
    });
    els.noteLog.scrollTop = els.noteLog.scrollHeight;
  }
  function renderCard(card) {
    if (!card) { els.cardPreview.textContent = "还没有卡片。"; return; }
    els.cardPreview.textContent = `《${card.title || "未命名影片"}》\n模板：${card.template || "ticket"}\n评分：${card.rating || ""}\n摘录：${card.quote || card.zhiQuote || ""}\n感想：${card.note || card.linNote || ""}\n生成时间：${card.generatedAt || ""}`;
  }
  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[ch]));
  }

  async function sendMessage(danmaku) {
    if (!state.roomId) return setStatus("先创建或加入房间。");
    const text = els.chatInput.value.trim();
    if (!text) return;
    els.chatInput.value = "";
    try {
      await request(`/api/rooms/${state.roomId}/message`, { method: "POST", body: JSON.stringify({ name: state.name, text, danmaku, assistantName: state.assistantName }) });
      fetchRoom();
    } catch (e) { setStatus(`发送失败：${e.message}`); }
  }
  async function addNote() {
    if (!state.roomId) return setStatus("先创建或加入房间。");
    const text = els.noteInput.value.trim();
    if (!text) return;
    els.noteInput.value = "";
    try {
      await request(`/api/rooms/${state.roomId}/note`, { method: "POST", body: JSON.stringify({ name: state.name, text, time: els.video.currentTime || 0, assistantName: state.assistantName }) });
      fetchRoom();
    } catch (e) { setStatus(`记笔记失败：${e.message}`); }
  }
  async function generateCard() {
    if (!state.roomId) return setStatus("先创建或加入房间。");
    try {
      await request(`/api/rooms/${state.roomId}/card`, {
        method: "POST",
        body: JSON.stringify({
          title: state.room?.title || currentVideoTitle(), template: els.cardTemplate.value,
          quote: els.quoteInput.value.trim(), note: els.cardNoteInput.value.trim(), rating: 4.5,
          assistantName: state.assistantName, partner: state.name
        })
      });
      fetchRoom();
    } catch (e) { setStatus(`生成卡片失败：${e.message}`); }
  }

  function currentVideoTitle() { return els.videoFile.files[0]?.name?.replace(/\.[^.]+$/, "") || state.room?.title || "未命名影片"; }
  function handleVideoFile(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    state.playbackEvents = [];
    state.lastPlaybackError = "";
    state.playbackRange = { checked: true, ok: true, note: "本地文件 / blob 播放，不需要 HTTP Range。" };
    logPlaybackEvent("import-file", { message: file.name });
    els.video.src = url;
    els.video.load();
    checkRangeForSource(url);
    els.playerState.textContent = `已导入影片：${file.name}`;
    rememberHall(file.name, 0);
    if (state.roomId) syncPlayback(true);
  }
  function rememberHall(fileName, pos) {
    if (!fileName) return;
    const title = fileName.replace(/\.[^.]+$/, "");
    state.hall = state.hall.filter(x => x.fileName !== fileName);
    state.hall.unshift({ fileName, title, lastPosition: Math.floor(pos || 0), updatedAt: new Date().toISOString() });
    state.hall = state.hall.slice(0, 20);
    localStorage.setItem("cineisle.hall", JSON.stringify(state.hall));
    renderHall();
  }
  function renderHall() {
    els.hallList.innerHTML = "";
    if (!state.hall.length) { els.hallList.innerHTML = `<div class="hall-item">还没有本机影片记录。</div>`; return; }
    state.hall.forEach(item => {
      const div = document.createElement("div");
      div.className = "hall-item";
      div.innerHTML = `<strong>${escapeHtml(item.title)}</strong><br><span class="small">${escapeHtml(item.fileName)} · 上次 ${timeLabel(item.lastPosition)} · ${new Date(item.updatedAt).toLocaleString()}</span>`;
      els.hallList.appendChild(div);
    });
  }

  async function syncPlayback(force = false) {
    if (!state.roomId || !els.video.src) return;
    const now = Date.now();
    if (!force && now - state.lastPlaybackSyncAt < 1500) return;
    state.lastPlaybackSyncAt = now;
    rememberHall(els.videoFile.files[0]?.name || state.room?.fileName || "本地影片", els.video.currentTime || 0);
    try {
      await request(`/api/rooms/${state.roomId}/playback`, {
        method: "POST",
        body: JSON.stringify({
          currentTime: els.video.currentTime || 0,
          duration: Number.isFinite(els.video.duration) ? els.video.duration : 0,
          paused: els.video.paused,
          title: currentVideoTitle(), fileName: els.videoFile.files[0]?.name || "",
          actor: state.name, assistantName: state.assistantName,
          playbackDebug: playbackDebugPayload()
        })
      });
    } catch (e) { els.playerState.textContent = `同步失败：${e.message}`; }
  }
  function applyRemotePlayback(room) {
    if (!room || !els.video.src || state.applyingRemote) return;
    if (room.lastActor === state.name) return;
    const sinceLocal = Date.now() - state.lastLocalPlaybackActionAt;
    const remoteTime = Number(room.currentTime || 0);
    const localTime = els.video.currentTime || 0;
    const diff = Math.abs(localTime - remoteTime);
    // 用户刚刚手动播放/暂停/拖动时，先别被旧房间状态立刻回拉。
    if (sinceLocal < 2600 && diff < 8) return;
    if (diff > 4) {
      state.applyingRemote = true;
      logPlaybackEvent("remote-seek", { message: `remote=${timeLabel(remoteTime)} local=${timeLabel(localTime)}` });
      els.video.currentTime = remoteTime;
      setTimeout(() => state.applyingRemote = false, 650);
    }
    if (typeof room.paused === "boolean" && room.paused !== els.video.paused && sinceLocal >= 2600) {
      state.applyingRemote = true;
      logPlaybackEvent(room.paused ? "remote-pause" : "remote-play");
      if (room.paused) els.video.pause(); else els.video.play().catch(() => {});
      setTimeout(() => state.applyingRemote = false, 650);
    }
  }

  async function handleSubtitleFile(file) {
    if (!file) return;
    try {
      const decoded = await decodeSubtitleFile(file);
      const parsed = parseSubtitle(decoded.text, file.name);
      state.subtitles = parsed.cues;
      if (parsed.cues.length) {
        els.contextState.textContent = `已导入字幕：${file.name}，共 ${parsed.cues.length} 条（${decoded.encoding}）。`;
      } else {
        els.contextState.textContent = `字幕导入 0 条：${parsed.hint}（读取编码：${decoded.encoding}）。`;
      }
    } catch (e) {
      state.subtitles = [];
      els.contextState.textContent = `字幕导入失败：${e.message}`;
    }
  }
  async function decodeSubtitleFile(file) {
    const buffer = await file.arrayBuffer();
    if (!buffer || !buffer.byteLength) throw new Error("文件为空");
    const bytes = new Uint8Array(buffer);
    const candidates = [];
    function push(enc, offset = 0) {
      try {
        const text = new TextDecoder(enc).decode(buffer.slice(offset));
        const normalized = normalizeSubtitleText(text);
        const parsed = parseSubtitle(normalized, file.name);
        const replacement = (normalized.match(/�/g) || []).length;
        const timeline = countTimelineLines(normalized);
        const cjk = (normalized.match(/[\u4e00-\u9fff]/g) || []).length;
        candidates.push({ encoding: enc, text: normalized, score: parsed.cues.length * 1000 + timeline * 20 + cjk - replacement * 30 });
      } catch {}
    }
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) push("utf-8", 3);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) push("utf-16le", 2);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) push("utf-16be", 2);
    ["utf-8", "gb18030", "gbk", "utf-16le", "utf-16be"].forEach(enc => push(enc, 0));
    candidates.sort((a,b) => b.score - a.score);
    const best = candidates[0];
    if (!best) throw new Error("编码读取失败");
    return best;
  }
  function normalizeSubtitleText(text) {
    return String(text || "")
      .replace(/^\uFEFF/, "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
  }
  function parseSubtitle(text, name) {
    const normalized = normalizeSubtitleText(text);
    const lower = String(name || "").toLowerCase();
    const cues = (lower.endsWith(".ass") || lower.endsWith(".ssa") || /\[Events\]/i.test(normalized)) ? parseAss(normalized) : parseSrtVtt(normalized);
    const finalCues = cues.length ? cues : parseSrtVtt(normalized);
    return { cues: finalCues, hint: subtitleImportHint(normalized, finalCues) };
  }
  function subtitleImportHint(text, cues) {
    if (!String(text || "").trim()) return "文件为空";
    const timeline = countTimelineLines(text);
    if (!timeline) return "已读到文本但未匹配时间轴，可能不是标准 SRT/VTT/ASS";
    if (!cues.length) return "匹配到时间轴但正文为空，可能字幕结构不规范或正文被隐藏字符干扰";
    return "解析成功";
  }
  function countTimelineLines(text) {
    return normalizeSubtitleText(text).split("\n").filter(l => /-->/.test(l)).length;
  }
  function parseTime(s) {
    const m = String(s || "").trim().replace(',', '.').match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?/);
    if (!m) return NaN;
    const h = Number(m[1] || 0), min = Number(m[2] || 0), sec = Number(m[3] || 0), ms = Number((m[4] || "0").padEnd(3, "0"));
    return h * 3600 + min * 60 + sec + ms / 1000;
  }
  function cleanAssText(s) {
    return String(s || "").replace(/\{[^}]*\}/g, "").replace(/\\N/g, "\n").replace(/\\h/g, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  }
  function parseAss(text) {
    return normalizeSubtitleText(text).split("\n").filter(l => /^Dialogue:/i.test(l)).map(line => {
      const parts = line.replace(/^Dialogue:\s*/i, "").split(",");
      if (parts.length < 10) return null;
      const start = parseTime(parts[1]);
      const end = parseTime(parts[2]);
      return { start, end, text: cleanAssText(parts.slice(9).join(",")) };
    }).filter(c => c && c.text && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start).sort((a,b) => a.start - b.start);
  }
  function parseSrtVtt(text) {
    const lines = normalizeSubtitleText(text).replace(/^WEBVTT[^\n]*(\n|$)/i, "").split("\n");
    const cues = [];
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i] || "";
      if (!rawLine.includes("-->")) continue;
      const [left, rightRaw] = rawLine.split("-->");
      const right = String(rightRaw || "").trim().split(/\s+/)[0];
      const start = parseTime(left);
      const end = parseTime(right);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = String(lines[j] || "").trim();
        const next = String(lines[j + 1] || "");
        if (line.includes("-->")) break;
        if (!line) {
          if (body.length) break;
          continue;
        }
        if (/^\d+$/.test(line) && next.includes("-->")) break;
        if (/^(NOTE|STYLE|REGION)(\s|$)/i.test(line)) continue;
        body.push(line.replace(/<[^>]+>/g, "").trim());
      }
      const textBody = body.filter(Boolean).join(" ").trim();
      if (textBody) cues.push({ start, end, text: textBody });
    }
    return cues.sort((a,b) => a.start - b.start);
  }
  function currentSubtitle() {
    const t = els.video.currentTime || 0;
    const cue = state.subtitles.find(c => t >= c.start && t <= c.end);
    return cue ? cue.text : "";
  }
  function recentSubtitles() {
    const t = els.video.currentTime || 0;
    return state.subtitles.filter(c => c.end <= t && c.end >= t - 45).slice(-8).map(c => c.text);
  }
  async function syncContextIfNeeded() {
    const text = currentSubtitle();
    els.subtitleOverlay.textContent = text;
    if (!state.roomId) return;
    const now = Date.now();
    if (now - state.lastContextAt < 2500 && text === state.lastSubtitleText) return;
    state.lastContextAt = now;
    state.lastSubtitleText = text;
    try {
      await request(`/api/rooms/${state.roomId}/context`, {
        method: "POST",
        body: JSON.stringify({
          currentTime: els.video.currentTime || 0,
          duration: Number.isFinite(els.video.duration) ? els.video.duration : 0,
          paused: els.video.paused,
          title: currentVideoTitle(), fileName: els.videoFile.files[0]?.name || "",
          currentSubtitle: text, recentSubtitles: recentSubtitles(), actor: state.name, assistantName: state.assistantName,
          playbackDebug: playbackDebugPayload()
        })
      });
      els.contextState.textContent = text ? `已同步字幕：${text.slice(0, 48)}` : "已同步播放上下文。";
    } catch (e) { els.contextState.textContent = `上下文同步失败：${e.message}`; }
  }
  async function captureFrame() {
    if (!state.roomId) return setStatus("先创建或加入房间。");
    if (!els.video.src || !els.video.videoWidth) return setStatus("先导入并播放一帧影片，再截图。");
    try {
      const canvas = document.createElement("canvas");
      const maxW = 720;
      const scale = Math.min(1, maxW / els.video.videoWidth);
      canvas.width = Math.max(1, Math.round(els.video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(els.video.videoHeight * scale));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(els.video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", .62);
      await request(`/api/rooms/${state.roomId}/screenshot`, {
        method: "POST",
        body: JSON.stringify({ dataUrl, width: canvas.width, height: canvas.height, source: "pwa-manual-frame", actor: state.name, assistantName: state.assistantName, ocrText: [currentSubtitle(), ...recentSubtitles()].filter(Boolean).join("\n"), note: "映屿 PWA 手动截取当前本地视频帧。" })
      });
      setStatus("当前画面已上传给 AI 看一眼。");
    } catch (e) { setStatus(`截图失败：${e.message}。iOS 浏览器可能限制当前视频帧读取。`); }
  }

  function flyDanmaku(text) {
    const d = document.createElement("div");
    d.className = "danmaku";
    d.textContent = text;
    d.style.top = `${10 + Math.random() * 65}%`;
    d.style.fontSize = `${15 + Math.random() * 7}px`;
    els.danmakuLayer.appendChild(d);
    setTimeout(() => d.remove(), 8500);
  }

  function bindTabs() {
    document.querySelectorAll(".tab").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
        document.querySelectorAll(".tab-page").forEach(x => x.classList.remove("active"));
        btn.classList.add("active");
        $(`tab-${btn.dataset.tab}`).classList.add("active");
      });
    });
  }
  function bindEvents() {
    $("saveSettingsBtn").addEventListener("click", saveSettings);
    $("healthBtn").addEventListener("click", checkHealth);
    $("createRoomBtn").addEventListener("click", createRoom);
    $("joinRoomBtn").addEventListener("click", joinRoom);
    $("sendChatBtn").addEventListener("click", () => sendMessage(false));
    $("sendDanmakuBtn").addEventListener("click", () => sendMessage(true));
    els.newMessagesBtn.addEventListener("click", scrollChatToBottom);
    els.chatLog.addEventListener("scroll", () => {
      if (chatIsNearBottom()) els.newMessagesBtn.hidden = true;
    }, { passive: true });
    $("addNoteBtn").addEventListener("click", addNote);
    $("generateCardBtn").addEventListener("click", generateCard);
    $("syncNowBtn").addEventListener("click", () => syncPlayback(true));
    $("captureFrameBtn").addEventListener("click", captureFrame);
    $("toggleDanmakuBtn").addEventListener("click", () => {
      state.danmakuOn = !state.danmakuOn;
      $("toggleDanmakuBtn").textContent = state.danmakuOn ? "弹幕 ON" : "弹幕 OFF";
    });
    els.videoFile.addEventListener("change", e => handleVideoFile(e.target.files[0]));
    els.subtitleFile.addEventListener("change", e => handleSubtitleFile(e.target.files[0]));
    els.video.addEventListener("loadedmetadata", () => { logPlaybackEvent("loadedmetadata"); checkRangeForSource(els.video.currentSrc || els.video.src); });
    els.video.addEventListener("canplay", () => logPlaybackEvent("canplay"));
    els.video.addEventListener("waiting", () => logPlaybackEvent("waiting"));
    els.video.addEventListener("stalled", () => logPlaybackEvent("stalled"));
    els.video.addEventListener("progress", () => logPlaybackEvent("progress"));
    els.video.addEventListener("error", () => { state.lastPlaybackError = mediaErrorText(); logPlaybackEvent("error", { message: state.lastPlaybackError }); syncPlayback(true); });
    els.video.addEventListener("play", () => { state.lastLocalPlaybackActionAt = Date.now(); logPlaybackEvent("play"); if (!state.applyingRemote) syncPlayback(true); });
    els.video.addEventListener("pause", () => { state.lastLocalPlaybackActionAt = Date.now(); logPlaybackEvent("pause"); if (!state.applyingRemote) syncPlayback(true); });
    els.video.addEventListener("seeked", () => { state.lastLocalPlaybackActionAt = Date.now(); logPlaybackEvent("seeked"); if (!state.applyingRemote) syncPlayback(true); });
    els.video.addEventListener("timeupdate", () => { if (Date.now() - state.lastTimeupdateLogAt > 5000) { state.lastTimeupdateLogAt = Date.now(); logPlaybackEvent("timeupdate"); } syncContextIfNeeded(); syncPlayback(false); });
    $("clearHallBtn").addEventListener("click", () => { state.hall = []; localStorage.removeItem("cineisle.hall"); renderHall(); });
    $("installTipBtn").addEventListener("click", () => els.installDialog.showModal());
    $("closeInstallDialog").addEventListener("click", () => els.installDialog.close());
    els.chatInput.addEventListener("keydown", e => { if (e.key === "Enter") sendMessage(false); });
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  }
  bindTabs();
  bindEvents();
  loadSettings();
  if (state.roomId) enterRoom(state.roomId, null);
})();
