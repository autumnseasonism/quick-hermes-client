const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, clipboard, screen, safeStorage, globalShortcut, dialog, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const isMac = process.platform === "darwin";
const BUBBLE_SIZE = 72;
const PANEL_WIDTH = 430;
const PANEL_HEIGHT = 640;
const EDGE_MARGIN = 24;
const SAVE_DEBOUNCE_MS = 300;
const SSE_IDLE_TIMEOUT_MS = 90000;
const SSE_CONNECT_ATTEMPTS = 3;

const DEFAULT_SETTINGS = {
  apiBaseUrl: "http://127.0.0.1:8642",
  apiKey: "",
  idleMinutes: 30,
  launchAtLogin: false,
  theme: "system",
  hotkey: "CommandOrControl+Shift+H",
};

let bubbleWindow = null;
let panelWindow = null;
let tray = null;
let isQuitting = false;
let isDialogOpen = false;
let storePath;
let attachmentDir;
let saveTimer = null;
let registeredHotkey = "";
let state = {
  settings: { ...DEFAULT_SETTINGS },
  sessions: [],
};
// sessionId -> { runId, controller, idleTimedOut }. idleTimedOut distinguishes a
// timeout abort from a user-initiated cancel.
const activeRuns = new Map();

const hasInstanceLock = app.requestSingleInstanceLock();

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

// --- apiKey at-rest encryption (safeStorage). Plaintext in memory, ciphertext on disk. ---
function encryptApiKey(plain) {
  if (!plain) return "";
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(plain).toString("base64")}`;
    }
  } catch {
    // fall through to plaintext when encryption is unavailable (e.g. no keyring on Linux)
  }
  return plain;
}

function decryptApiKey(stored) {
  if (!stored || typeof stored !== "string") return "";
  if (!stored.startsWith("enc:")) return stored; // legacy plaintext — migrated on next save
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
  } catch {
    return "";
  }
}

function serializeState() {
  return {
    settings: { ...state.settings, apiKey: encryptApiKey(state.settings.apiKey) },
    sessions: state.sessions,
  };
}

function loadState() {
  const userData = app.getPath("userData");
  storePath = path.join(userData, "quick-hermes-state.json");
  attachmentDir = path.join(userData, "attachments");
  fs.mkdirSync(attachmentDir, { recursive: true });
  const loaded = readJson(storePath, {});
  state = {
    settings: {
      ...DEFAULT_SETTINGS,
      ...(loaded.settings || {}),
      apiKey: decryptApiKey(loaded.settings?.apiKey),
    },
    sessions: Array.isArray(loaded.sessions) ? loaded.sessions : [],
  };
}

// Debounced write to avoid blocking the main process on every streamed delta.
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeJson(storePath, serializeState());
  }, SAVE_DEBOUNCE_MS);
}

// Immediate write for important checkpoints (completion, settings, quit).
function flushState() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (storePath) writeJson(storePath, serializeState());
}

function publicState() {
  const settings = { ...state.settings, apiKey: state.settings.apiKey ? "********" : "" };
  return { settings, sessions: state.sessions };
}

function getHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (state.settings.apiKey) {
    headers.Authorization = `Bearer ${state.settings.apiKey}`;
    headers["X-Hermes-Session-Key"] = "quick-hermes-client";
  }
  return headers;
}

function getSession(sessionId) {
  return state.sessions.find((session) => session.id === sessionId);
}

function newSession(seed = {}) {
  const createdAt = nowIso();
  const session = {
    id: makeId("session"),
    hermesSessionId: makeId("qh"),
    title: seed.title || "新会话",
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    workspacePath: seed.workspacePath || "",
    pendingWorkspacePath: seed.workspacePath || "",
    pendingAttachments: seed.pendingAttachments || [],
    messages: [],
  };
  state.sessions.unshift(session);
  saveState();
  return session;
}

function latestUsableSession() {
  const latest = state.sessions[0];
  if (!latest || !latest.completedAt) return latest || newSession();
  const elapsedMs = Date.now() - new Date(latest.completedAt).getTime();
  const idleMs = Number(state.settings.idleMinutes || 30) * 60 * 1000;
  return elapsedMs > idleMs ? newSession() : latest;
}

function ensureFreshSession() {
  const session = latestUsableSession();
  return { state: publicState(), sessionId: session.id };
}

function summarizeTitle(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 28) : "新会话";
}

function buildUserContent(session, text, extra = {}) {
  const blocks = [];
  const workspacePath = extra.workspacePath || session.pendingWorkspacePath || "";
  const attachments = [...(session.pendingAttachments || []), ...(extra.attachments || [])];
  const images = [...(extra.images || [])];
  if (workspacePath) blocks.push(`当前会话的作业工作空间路径：\`${workspacePath}\``);
  for (const filePath of attachments) {
    blocks.push(`会话可能提到的附件文档路径：\`${filePath}\``);
  }
  for (const imagePath of images) {
    blocks.push(`会话可能提到的剪切板图片路径：\`${imagePath}\``);
  }
  blocks.push(String(text || "").trim());
  return blocks.filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Dual-window architecture (bubble + panel), toggled by show/hide.
