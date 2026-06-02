const api = window.quickHermes;

const appEl = document.getElementById("app");
const bubble = document.getElementById("bubble");
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
let currentTheme = "system";

function applyTheme(theme) {
  if (theme) currentTheme = theme;
  const dark = currentTheme === "dark" || (currentTheme === "system" && darkQuery.matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

function setRunning(running) {
  appEl.classList.toggle("is-running", Boolean(running));
}

function runningFromState(state) {
  return (state?.sessions || []).some((session) => (session.messages || []).some((msg) => msg.pending));
}

darkQuery.addEventListener("change", () => applyTheme());
api.onThemeChanged(({ theme }) => applyTheme(theme));
api.onBusyChanged(({ busy }) => setRunning(busy));
api.onStateChanged((state) => setRunning(runningFromState(state)));
api.getState().then((state) => {
  applyTheme(state && state.settings ? state.settings.theme : "system");
  setRunning(runningFromState(state));
});

bubble.addEventListener("click", () => api.expand());
bubble.addEventListener("mouseenter", () => api.expand());

document.addEventListener("dragover", (event) => {
  event.preventDefault();
  appEl.classList.add("drop-ready");
});
document.addEventListener("dragleave", () => appEl.classList.remove("drop-ready"));
bubble.addEventListener("drop", async (event) => {
  event.preventDefault();
  appEl.classList.remove("drop-ready");
  const paths = [...event.dataTransfer.files].map((file) => api.filePath(file)).filter(Boolean);
  if (paths.length) {
    await api.dropPaths({ target: "icon", paths });
  }
  api.expand();
});
