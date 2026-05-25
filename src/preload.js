const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("quickHermes", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  setWindowMode: (mode) => ipcRenderer.invoke("window:set-mode", mode),
  ensureFreshSession: () => ipcRenderer.invoke("session:ensure-fresh"),
  newSession: (seed) => ipcRenderer.invoke("session:new", seed),
  sendMessage: (payload) => ipcRenderer.invoke("message:send", payload),
  dropPaths: (payload) => ipcRenderer.invoke("paths:drop", payload),
  saveClipboardImage: () => ipcRenderer.invoke("clipboard:save-image"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  filePath: (file) => webUtils.getPathForFile(file),
  onStateChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("state-changed", listener);
    return () => ipcRenderer.removeListener("state-changed", listener);
  },
  onRunEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("run-event", listener);
    return () => ipcRenderer.removeListener("run-event", listener);
  },
  onOpenSession: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("open-session", listener);
    return () => ipcRenderer.removeListener("open-session", listener);
  },
  onWindowCollapsed: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("window-collapsed", listener);
    return () => ipcRenderer.removeListener("window-collapsed", listener);
  },
});
