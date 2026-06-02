const api = window.quickHermes;
const renderMarkdown =
  window.renderMarkdown ||
  ((text) => {
    const div = document.createElement("div");
    div.textContent = text == null ? "" : text;
    return div.innerHTML;
  });

let state = { settings: {}, sessions: [] };
let activeSessionId = null;
let showAllSessions = false;
let sending = false;
let pendingClipboardImages = [];
let selectedExplicitly = false;
let sessionQuery = "";
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
const sessionSearch = document.getElementById("sessionSearch");
const apiBaseUrl = document.getElementById("apiBaseUrl");
const apiKey = document.getElementById("apiKey");
const idleMinutes = document.getElementById("idleMinutes");
const launchAtLogin = document.getElementById("launchAtLogin");
const themeSelect = document.getElementById("themeSelect");
const hotkeyInput = document.getElementById("hotkeyInput");
const testConnBtn = document.getElementById("testConnBtn");
const testConnResult = document.getElementById("testConnResult");

input.placeholder = `输入消息，按 ${SEND_HINT} 发送`;

// --- theme ---
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme(theme) {
  const t = theme || state.settings.theme || "system";
  const dark = t === "dark" || (t === "system" && darkQuery.matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}
darkQuery.addEventListener("change", () => applyTheme());

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

function anyRunning() {
  return state.sessions.some(isRunning) || runningSessionIds.size > 0 || sending;
}

function currentSessionRunning() {
  const session = currentSession();
  return Boolean(session && isRunning(session));
}

function decorateCodeBlocks(container) {
  for (const pre of container.querySelectorAll("pre")) {
    const btn = document.createElement("button");
    btn.className = "code-copy";
    btn.textContent = "复制";
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const code = pre.querySelector("code");
      navigator.clipboard.writeText(code ? code.textContent : "").then(() => {
        btn.textContent = "已复制";
        setTimeout(() => (btn.textContent = "复制"), 1200);
      });
    });
    pre.appendChild(btn);
  }
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
      if (msg.role === "assistant") {
        item.classList.add("markdown");
        item.innerHTML = renderMarkdown(msg.content || "");
        if (msg.pending) {
          const cursor = document.createElement("span");
          cursor.className = "cursor";
          item.appendChild(cursor);
        }
        decorateCodeBlocks(item);
      } else {
        item.textContent = msg.content;
      }
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

function filteredSessions() {
  const q = sessionQuery.trim().toLowerCase();
  let list = state.sessions;
  if (q) {
    list = list.filter(
      (s) => (s.title || "").toLowerCase().includes(q) || (s.messages || []).some((m) => (m.content || "").toLowerCase().includes(q))
    );
  }
  return showAllSessions || q ? list : list.slice(0, 3);
}

function makeAction(label, title, onClick) {
  const button = document.createElement("button");
  button.className = "session-action";
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function startRename(session, row) {
  const titleEl = row.querySelector(".session-title");
  if (!titleEl) return;
  const box = document.createElement("input");
  box.className = "rename-input";
  box.value = session.title || "";
  titleEl.replaceWith(box);
  box.focus();
  box.select();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const value = box.value.trim();
    state = await api.renameSession({ sessionId: session.id, title: value || session.title });
    render();
  };
  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter") commit();
    else if (event.key === "Escape") {
      done = true;
      render();
    }
  });
  box.addEventListener("blur", commit);
}

async function removeSession(session) {
  if (!window.confirm(`删除会话「${session.title || "新会话"}」？此操作不可撤销。`)) return;
  state = await api.deleteSession(session.id);
  if (activeSessionId === session.id) activeSessionId = state.sessions[0] ? state.sessions[0].id : null;
  render();
}

async function exportSession(session) {
  const result = await api.exportSession(session.id);
  if (result && result.ok) statusLine.textContent = "已导出会话";
}

function renderSessions() {
  const sessions = filteredSessions();
  sessionList.innerHTML = "";
  for (const session of sessions) {
    const row = document.createElement("div");
    row.className = `session-item ${session.id === activeSessionId ? "active" : ""}`;

    const main = document.createElement("button");
    main.className = "session-main";
    main.innerHTML = `<div class="session-title"></div><div class="session-meta"></div>`;
    main.querySelector(".session-title").textContent = session.title || "新会话";
    main.querySelector(".session-meta").textContent = `${formatTime(session.updatedAt)} · ${session.messages.length} 条`;
    main.addEventListener("click", () => {
      activeSessionId = session.id;
      selectedExplicitly = true;
      render();
    });

    const actions = document.createElement("div");
    actions.className = "session-actions";
    actions.appendChild(makeAction("✎", "重命名", () => startRename(session, row)));
    actions.appendChild(makeAction("⤓", "导出", () => exportSession(session)));
    actions.appendChild(makeAction("✕", "删除", () => removeSession(session)));

    row.appendChild(main);
    row.appendChild(actions);
    sessionList.appendChild(row);
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
  themeSelect.value = state.settings.theme || "system";
  hotkeyInput.value = state.settings.hotkey || "";
}

function renderStatus() {
  const session = currentSession();
  const running = anyRunning();
  const thisRunning = currentSessionRunning();
  sendBtn.textContent = thisRunning ? "停止" : "发送";
  sendBtn.classList.toggle("stop", thisRunning);
  sendBtn.disabled = sending && !thisRunning;
  statusLine.textContent = running ? "Hermes 正在处理任务" : session ? session.title : "准备就绪";
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

function onSendButton() {
  if (currentSessionRunning()) {
    api.cancelRun(activeSessionId);
  } else {
    sendCurrentMessage();
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
    theme: themeSelect.value,
    hotkey: hotkeyInput.value,
  });
  applyTheme(state.settings.theme);
  settingsView.classList.add("hidden");
  chatView.classList.remove("hidden");
  render();
});
testConnBtn.addEventListener("click", async () => {
  testConnResult.textContent = "测试中…";
  testConnResult.className = "test-result";
  const result = await api.testConnection({ apiBaseUrl: apiBaseUrl.value });
  testConnResult.textContent = result.message;
  testConnResult.className = `test-result ${result.ok ? "ok" : "fail"}`;
});

sendBtn.addEventListener("click", onSendButton);
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
sessionSearch.addEventListener("input", () => {
  sessionQuery = sessionSearch.value;
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
  if (document.activeElement && document.activeElement.tagName === "INPUT" && document.activeElement.classList.contains("rename-input")) {
    return;
  }
  api.collapse();
});

api.onStateChanged((nextState) => {
  state = nextState;
  applyTheme();
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
    statusLine.textContent = event.error === "stopped" ? "已停止生成" : "任务失败";
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
  applyTheme();
  render();
  focusInput();
});
api.onThemeChanged(({ theme }) => applyTheme(theme));

api.getState().then((nextState) => {
  state = nextState;
  applyTheme();
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
