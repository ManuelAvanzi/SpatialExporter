const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const toolRoot = path.resolve(__dirname, "..");
const exporterCli = path.join(toolRoot, "spatialExporter.js");
const defaultProject = path.resolve(__dirname, "..", "..", "..");
const port = Number(process.env.PORT || 5178);
const jobs = new Map();
let nextJobId = 1;

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (req.method === "GET" && url.pathname === "/api/defaults") return json(res, defaults());
    if (req.method === "GET" && url.pathname === "/api/scenes") return json(res, { scenes: findScenes(url.searchParams.get("project") || defaultProject) });
    if (req.method === "POST" && url.pathname === "/api/export") return startExport(req, res);
    if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) return getJob(url, res);
    return serveStatic(url, res);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, () => {
  console.log(`spatialExporter launcher: http://localhost:${port}/`);
});

function defaults() {
  const scenes = findScenes(defaultProject);
  return {
    project: defaultProject,
    scene: scenes.includes("Assets/Examples/BODYLAB3/BodyLab3_Scene.unity") ? "Assets/Examples/BODYLAB3/BodyLab3_Scene.unity" : scenes[0] || "",
    scenes,
    viewerBaseUrl: "http://localhost:5177",
  };
}

function findScenes(projectRoot) {
  const assets = path.join(projectRoot, "Assets");
  if (!fs.existsSync(assets)) return [];
  const results = [];
  const stack = [assets];
  while (stack.length && results.length < 400) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!["Library", "Temp", "Obj"].includes(entry.name)) stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".unity")) {
        results.push(toUnityPath(path.relative(projectRoot, full)));
      }
    }
  }
  return results.sort();
}

async function startExport(req, res) {
  const body = await readJson(req);
  const project = path.resolve(String(body.project || defaultProject));
  const scene = String(body.scene || "");
  if (!scene) return json(res, { error: "Scene is required" }, 400);
  if (!fs.existsSync(path.join(project, "ProjectSettings", "ProjectVersion.txt"))) return json(res, { error: "ProjectSettings/ProjectVersion.txt not found" }, 400);
  if (!fs.existsSync(path.join(project, scene))) return json(res, { error: `Scene not found: ${scene}` }, 400);

  const sceneName = sanitize(path.basename(scene, path.extname(scene)));
  const viewer = path.join(project, "ThreeExport", `${sceneName}_Viewer`);
  const log = path.join(project, "Logs", "spatialExporter.launcher.log");
  const id = String(nextJobId++);
  const job = {
    id,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    project,
    scene,
    viewer,
    viewerUrl: `http://localhost:5177/${sceneName}_Viewer/`,
    log: [],
    exitCode: null,
  };
  jobs.set(id, job);

  const child = spawn(process.execPath, [exporterCli, "--project", project, "--scene", scene, "--viewer", viewer, "--log", log], {
    cwd: toolRoot,
    windowsHide: true,
  });

  const push = (chunk) => {
    const text = chunk.toString();
    job.log.push(text);
    if (job.log.join("").length > 60000) job.log = [job.log.join("").slice(-60000)];
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("error", (error) => {
    job.status = "error";
    job.finishedAt = new Date().toISOString();
    job.log.push(`\n${error.message}\n`);
  });
  child.on("close", (code) => {
    job.exitCode = code;
    job.status = code === 0 ? "complete" : "error";
    job.finishedAt = new Date().toISOString();
  });

  json(res, { jobId: id, viewerUrl: job.viewerUrl });
}

function getJob(url, res) {
  const id = url.pathname.split("/").pop();
  const job = jobs.get(id);
  if (!job) return json(res, { error: "Job not found" }, 404);
  json(res, { ...job, log: job.log.join("") });
}

function serveStatic(url, res) {
  let filePath = path.join(__dirname, "public", url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
  filePath = path.normalize(filePath);
  const publicRoot = path.join(__dirname, "public");
  if (!filePath.startsWith(publicRoot)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": types[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function toUnityPath(value) {
  return value.replace(/\\/g, "/");
}

function sanitize(value) {
  return value.replace(/[^a-z0-9_.-]+/gi, "_");
}