const api = window.quickHermes;

const appEl = document.getElementById("app");
const bubble = document.getElementById("bubble");

function setRunning(running) {
  appEl.classList.toggle("is-running", Boolean(running));
}

function runningFromState(state) {
  return (state?.sessions || []).some((session) => (session.messages || []).some((msg) => msg.pending));
}

// Busy ring reflects whether any run is in flight. busy-changed is the precise
// signal from main; state-changed is a fallback for pending streamed messages.
api.getState().then((state) => setRunning(runningFromState(state)));
api.onBusyChanged(({ busy }) => setRunning(busy));
api.onStateChanged((state) => setRunning(runningFromState(state)));

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