// ---------------------------------------------------------------------------

function windowOptions(extra) {
  return {
    frame: false,
    transparent: true,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    title: "Quick Hermes",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    ...extra,
  };
}

function makeVisibleEverywhere(win) {
  if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

// Open external links (e.g. from rendered Markdown) in the system browser
// instead of spawning an in-app window.
function attachExternalLinkHandler(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

function createBubbleWindow() {
  bubbleWindow = new BrowserWindow(
    windowOptions({ width: BUBBLE_SIZE, height: BUBBLE_SIZE, minWidth: BUBBLE_SIZE, minHeight: BUBBLE_SIZE })
  );
  makeVisibleEverywhere(bubbleWindow);
  attachExternalLinkHandler(bubbleWindow);
  bubbleWindow.loadFile(path.join(__dirname, "bubble.html"));
  const primary = screen.getPrimaryDisplay().workArea;
  bubbleWindow.setPosition(
    Math.round(primary.x + primary.width - BUBBLE_SIZE - EDGE_MARGIN),
    Math.round(primary.y + EDGE_MARGIN)
  );
  bubbleWindow.once("ready-to-show", () => bubbleWindow.show());
  bubbleWindow.on("close", (event) => {
    if (!isQuitting) event.preventDefault();
  });
}

function createPanelWindow() {
  panelWindow = new BrowserWindow(
    windowOptions({ width: PANEL_WIDTH, height: PANEL_HEIGHT, minWidth: PANEL_WIDTH, minHeight: PANEL_HEIGHT })
  );
  makeVisibleEverywhere(panelWindow);
  attachExternalLinkHandler(panelWindow);
  panelWindow.loadFile(path.join(__dirname, "renderer.html"));
  panelWindow.on("blur", () => {
    // Don't collapse while a native modal (e.g. the export save dialog) is up.
    if (isDialogOpen) return;
    collapse();
  });
  panelWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      collapse();
    }
  });
}

function positionPanelNearBubble() {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  const b = bubbleWindow.getBounds();
  const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  let x = b.x;
  let y = b.y;
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - PANEL_WIDTH));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - PANEL_HEIGHT));
  panelWindow.setPosition(Math.round(x), Math.round(y));
}

function expand() {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  positionPanelNearBubble();
  if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.hide();
  panelWindow.show();
  panelWindow.focus();
  const session = latestUsableSession();
  sendEvent("panel-shown", { sessionId: session.id, state: publicState() });
}

function collapse() {
  if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) panelWindow.hide();
  if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.show();
}

function toggle() {
  if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) collapse();
  else expand();
}

