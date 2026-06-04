#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const args = parseArgs(process.argv.slice(2));
const toolRoot = __dirname;
const project = path.resolve(args.project || process.cwd());
const scene = args.scene || "Assets/Examples/BODYLAB3/BodyLab3_Scene.unity";
const sceneName = sanitize(path.basename(scene, path.extname(scene)));
const exportDir = path.resolve(args.out || path.join(project, "ThreeExport", `${sceneName}_Physical`));
const viewerDir = path.resolve(args.viewer || path.join(project, "ThreeExport", `${sceneName}_Viewer`));
const templateViewer = path.resolve(args.template || path.join(toolRoot, "viewer-template"));
const unity = path.resolve(args.unity || findUnityEditor());
const metadataOnly = Boolean(args["metadata-only"]);
const logFile = path.resolve(args.log || path.join(project, "Logs", "spatialExporter.log"));
const bundledBridge = path.join(toolRoot, "unity", "SpatialThreePhysicalExporter.cs");

ensureProject(project);
ensureFile(path.join(project, scene));
ensureFile(unity);
const bridge = ensureUnityBridge(project, bundledBridge, Boolean(args["force-install"]));

console.log("spatialExporter physical export");
console.log(`Project : ${project}`);
console.log(`Scene   : ${scene}`);
console.log(`Unity   : ${unity}`);
console.log(`Export  : ${exportDir}`);
console.log(`Viewer  : ${viewerDir}`);
console.log(`Bridge  : ${bridge.path}${bridge.installed ? " (installed)" : ""}`);

fs.mkdirSync(path.dirname(logFile), { recursive: true });
if (metadataOnly) {
  console.log("Unity step skipped (--metadata-only).");
} else {
  const unityArgs = [
    "-quit",
    "-batchmode",
    "-nographics",
    "-projectPath", project,
    "-executeMethod", "SpatialThreePhysicalExporter.ExportFromSpatialExporterArgs",
    "-spatialScene", scene,
    "-spatialOut", exportDir,
    "-logFile", logFile,
  ];
  const result = spawnSync(unity, unityArgs, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`Unity export failed with code ${result.status}. Log: ${logFile}`);
    process.exit(result.status || 1);
  }
}

const sceneJson = path.join(exportDir, "scene.json");
ensureFile(sceneJson);
const rawScene = readJsonFile(sceneJson);
const spatialScene = buildSpatialScene(rawScene, { project, scene, exportDir, viewerDir });
const webxrRuntime = buildWebXrRuntime(spatialScene);
fs.writeFileSync(path.join(exportDir, "spatial.scene.json"), JSON.stringify(spatialScene, null, 2));
fs.writeFileSync(path.join(exportDir, "webxr.runtime.json"), JSON.stringify(webxrRuntime, null, 2));
copyViewer(templateViewer, viewerDir, exportDir);
writeManifest(project, scene, exportDir, viewerDir, logFile);

console.log("Done.");
console.log(`Open viewer: ${viewerDir}`);
console.log(`Serve from : ${path.dirname(viewerDir)}`);

function parseArgs(items) {
  const out = {};
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = items[i + 1];
    out[key] = next && !next.startsWith("--") ? items[++i] : true;
  }
  return out;
}

function ensureProject(dir) {
  ensureFile(path.join(dir, "ProjectSettings", "ProjectVersion.txt"));
  ensureFile(path.join(dir, "Assets"));
}

function ensureUnityBridge(projectRoot, bridgeSource, forceInstall) {
  ensureFile(bridgeSource);
  const existing = findUnityBridge(projectRoot);
  if (existing && !forceInstall) return { path: existing, installed: false };

  const targetDir = path.join(projectRoot, "Assets", "Editor");
  const target = path.join(targetDir, "SpatialThreePhysicalExporter.cs");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(bridgeSource, target);
  return { path: target, installed: true };
}

function findUnityBridge(projectRoot) {
  const editorDir = path.join(projectRoot, "Assets", "Editor");
  if (!fs.existsSync(editorDir)) return null;
  const stack = [editorDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".cs")) continue;
      const source = fs.readFileSync(full, "utf8");
      if (source.includes("class SpatialThreePhysicalExporter") && source.includes("ExportFromSpatialExporterArgs")) {
        return full;
      }
    }
  }
  return null;
}

