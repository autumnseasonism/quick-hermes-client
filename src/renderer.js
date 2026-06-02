const api = window.quickHermes;

let state = { settings: {}, sessions: [] };
let activeSessionId = null;
let showAllSessions = false;
let sending = false;
let pendingClipboardImages = [];
let selectedExplicitly = false;
const runningSessionIds = new Set();

const isMacPlatform = navigator.platform.toUpperCase().includes("MAC");
const SEND_HINT = isMacPlatform ? "⌘ Enter" : "Ctrl Enter";

const appEl = document.getElementById("app");
const panel = document.getElementById("panel");
const settingsBtn = document.getElementById("settingsBtn");
const settingsView = document.getElementById("settingsView");
const chatView = document.getElementById("chatView");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const input = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const newSessionBtn = document.getElementById("newSessionBtn");
const messagesEl = document.getElementById("messages");
const sessionList = document.getElementById("sessionList");
const toggleAllBtn = document.getElementById("toggleAllBtn");
const statusLine = document.getElementById("statusLine");
const contextChips = document.getElementById("contextChips");
const apiBaseUrl = document.getElementById("apiBaseUrl");
const apiKey = document.getElementById("apiKey");
const idleMinutes = document.getElementById("idleMinutes");
const launchAtLogin = document.getElementById("launchAtLogin");

input.placeholder = `输入消息，按 ${SEND_HINT} 发送`;

function currentSession() {
  return state.sessions.find((session) => session.id === activeSessionId) || state.sessions[0] || null;
}

function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function isRunning(session) {
  return Boolean(session && (runningSessionIds.has(session.id) || session.messages?.some((msg) => msg.pending)));
}

