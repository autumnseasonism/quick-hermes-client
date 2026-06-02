const { contextBridge, ipcRenderer, webUtils } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("quickHermes", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  expand: () => ipcRenderer.invoke("window:expand"),
  collapse: () => ipcRenderer.invoke("window:collapse"),
  ensureFreshSession: () => ipcRenderer.invoke("session:ensure-fresh"),
  newSession: (seed) => ipcRenderer.invoke("session:new", seed),
  deleteSession: (sessionId) => ipcRenderer.invoke("session:delete", sessionId),
  renameSession: (payload) => ipcRenderer.invoke("session:rename", payload),
  exportSession: (sessionId) => ipcRenderer.invoke("session:export", sessionId),
  sendMessage: (payload) => ipcRenderer.invoke("message:send", payload),
  cancelRun: (sessionId) => ipcRenderer.invoke("run:cancel", sessionId),
  testConnection: (payload) => ipcRenderer.invoke("connection:test", payload),
  copyText: (text) => ipcRenderer.invoke("clipboard:write-text", text),
  dropPaths: (payload) => ipcRenderer.invoke("paths:drop", payload),
  saveClipboardImage: () => ipcRenderer.invoke("clipboard:save-image"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  filePath: (file) => webUtils.getPathForFile(file),
  onStateChanged: (callback) => subscribe("state-changed", callback),
  onRunEvent: (callback) => subscribe("run-event", callback),
  onOpenSession: (callback) => subscribe("open-session", callback),
  onPanelShown: (callback) => subscribe("panel-shown", callback),
  onBusyChanged: (callback) => subscribe("busy-changed", callback),
  onThemeChanged: (callback) => subscribe("theme-changed", callback),
});