function ensureFile(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing: ${file}`);
}

function findUnityEditor() {
  const base = "C:/Program Files/Unity/Hub/Editor";
  const preferred = ["2021.3.21f1", "2022.3.38f1", "2022.3.15f1", "6000.0.24f1", "2021.2.19f1"];
  for (const version of preferred) {
    const exe = path.join(base, version, "Editor", "Unity.exe");
    if (fs.existsSync(exe)) return exe;
  }
  if (!fs.existsSync(base)) throw new Error("Unity Hub editor folder not found. Pass --unity <Unity.exe>.");
  const versions = fs.readdirSync(base).sort().reverse();
  for (const version of versions) {
    const exe = path.join(base, version, "Editor", "Unity.exe");
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error("No Unity.exe found. Pass --unity <Unity.exe>.");
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function buildSpatialScene(raw, context) {
  const materials = new Map();
  const entrancePoints = buildEntrancePoints(raw.entrancePoints || []);
  const nodes = (raw.objects || []).map((object, index) => {
    const materialIds = (object.materials || []).map((material) => registerMaterial(materials, material));
    return {
      id: `node_${String(index).padStart(4, "0")}`,
      name: object.name || "",
      path: object.hierarchyPath || object.name || "",
      tag: object.tag || "",
      layer: Number.isFinite(object.layer) ? object.layer : 0,
      layerName: object.layerName || "",
      isStatic: Boolean(object.isStatic),
      kind: classifyNode(object),
      sourceType: object.sourceType || "",
      mesh: object.mesh || "",
      materialIds,
      transform: object.transform || null,
      colliders: object.colliders || [],
      rigidbody: normalizeRigidbody(object.rigidbody),
      flags: nodeFlags(object),
    };
  });
  const colliderCount = nodes.reduce((sum, node) => sum + node.colliders.length, 0);
  const triggerColliderCount = nodes.reduce((sum, node) => sum + node.colliders.filter((collider) => collider.isTrigger).length, 0);
  const texturedMaterials = [...materials.values()].filter((material) => material.texture || material.normalTexture).length;
  return {
    schema: "spatialExporter.scene.v0",
    mode: "physical",
    generatedAtUtc: new Date().toISOString(),
    source: {
      project: context.project,
      scene: context.scene,
      unityVersion: raw.unityVersion || "",
      exportedAtUtc: raw.exportedAtUtc || "",
      coordinateSystem: raw.coordinateSystem || "",
    },
    stats: {
      nodes: nodes.length,
      meshes: nodes.filter((node) => Boolean(node.mesh)).length,
      colliders: colliderCount,
      solidColliders: colliderCount - triggerColliderCount,
      triggerColliders: triggerColliderCount,
      rigidbodies: nodes.filter((node) => node.rigidbody?.hasRigidbody).length,
      materials: materials.size,
      texturedMaterials,
      lights: raw.lighting?.lights?.length || 0,
      entrancePoints: entrancePoints.length,
    },
    nodes,
    entrancePoints,
    materials: [...materials.values()],
    lights: raw.lighting?.lights || [],
    lighting: raw.lighting || null,
    webxr: {
      units: "meters",
      coordinateSystem: "right-handed x,y,-z",
      physicalOnly: true,
      interactions: {
        teleport: nodes.filter((node) => node.flags.teleport).map((node) => node.id),
        triggers: nodes.filter((node) => node.flags.trigger).map((node) => node.id),
        collectibles: nodes.filter((node) => node.flags.collectible).map((node) => node.id),
      },
      player: {
        entrancePoints: entrancePoints.map((point) => point.id),
      },
    },
  };
}

function buildEntrancePoints(points) {
  return points.map((point, index) => ({
    id: `entrance_${String(index).padStart(3, "0")}`,
    name: point.name || "Entrance Point",
    path: point.hierarchyPath || point.name || "",
    tag: point.tag || "",
    layer: Number.isFinite(point.layer) ? point.layer : 0,
    layerName: point.layerName || "",
    transform: point.transform || null,
    position: roundVec(point.transform?.position || [0, 0, 0]),
    rotationEuler: roundVec(point.transform?.rotationEuler || [0, 0, 0]),
    matrix: Array.isArray(point.transform?.matrix) ? point.transform.matrix.map(roundNumber) : [],
    radius: roundNumber(point.radius || 0),
  }));
}

function registerMaterial(materials, material) {
  const key = `${material.name || "material"}|${material.shader || ""}|${material.texture || ""}`;
  if (materials.has(key)) return materials.get(key).id;
  const id = `mat_${String(materials.size).padStart(3, "0")}`;
  const normalTexture = findMaterialTexture(material, ["normal", "bump"]);
  const item = {
    id,
    name: material.name || "material",
    shader: material.shader || "",
    color: material.color || [1, 1, 1, 1],
    texture: material.texture || "",
    normalTexture,
    transparent: Boolean(material.isTransparent),
    renderQueue: material.renderQueue ?? 2000,
    semantic: classifyMaterial(material),
  };
  materials.set(key, item);
  return id;
}

function findMaterialTexture(material, needles) {
  const props = material.properties || [];
  const found = props.find((prop) => {
    const label = `${prop.name || ""} ${prop.label || ""}`.toLowerCase();
    return prop.type === "Texture" && prop.texture && needles.some((needle) => label.includes(needle));
  });
  return found?.texture || "";
}

function classifyNode(object) {
  const text = `${object.hierarchyPath || ""} ${object.name || ""}`.toLowerCase();
  const hasTriggerCollider = (object.colliders || []).some((collider) => collider?.isTrigger);
  if (text.includes("teleport")) return "teleportPhysical";
  if (text.includes("collectable") || text.includes("collectible")) return "collectiblePhysical";
  if (text.includes("trigger") || hasTriggerCollider) return "triggerPhysical";
  if (object.sourceType === "ColliderOnly") return "collider";
  return object.mesh ? "mesh" : "node";
}

function nodeFlags(object) {
  const text = `${object.hierarchyPath || ""} ${object.name || ""}`.toLowerCase();
  const colliders = object.colliders || [];
  const hasTriggerCollider = colliders.some((collider) => collider?.isTrigger);
  const hasSolidCollider = colliders.some((collider) => !collider?.isTrigger);
  return {
    teleport: text.includes("teleport"),
    trigger: text.includes("trigger") || hasTriggerCollider,
    collectible: text.includes("collectable") || text.includes("collectible"),
    hasMesh: Boolean(object.mesh),
    hasCollider: Boolean(colliders.length),
    hasSolidCollider,
    hasTriggerCollider,
    hasRigidbody: Boolean(object.rigidbody?.hasRigidbody),
  };
}

function normalizeRigidbody(rigidbody) {
  if (!rigidbody || !rigidbody.hasRigidbody) return { hasRigidbody: false };
  return {
    hasRigidbody: true,
    isKinematic: Boolean(rigidbody.isKinematic),
    useGravity: Boolean(rigidbody.useGravity),
    mass: Number(rigidbody.mass) || 0,
    drag: Number(rigidbody.drag) || 0,
    angularDrag: Number(rigidbody.angularDrag) || 0,
    collisionDetectionMode: rigidbody.collisionDetectionMode || "",
    interpolation: rigidbody.interpolation || "",
    constraints: rigidbody.constraints || "",
  };
}

function classifyMaterial(material) {
  const text = `${material.name || ""} ${material.shader || ""}`.toLowerCase();
  if (text.includes("water")) return "water";
  if (text.includes("glass") || text.includes("blur")) return "glass";
  if (text.includes("teleport")) return "teleport";
  if (text.includes("disc")) return "disc";
  return material.isTransparent ? "transparent" : "surface";
}
function buildWebXrRuntime(spatialScene) {
  const nodes = spatialScene.nodes || [];
  const entrancePoints = spatialScene.entrancePoints || [];
  const teleport = nodes.filter((node) => node.flags?.teleport).map((node) => runtimeNode(node, "teleport"));
  const triggers = nodes.filter((node) => node.flags?.trigger).map((node) => runtimeNode(node, "trigger"));
  const collectibles = nodes.filter((node) => node.flags?.collectible).map((node) => runtimeNode(node, "collectible"));
  const colliders = nodes
    .filter((node) => node.flags?.hasSolidCollider)
    .map((node) => runtimeNode(node, "collider", { triggerMode: false }));
  const triggerColliders = nodes
    .filter((node) => node.flags?.hasTriggerCollider)
    .map((node) => runtimeNode(node, "triggerCollider", { triggerMode: true }));
  const materials = spatialScene.materials || [];

  return {
    schema: "spatialExporter.webxrRuntime.v0",
    mode: "physical",
    generatedAtUtc: new Date().toISOString(),
    source: spatialScene.source || {},
    units: spatialScene.webxr?.units || "meters",
    coordinateSystem: spatialScene.webxr?.coordinateSystem || "right-handed x,y,-z",
    assets: {
      scene: "scene.json",
      metadata: "spatial.scene.json",
      meshes: "meshes/",
      textures: "textures/",
    },
    summary: {
      nodes: spatialScene.stats?.nodes || nodes.length,
      meshes: spatialScene.stats?.meshes || nodes.filter((node) => node.mesh).length,
      colliders: spatialScene.stats?.colliders || colliders.reduce((sum, node) => sum + node.colliders.length, 0),
      solidColliders: spatialScene.stats?.solidColliders || colliders.reduce((sum, node) => sum + node.colliders.length, 0),
      triggerColliders: spatialScene.stats?.triggerColliders || triggerColliders.reduce((sum, node) => sum + node.colliders.length, 0),
      rigidbodies: spatialScene.stats?.rigidbodies || nodes.filter((node) => node.rigidbody?.hasRigidbody).length,
      teleport: teleport.length,
      triggers: triggers.length,
      collectibles: collectibles.length,
      lights: spatialScene.stats?.lights || 0,
      entrancePoints: entrancePoints.length,
    },
    navigation: {
      entrancePoints,
      teleport,
      defaultRig: {
        type: "standing",
        height: 1.7,
        radius: 0.28,
      },
    },
    player: {
      spawn: defaultSpawn(entrancePoints, teleport),
      rig: {
        type: "firstPerson",
        height: 1.7,
        radius: 0.28,
        movement: "walk",
      },
    },
    physics: {
      gravity: [0, -9.81, 0],
      colliders,
      triggerColliders,
    },
    interactions: {
      triggers,
      collectibles,
    },
    materials: {
      water: materials.filter((material) => material.semantic === "water").map((material) => material.id),
      glass: materials.filter((material) => material.semantic === "glass").map((material) => material.id),
      transparent: materials.filter((material) => material.transparent).map((material) => material.id),
    },
    lights: spatialScene.lights || [],
  };
}

function defaultSpawn(entrancePoints, teleport) {
  const explicit = entrancePoints.find((point) => Array.isArray(point.position) && point.position.length >= 3);
  if (explicit) {
    return {
      source: "entrancePoint",
      id: explicit.id,
      name: explicit.name,
      position: explicit.position,
      rotationEuler: explicit.rotationEuler || [0, 0, 0],
      radius: explicit.radius || 0,
    };
  }

  const fallback = teleport.find((point) => Array.isArray(point.position) && point.position.length >= 3);
  if (fallback) {
    return {
      source: "teleportFallback",
      id: fallback.id,
      name: fallback.name,
      position: fallback.position,
      rotationEuler: [0, 0, 0],
      radius: runtimeBoundsRadius(fallback.bounds),
    };
  }

  return {
    source: "sceneFallback",
    id: "",
    name: "Scene center",
    position: [0, 1.7, 0],
    rotationEuler: [0, 0, 0],
    radius: 0,
  };
}

function runtimeBoundsRadius(bounds) {
  if (!bounds?.min || !bounds?.max) return 2;
  return Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
    2
  );
}

function runtimeNode(node, role, options = {}) {
  const sourceColliders = (node.colliders || []).filter((collider) => {
    if (options.triggerMode === true) return Boolean(collider.isTrigger);
    if (options.triggerMode === false) return !collider.isTrigger;
    return true;
  });
  const colliders = sourceColliders.map(runtimeCollider);
  const bounds = unionBounds(colliders.map((collider) => collider.bounds).filter(Boolean));
  return {
    id: node.id,
    role,
    kind: node.kind,
    name: node.name,
    path: node.path,
    tag: node.tag || "",
    layer: node.layer || 0,
    layerName: node.layerName || "",
    isStatic: Boolean(node.isStatic),
    mesh: node.mesh || "",
    materialIds: node.materialIds || [],
    position: roundVec(node.transform?.position || colliderCenter(bounds) || [0, 0, 0]),
    matrix: Array.isArray(node.transform?.matrix) ? node.transform.matrix.map(roundNumber) : [],
    rigidbody: node.rigidbody || { hasRigidbody: false },
    bounds,
    colliders,
  };
}

function runtimeCollider(collider) {
  const center = roundVec(collider.center || [0, 0, 0]);
  const size = roundVec(collider.size || [0, 0, 0]);
  const type = collider.type || "Collider";
  const radius = roundNumber(collider.radius || Math.max(size[0], size[2]) * 0.5 || 0);
  const shape = colliderShape(type, size);
  return {
    type,
    shape,
    name: collider.name || "",
    enabled: collider.enabled !== false,
    isTrigger: Boolean(collider.isTrigger),
    tag: collider.tag || "",
    layer: Number.isFinite(collider.layer) ? collider.layer : 0,
    layerName: collider.layerName || "",
    physicsMaterial: collider.physicsMaterial || "",
    center,
    size,
    radius,
    height: roundNumber(collider.height || size[1] || 0),
    meshName: collider.meshName || "",
    convex: Boolean(collider.convex),
    bounds: boundsFromCenterSize(center, size),
  };
}

function colliderShape(type, size) {
  const label = String(type || "").toLowerCase();
  if (label.includes("sphere")) return "sphere";
  if (label.includes("capsule")) return "capsule";
  if (label.includes("box")) return "box";
  if (label.includes("mesh")) return size.every((value) => value > 0) ? "meshBounds" : "mesh";
  return "bounds";
}

function boundsFromCenterSize(center, size) {
  if (!center || !size || size.every((value) => Math.abs(value) < 0.00001)) return null;
  return {
    min: roundVec([center[0] - size[0] * 0.5, center[1] - size[1] * 0.5, center[2] - size[2] * 0.5]),
    max: roundVec([center[0] + size[0] * 0.5, center[1] + size[1] * 0.5, center[2] + size[2] * 0.5]),
  };
}

function unionBounds(boundsItems) {
  if (!boundsItems.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const bounds of boundsItems) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], bounds.min[i]);
      max[i] = Math.max(max[i], bounds.max[i]);
    }
  }
  return { min: roundVec(min), max: roundVec(max) };
}

function colliderCenter(bounds) {
  if (!bounds) return null;
  return [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  ];
}

function roundVec(value) {
  return [roundNumber(value[0] || 0), roundNumber(value[1] || 0), roundNumber(value[2] || 0)];
}

function roundNumber(value) {
  return Math.round((Number(value) || 0) * 100000) / 100000;
}

function copyViewer(template, target, exportRoot) {
  ensureFile(template);
  fs.rmSync(target, { recursive: true, force: true });
  copyRecursive(template, target);
  const appPath = path.join(target, "app.js");
  let app = fs.readFileSync(appPath, "utf8");
  const rel = normalizeWebPath(path.relative(target, exportRoot)) + "/";
  app = app.replace(/const EXPORT_BASE = .*?;/, `const EXPORT_BASE = "${rel}";`);
  fs.writeFileSync(appPath, app);
}

function copyRecursive(source, target) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const child of fs.readdirSync(source)) {
      copyRecursive(path.join(source, child), path.join(target, child));
    }
    return;
  }
  fs.copyFileSync(source, target);
}

function writeManifest(projectRoot, scenePath, exportRoot, viewerRoot, logPath) {
  const metadataPath = path.join(exportRoot, "spatial.scene.json");
  const runtimePath = path.join(exportRoot, "webxr.runtime.json");
  const manifest = {
    tool: "spatialExporter",
    mode: "physical",
    generatedAtUtc: new Date().toISOString(),
    project: projectRoot,
    scene: scenePath,
    exportDir: exportRoot,
    viewerDir: viewerRoot,
    logFile: logPath,
    metadataFile: metadataPath,
    webxrRuntimeFile: runtimePath,
  };
  fs.writeFileSync(path.join(exportRoot, "spatialExporter.manifest.json"), JSON.stringify(manifest, null, 2));
}

function normalizeWebPath(value) {
  return value.replace(/\\/g, "/");
}

function sanitize(value) {
  return value.replace(/[^a-z0-9_.-]+/gi, "_");
}