function renderMessages() {
  const session = currentSession();
  messagesEl.innerHTML = "";
  if (!session || !session.messages.length) {
    const empty = document.createElement("div");
    empty.className = "message system";
    empty.textContent = "拖入文件夹可设置工作空间，拖入文件或粘贴图片会随下一条消息发送。";
    messagesEl.appendChild(empty);
  } else {
    for (const msg of session.messages) {
      const item = document.createElement("div");
      item.className = `message ${msg.role}`;
      item.textContent = msg.pending ? `${msg.content}\n▌` : msg.content;
      messagesEl.appendChild(item);
    }
  }
  if (isRunning(session)) {
    const indicator = document.createElement("div");
    indicator.className = "work-indicator";
    indicator.innerHTML = '<span class="pulse-dot"></span><span class="pulse-dot"></span><span class="pulse-dot"></span><span>Hermes 正在处理</span>';
    messagesEl.appendChild(indicator);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderSessions() {
  const sessions = showAllSessions ? state.sessions : state.sessions.slice(0, 3);
  sessionList.innerHTML = "";
  for (const session of sessions) {
    const button = document.createElement("button");
    button.className = `session-item ${session.id === activeSessionId ? "active" : ""}`;
    button.innerHTML = `<div class="session-title"></div><div class="session-meta"></div>`;
    button.querySelector(".session-title").textContent = session.title || "新会话";
    button.querySelector(".session-meta").textContent = `${formatTime(session.updatedAt)} · ${session.messages.length} 条`;
    button.addEventListener("click", () => {
      activeSessionId = session.id;
      selectedExplicitly = true;
      render();
    });
    sessionList.appendChild(button);
  }
  toggleAllBtn.textContent = showAllSessions ? "只看最近" : "展开全部";
}

function renderChips() {
  const session = currentSession();
  contextChips.innerHTML = "";
  const chips = [];
  if (session?.pendingWorkspacePath) chips.push(`工作空间：${session.pendingWorkspacePath}`);
  for (const filePath of session?.pendingAttachments || []) chips.push(`附件：${filePath}`);
  for (const imagePath of pendingClipboardImages) chips.push(`图片：${imagePath}`);
  for (const text of chips) {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.textContent = text;
    chip.title = text;
    contextChips.appendChild(chip);
  }
}

function renderSettings() {
  apiBaseUrl.value = state.settings.apiBaseUrl || "http://127.0.0.1:8642";
  apiKey.value = state.settings.apiKey || "";
  idleMinutes.value = state.settings.idleMinutes || 30;
  launchAtLogin.checked = Boolean(state.settings.launchAtLogin);
}

function renderStatus() {
  const session = currentSession();
  const running = state.sessions.some(isRunning) || runningSessionIds.size > 0 || sending;
  sendBtn.disabled = running && isRunning(session);
  statusLine.textContent = running ? "Hermes 正在处理任务" : (session ? session.title : "准备就绪");
}

function render() {
  if (!activeSessionId && state.sessions[0]) activeSessionId = state.sessions[0].id;
  renderMessages();
  renderSessions();
  renderChips();
  renderSettings();
  renderStatus();
}

function focusInput() {
  setTimeout(() => input.focus(), 60);
}

async function sendCurrentMessage() {
  const text = input.value.trim();
  if (!text || sending) return;
  sending = true;
  const provisionalSessionId = activeSessionId;
  if (provisionalSessionId) runningSessionIds.add(provisionalSessionId);
  sendBtn.disabled = true;
  render();
  try {
    const result = await api.sendMessage({
      sessionId: activeSessionId,
      text,
      imagePaths: pendingClipboardImages,
      forceContinue: selectedExplicitly,
    });
    state = result.state;
    if (provisionalSessionId && provisionalSessionId !== result.sessionId) {
      runningSessionIds.delete(provisionalSessionId);
    }
    activeSessionId = result.sessionId;
    runningSessionIds.add(activeSessionId);
    selectedExplicitly = false;
    pendingClipboardImages = [];
    input.value = "";
    render();
  } catch (error) {
    if (provisionalSessionId) runningSessionIds.delete(provisionalSessionId);
    statusLine.textContent = error.message || "发送失败";
  } finally {
    sending = false;
    renderStatus();
  }
}

async function handleDrop(event) {
  event.preventDefault();
  appEl.classList.remove("drop-ready");
  const paths = [...event.dataTransfer.files].map((file) => api.filePath(file)).filter(Boolean);
  if (!paths.length) return;
  const result = await api.dropPaths({ target: "panel", sessionId: activeSessionId, paths });
  state = result.state;
  activeSessionId = result.sessionId;
  render();
}

settingsBtn.addEventListener("click", () => {
  settingsView.classList.remove("hidden");
  chatView.classList.add("hidden");
});
closeSettingsBtn.addEventListener("click", () => {
  settingsView.classList.add("hidden");
  chatView.classList.remove("hidden");
});
saveSettingsBtn.addEventListener("click", async () => {
  state = await api.saveSettings({
    apiBaseUrl: apiBaseUrl.value,
    apiKey: apiKey.value,
    idleMinutes: idleMinutes.value,
    launchAtLogin: launchAtLogin.checked,
  });
  settingsView.classList.add("hidden");
  chatView.classList.remove("hidden");
  render();
});

sendBtn.addEventListener("click", sendCurrentMessage);
newSessionBtn.addEventListener("click", async () => {
  const result = await api.newSession({});
  state = result.state;
  activeSessionId = result.sessionId;
  pendingClipboardImages = [];
  render();
});
toggleAllBtn.addEventListener("click", () => {
  showAllSessions = !showAllSessions;
  renderSessions();
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) sendCurrentMessage();
});

document.addEventListener("paste", async () => {
  const imagePath = await api.saveClipboardImage();
  if (imagePath && !pendingClipboardImages.includes(imagePath)) {
    pendingClipboardImages.push(imagePath);
    renderChips();
  }
});

document.addEventListener("dragover", (event) => {
  event.preventDefault();
  appEl.classList.add("drop-ready");
});
document.addEventListener("dragleave", () => appEl.classList.remove("drop-ready"));
panel.addEventListener("drop", (event) => handleDrop(event));

window.addEventListener("blur", () => {
  api.collapse();
});

api.onStateChanged((nextState) => {
  state = nextState;
  render();
});
api.onRunEvent(({ sessionId, event }) => {
  if (event.event === "tool.started") statusLine.textContent = `正在使用工具：${event.tool || "工具"}`;
  if (event.event === "tool.completed") statusLine.textContent = `工具完成：${event.tool || "工具"}`;
  if (event.event === "run.completed") {
    runningSessionIds.delete(sessionId);
    statusLine.textContent = "任务已完成";
    render();
  }
  if (event.event === "run.failed") {
    runningSessionIds.delete(sessionId);
    statusLine.textContent = "任务失败";
    render();
  }
});
api.onOpenSession(({ sessionId }) => {
  activeSessionId = sessionId;
  selectedExplicitly = true;
  render();
  focusInput();
});
api.onPanelShown(({ sessionId, state: nextState }) => {
  if (nextState) state = nextState;
  if (sessionId) activeSessionId = sessionId;
  selectedExplicitly = false;
  render();
  focusInput();
});

api.getState().then((nextState) => {
  state = nextState;
  if (!state.sessions.length) {
    return api.newSession({}).then((result) => {
      state = result.state;
      activeSessionId = result.sessionId;
      render();
    });
  }
  activeSessionId = state.sessions[0].id;
  render();
});
