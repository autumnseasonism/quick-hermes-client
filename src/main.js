const { app, BrowserWindow, ipcMain, Notification, clipboard, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_SETTINGS = {
  apiBaseUrl: "http://127.0.0.1:8642",
  apiKey: "",
  idleMinutes: 30,
  launchAtLogin: false,
};

let mainWindow;
let storePath;
let attachmentDir;
let state = {
  settings: { ...DEFAULT_SETTINGS },
  sessions: [],
};
const activeRuns = new Map();

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
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

function loadState() {
  const userData = app.getPath("userData");
  storePath = path.join(userData, "quick-hermes-state.json");
  attachmentDir = path.join(userData, "attachments");
  fs.mkdirSync(attachmentDir, { recursive: true });
  const loaded = readJson(storePath, {});
  state = {
    settings: { ...DEFAULT_SETTINGS, ...(loaded.settings || {}) },
    sessions: Array.isArray(loaded.sessions) ? loaded.sessions : [],
  };
}

function saveState() {
  writeJson(storePath, state);
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

function updateWindowMode(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mode === "collapsed") {
    mainWindow.setSize(72, 72, true);
  } else {
    mainWindow.setSize(430, 640, true);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 72,
    height: 72,
    minWidth: 72,
    minHeight: 72,
    maxWidth: 560,
    maxHeight: 760,
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
  });
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadFile(path.join(__dirname, "renderer.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("blur", () => {
    updateWindowMode("collapsed");
    sendEvent("window-collapsed", {});
  });
}

function sendEvent(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function notifyCompleted(session) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: "Hermes 已完成",
    body: session.title || "会话任务完成，点击悬浮入口查看回复。",
    silent: false,
  });
  notification.on("click", () => {
    updateWindowMode("expanded");
    sendEvent("open-session", { sessionId: session.id });
  });
  notification.show();
}

async function readSse(runId, sessionId) {
  const url = `${state.settings.apiBaseUrl.replace(/\/$/, "")}/v1/runs/${runId}/events`;
  const response = await fetch(url, { headers: getHeaders() });
  if (!response.ok || !response.body) throw new Error(`事件流连接失败：HTTP ${response.status}`);

  const decoder = new TextDecoder();
  let buffer = "";
  let assistantMessageId = null;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice(6));
      const session = getSession(sessionId);
      if (!session) continue;
      if (event.event === "message.delta") {
        if (!assistantMessageId) {
          assistantMessageId = makeId("msg");
          session.messages.push({ id: assistantMessageId, role: "assistant", content: "", createdAt: nowIso(), pending: true });
        }
        const msg = session.messages.find((item) => item.id === assistantMessageId);
        if (msg) msg.content += event.delta || "";
        session.updatedAt = nowIso();
        saveState();
        sendEvent("state-changed", publicState());
      } else if (event.event === "tool.started" || event.event === "tool.completed" || event.event === "reasoning.available") {
        sendEvent("run-event", { sessionId, event });
      } else if (event.event === "run.completed") {
        if (!assistantMessageId && event.output) {
          assistantMessageId = makeId("msg");
          session.messages.push({ id: assistantMessageId, role: "assistant", content: event.output, createdAt: nowIso(), pending: false });
        }
        const msg = session.messages.find((item) => item.id === assistantMessageId);
        if (msg) {
          msg.pending = false;
          if (!msg.content && event.output) msg.content = event.output;
        }
        session.completedAt = nowIso();
        session.updatedAt = session.completedAt;
        saveState();
        activeRuns.delete(sessionId);
        sendEvent("state-changed", publicState());
        sendEvent("run-event", { sessionId, event });
        notifyCompleted(session);
      } else if (event.event === "run.failed") {
        session.messages.push({ id: makeId("msg"), role: "system", content: `运行失败：${event.error || "未知错误"}`, createdAt: nowIso() });
        session.completedAt = nowIso();
        session.updatedAt = session.completedAt;
        saveState();
        activeRuns.delete(sessionId);
        sendEvent("state-changed", publicState());
        sendEvent("run-event", { sessionId, event });
      }
    }
  }
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
  const response = await fetch(`${state.settings.apiBaseUrl.replace(/\/$/, "")}/v1/runs`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      input: fullText,
      session_id: session.hermesSessionId,
      conversation_history: history,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Hermes 请求失败：HTTP ${response.status} ${body}`);
  }
  const run = await response.json();
  activeRuns.set(session.id, run.run_id);
  readSse(run.run_id, session.id).catch((error) => {
    const failed = getSession(session.id);
    if (!failed) return;
    failed.messages.push({ id: makeId("msg"), role: "system", content: error.message, createdAt: nowIso() });
    failed.completedAt = nowIso();
    failed.updatedAt = failed.completedAt;
    activeRuns.delete(session.id);
    saveState();
    sendEvent("state-changed", publicState());
    sendEvent("run-event", { sessionId: session.id, event: { event: "run.failed", error: error.message } });
  });
  return { state: publicState(), sessionId: session.id };
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

app.whenReady().then(() => {
  loadState();
  createWindow();

  ipcMain.handle("app:get-state", () => publicState());
  ipcMain.handle("session:ensure-fresh", () => ensureFreshSession());
  ipcMain.handle("window:set-mode", (_event, mode) => updateWindowMode(mode));
  ipcMain.handle("session:new", (_event, seed) => {
    const session = newSession(seed || {});
    return { state: publicState(), sessionId: session.id };
  });
  ipcMain.handle("session:select", (_event, sessionId) => {
    if (!getSession(sessionId)) throw new Error("找不到该会话");
    return publicState();
  });
  ipcMain.handle("message:send", sendMessage);
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
    state.settings = {
      ...state.settings,
      apiBaseUrl: String(nextSettings.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl).replace(/\/$/, ""),
      apiKey,
      idleMinutes: Math.max(1, Number(nextSettings.idleMinutes || 30)),
      launchAtLogin: Boolean(nextSettings.launchAtLogin),
    };
    app.setLoginItemSettings({ openAtLogin: state.settings.launchAtLogin });
    saveState();
    return publicState();
  });
  ipcMain.handle("settings:login-item", () => app.getLoginItemSettings());
});

app.on("window-all-closed", (event) => event.preventDefault());

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