function createTray() {
  tray = new Tray(path.join(__dirname, "..", "assets", "icon.png"));
  tray.setToolTip("Quick Hermes");
  const menu = Menu.buildFromTemplate([
    { label: "显示面板", click: () => expand() },
    { label: "隐藏到悬浮球", click: () => collapse() },
    { type: "separator" },
    {
      label: "退出 Quick Hermes",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => toggle());
  tray.on("double-click", () => expand());
}

function sendEvent(channel, payload) {
  for (const win of [bubbleWindow, panelWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function broadcastBusy() {
  sendEvent("busy-changed", { busy: activeRuns.size > 0 });
}

function notifyCompleted(session) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: "Hermes 已完成",
    body: session.title || "会话任务完成，点击悬浮入口查看回复。",
    silent: false,
  });
  notification.on("click", () => {
    expand();
    sendEvent("open-session", { sessionId: session.id });
  });
  notification.show();
}

function handleSseEvent(event, sessionId, ref) {
  const session = getSession(sessionId);
  if (!session) return;
  if (event.event === "message.delta") {
    if (!ref.assistantMessageId) {
      ref.assistantMessageId = makeId("msg");
      session.messages.push({ id: ref.assistantMessageId, role: "assistant", content: "", createdAt: nowIso(), pending: true });
    }
    const msg = session.messages.find((item) => item.id === ref.assistantMessageId);
    if (msg) msg.content += event.delta || "";
    session.updatedAt = nowIso();
    saveState();
    sendEvent("state-changed", publicState());
  } else if (event.event === "tool.started" || event.event === "tool.completed" || event.event === "reasoning.available") {
    sendEvent("run-event", { sessionId, event });
  } else if (event.event === "run.completed") {
    if (!ref.assistantMessageId && event.output) {
      ref.assistantMessageId = makeId("msg");
      session.messages.push({ id: ref.assistantMessageId, role: "assistant", content: event.output, createdAt: nowIso(), pending: false });
    }
    const msg = session.messages.find((item) => item.id === ref.assistantMessageId);
    if (msg) {
      msg.pending = false;
      if (!msg.content && event.output) msg.content = event.output;
    }
    session.completedAt = nowIso();
    session.updatedAt = session.completedAt;
    activeRuns.delete(sessionId);
    flushState();
    broadcastBusy();
    sendEvent("state-changed", publicState());
    sendEvent("run-event", { sessionId, event });
    notifyCompleted(session);
  } else if (event.event === "run.failed") {
    session.messages.push({ id: makeId("msg"), role: "system", content: `运行失败：${event.error || "未知错误"}`, createdAt: nowIso() });
    session.completedAt = nowIso();
    session.updatedAt = session.completedAt;
    activeRuns.delete(sessionId);
    flushState();
    broadcastBusy();
    sendEvent("state-changed", publicState());
    sendEvent("run-event", { sessionId, event });
  }
}

async function consumeStream(response, sessionId, run) {
  const decoder = new TextDecoder();
  let buffer = "";
  const ref = { assistantMessageId: null };
  let idleTimer = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      run.idleTimedOut = true;
      run.controller.abort();
    }, SSE_IDLE_TIMEOUT_MS);
  };
  resetIdle();
  try {
    for await (const chunk of response.body) {
      resetIdle();
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";
      for (const frame of frames) {
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        handleSseEvent(JSON.parse(dataLine.slice(6)), sessionId, ref);
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

// Connects to the run's event stream with limited connect-retry. Mid-stream we
// do NOT reconnect (would replay deltas → duplicates); instead an idle timeout
// aborts a stuck stream so the caller can surface a timeout.
async function streamRun(runId, sessionId, run) {
  const url = `${state.settings.apiBaseUrl.replace(/\/$/, "")}/v1/runs/${runId}/events`;
  let response = null;
  let attempt = 0;
  while (true) {
    if (run.controller.signal.aborted) throw new Error("aborted");
    try {
      response = await fetch(url, { headers: getHeaders(), signal: run.controller.signal });
      if (!response.ok || !response.body) throw new Error(`事件流连接失败：HTTP ${response.status}`);
      break;
    } catch (err) {
      if (run.controller.signal.aborted) throw err;
      if (++attempt >= SSE_CONNECT_ATTEMPTS) throw err;
      await delay(400 * attempt);
    }
  }
  await consumeStream(response, sessionId, run);
}

async function sendMessage(_event, payload) {
  const text = String(payload?.text || "").trim();
  if (!text) return publicState();
  let session = payload?.sessionId ? getSession(payload.sessionId) : latestUsableSession();
  if (session?.completedAt && !payload?.forceContinue) {
    const elapsedMs = Date.now() - new Date(session.completedAt).getTime();
    const idleMs = Number(state.settings.idleMinutes || 30) * 60 * 1000;
    if (elapsedMs > idleMs) session = newSession();
  }
  if (!session) session = newSession();
  if (activeRuns.has(session.id)) throw new Error("当前会话仍在执行中");

  const imagePaths = Array.isArray(payload.imagePaths) ? payload.imagePaths : [];
  const fullText = buildUserContent(session, text, { images: imagePaths });
  if (session.messages.length === 0) session.title = summarizeTitle(text);
  session.messages.push({ id: makeId("msg"), role: "user", content: fullText, createdAt: nowIso() });
  session.pendingAttachments = [];
  session.pendingWorkspacePath = "";
  session.completedAt = null;
  session.updatedAt = nowIso();
  saveState();
  sendEvent("state-changed", publicState());

  const history = session.messages
    .slice(0, -1)
    .filter((msg) => msg.role === "user" || msg.role === "assistant")
    .map((msg) => ({ role: msg.role, content: msg.content }));

  const run = { runId: null, controller: new AbortController(), idleTimedOut: false };

  const response = await fetch(`${state.settings.apiBaseUrl.replace(/\/$/, "")}/v1/runs`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      input: fullText,
      session_id: session.hermesSessionId,
      conversation_history: history,
    }),
    signal: run.controller.signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Hermes 请求失败：HTTP ${response.status} ${body}`);
  }
  const result = await response.json();
  run.runId = result.run_id;
  activeRuns.set(session.id, run);
  broadcastBusy();

  streamRun(result.run_id, session.id, run).catch((error) => {
    const failed = getSession(session.id);
    if (!failed) return;
    if (!activeRuns.has(session.id)) return; // already finalized by run.completed/failed
    const stoppedByUser = run.controller.signal.aborted && !run.idleTimedOut;
    const pending = failed.messages.find((msg) => msg.pending);
    if (pending) pending.pending = false;
    if (stoppedByUser) {
      failed.messages.push({ id: makeId("msg"), role: "system", content: "已停止生成", createdAt: nowIso() });
    } else {
      const reason = run.idleTimedOut ? "响应超时，请重试" : error.message;
      failed.messages.push({ id: makeId("msg"), role: "system", content: reason, createdAt: nowIso() });
    }
    failed.completedAt = nowIso();
    failed.updatedAt = failed.completedAt;
    activeRuns.delete(session.id);
    broadcastBusy();
    flushState();
    sendEvent("state-changed", publicState());
    sendEvent("run-event", {
      sessionId: session.id,
      event: { event: "run.failed", error: stoppedByUser ? "stopped" : run.idleTimedOut ? "timeout" : error.message },
    });
  });
  return { state: publicState(), sessionId: session.id };
}

function cancelRun(_event, sessionId) {
  const run = activeRuns.get(sessionId);
  if (run && run.controller) run.controller.abort();
  return publicState();
}

async function testConnection(_event, payload) {
  const base = String(payload?.apiBaseUrl || state.settings.apiBaseUrl || "").replace(/\/$/, "");
  if (!base) return { ok: false, message: "未配置 API 地址" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(base, { method: "GET", headers: getHeaders(), signal: controller.signal });
    clearTimeout(timer);
    return { ok: true, message: `已连接（HTTP ${res.status}）` };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, message: controller.signal.aborted ? "连接超时" : `连接失败：${err.message}` };
  }
}

function deleteSession(_event, sessionId) {
  const index = state.sessions.findIndex((session) => session.id === sessionId);
  if (index === -1) return publicState();
  const run = activeRuns.get(sessionId);
  if (run && run.controller) run.controller.abort();
  activeRuns.delete(sessionId);
  state.sessions.splice(index, 1);
  flushState();
  broadcastBusy();
  return publicState();
}

function renameSession(_event, payload) {
  const session = getSession(payload?.sessionId);
  if (!session) return publicState();
  const title = String(payload?.title || "").trim();
  if (title) session.title = title.slice(0, 60);
  session.updatedAt = nowIso();
  flushState();
  return publicState();
}

async function exportSession(_event, sessionId) {
  const session = getSession(sessionId);
  if (!session) return { ok: false, message: "找不到该会话" };
  const lines = [`# ${session.title || "会话"}`, ""];
  for (const msg of session.messages) {
    const who = msg.role === "user" ? "🧑 我" : msg.role === "assistant" ? "🤖 Hermes" : "ℹ️ 系统";
    lines.push(`## ${who}`, "", msg.content || "", "");
  }
  const safeName = (session.title || "session").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
  isDialogOpen = true;
  try {
    const result = await dialog.showSaveDialog(panelWindow || undefined, {
      title: "导出会话",
      defaultPath: `${safeName}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    fs.writeFileSync(result.filePath, lines.join("\n"), "utf8");
    return { ok: true, path: result.filePath };
  } finally {
    isDialogOpen = false;
  }
}

function classifyPaths(paths) {
  const folders = [];
  const files = [];
  for (const itemPath of paths || []) {
    try {
      const stat = fs.statSync(itemPath);
      if (stat.isDirectory()) folders.push(itemPath);
      else if (stat.isFile()) files.push(itemPath);
    } catch {
      files.push(itemPath);
    }
  }
  return { folders, files };
}

function saveClipboardImage() {
  const image = clipboard.readImage();
  if (!image || image.isEmpty()) return null;
  fs.mkdirSync(attachmentDir, { recursive: true });
  const filePath = path.join(attachmentDir, `clipboard-${Date.now()}.png`);
  fs.writeFileSync(filePath, image.toPNG());
  return filePath;
}

function registerHotkey(accelerator) {
  if (registeredHotkey) {
    globalShortcut.unregister(registeredHotkey);
    registeredHotkey = "";
  }
  const acc = String(accelerator || "").trim();
  if (!acc) return true;
  try {
    if (globalShortcut.register(acc, () => toggle())) {
      registeredHotkey = acc;
      return true;
    }
  } catch {
    // ignore invalid accelerators
  }
  return false;
}

if (!hasInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => expand());

  app.whenReady().then(() => {
    if (process.platform === "win32") app.setAppUserModelId("com.quickhermes.client");
    loadState();
    createBubbleWindow();
    createPanelWindow();
    createTray();
    registerHotkey(state.settings.hotkey);

    ipcMain.handle("app:get-state", () => publicState());
    ipcMain.handle("session:ensure-fresh", () => ensureFreshSession());
    ipcMain.handle("window:expand", () => expand());
    ipcMain.handle("window:collapse", () => collapse());
    ipcMain.handle("session:new", (_event, seed) => {
      const session = newSession(seed || {});
      return { state: publicState(), sessionId: session.id };
    });
    ipcMain.handle("session:select", (_event, sessionId) => {
      if (!getSession(sessionId)) throw new Error("找不到该会话");
      return publicState();
    });
    ipcMain.handle("session:delete", deleteSession);
    ipcMain.handle("session:rename", renameSession);
    ipcMain.handle("session:export", (event, sessionId) => exportSession(event, sessionId));
    ipcMain.handle("message:send", sendMessage);
    ipcMain.handle("run:cancel", cancelRun);
    ipcMain.handle("connection:test", testConnection);
    ipcMain.handle("clipboard:write-text", (_event, text) => {
      clipboard.writeText(String(text == null ? "" : text));
      return true;
    });
    ipcMain.handle("paths:drop", (_event, payload) => {
      const { folders, files } = classifyPaths(payload?.paths || []);
      let session = payload?.sessionId ? getSession(payload.sessionId) : null;
      if (folders.length && payload?.target === "icon") {
        session = newSession({ workspacePath: folders[0], title: path.basename(folders[0]) || "工作空间会话" });
      } else {
        session = session || latestUsableSession();
        if (folders.length) {
          if (!session.workspacePath) session.workspacePath = folders[0];
          session.pendingWorkspacePath = folders[0];
        }
        session.pendingAttachments = [...(session.pendingAttachments || []), ...files];
        session.updatedAt = nowIso();
        saveState();
      }
      return { state: publicState(), sessionId: session.id, folders, files };
    });
    ipcMain.handle("clipboard:save-image", () => saveClipboardImage());
    ipcMain.handle("settings:save", (_event, nextSettings) => {
      const apiKey = nextSettings.apiKey === "********" ? state.settings.apiKey : String(nextSettings.apiKey || "");
      const theme = ["system", "light", "dark"].includes(nextSettings.theme) ? nextSettings.theme : "system";
      const hotkey = String(nextSettings.hotkey || DEFAULT_SETTINGS.hotkey);
      state.settings = {
        ...state.settings,
        apiBaseUrl: String(nextSettings.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl).replace(/\/$/, ""),
        apiKey,
        idleMinutes: Math.max(1, Number(nextSettings.idleMinutes || 30)),
        launchAtLogin: Boolean(nextSettings.launchAtLogin),
        theme,
        hotkey,
      };
      app.setLoginItemSettings({ openAtLogin: state.settings.launchAtLogin, path: process.execPath });
      registerHotkey(hotkey);
      flushState();
      sendEvent("theme-changed", { theme });
      return publicState();
    });
    ipcMain.handle("settings:login-item", () => app.getLoginItemSettings());

    app.on("activate", () => {
      if (!bubbleWindow || bubbleWindow.isDestroyed()) {
        createBubbleWindow();
        createPanelWindow();
      } else {
        collapse();
      }
    });
  });

  app.on("before-quit", () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    flushState();
  });

  app.on("window-all-closed", (event) => {
    if (!isQuitting) event.preventDefault();
  });
}
