const ui = {
  project: document.getElementById("project"),
  scene: document.getElementById("scene"),
  sceneSelect: document.getElementById("sceneSelect"),
  refreshScenes: document.getElementById("refreshScenes"),
  export: document.getElementById("export"),
  state: document.getElementById("state"),
  viewer: document.getElementById("viewer"),
  log: document.getElementById("log"),
};
let currentJob = null;

init();

async function init() {
  const defaults = await getJson("/api/defaults");
  ui.project.value = defaults.project;
  fillScenes(defaults.scenes, defaults.scene);
  ui.scene.value = defaults.scene;
  bind();
}

function bind() {
  ui.sceneSelect.addEventListener("change", () => { ui.scene.value = ui.sceneSelect.value; });
  ui.refreshScenes.addEventListener("click", refreshScenes);
  ui.export.addEventListener("click", startExport);
}

async function refreshScenes() {
  setState("Scanning scenes");
  const data = await getJson(`/api/scenes?project=${encodeURIComponent(ui.project.value)}`);
  fillScenes(data.scenes, data.scenes[0] || "");
  ui.scene.value = ui.sceneSelect.value;
  setState("Idle");
}

async function startExport() {
  ui.export.disabled = true;
  ui.log.textContent = "Starting export...\n";
  setState("Running");
  ui.viewer.textContent = "viewer not ready";
  ui.viewer.href = "#";
  const data = await postJson("/api/export", { project: ui.project.value, scene: ui.scene.value });
  if (data.error) {
    ui.log.textContent += data.error;
    setState("Error");
    ui.export.disabled = false;
    return;
  }
  currentJob = data.jobId;
  pollJob();
}

async function pollJob() {
  if (!currentJob) return;
  const job = await getJson(`/api/jobs/${currentJob}`);
  ui.log.textContent = job.log || "";
  ui.log.scrollTop = ui.log.scrollHeight;
  setState(job.status);
  if (job.viewerUrl) {
    ui.viewer.href = job.viewerUrl;
    ui.viewer.textContent = job.status === "complete" ? job.viewerUrl : "will open when complete";
  }
  if (job.status === "running") {
    setTimeout(pollJob, 1000);
    return;
  }
  ui.export.disabled = false;
}

function fillScenes(scenes, selected) {
  ui.sceneSelect.innerHTML = "";
  for (const scene of scenes) {
    const option = document.createElement("option");
    option.value = scene;
    option.textContent = scene;
    option.selected = scene === selected;
    ui.sceneSelect.appendChild(option);
  }
}

function setState(value) {
  ui.state.textContent = value;
}

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}