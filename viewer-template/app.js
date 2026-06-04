const EXPORT_BASE = "../BodyLab3_Scene_Physical/";
const canvas = document.getElementById("viewport");
const gl = canvas.getContext("webgl", { antialias: true, depth: true });
const skyCanvas = document.createElement("canvas");
const skyCtx = skyCanvas.getContext("2d");
const textureCache = new Map();
const normalMapExt = gl.getExtension("OES_standard_derivatives");
const MAX_LIGHTS = 4;
const PHYSICS_OVERRIDE_STORAGE = "spatialExporter.physicsOverrides.v1";
const PHYSICS_MODES = new Set(["auto", "walkable", "solid", "none", "trigger"]);

if (!gl) {
  document.body.innerHTML = "<p style='padding:24px'>WebGL non disponibile su questo browser.</p>";
  throw new Error("WebGL unavailable");
}

const ui = {
  loadedCount: document.getElementById("loadedCount"),
  objectCount: document.getElementById("objectCount"),
  progressBar: document.getElementById("progressBar"),
  objectList: document.getElementById("objectList"),
  objectListCount: document.getElementById("objectListCount"),
  metadataStatus: document.getElementById("metadataStatus"),
  semanticStats: document.getElementById("semanticStats"),
  objectSearch: document.getElementById("objectSearch"),
  filterButtons: Array.from(document.querySelectorAll(".filter-button")),
  runtimeDebugButtons: Array.from(document.querySelectorAll(".debug-button")),
  togglePlayer: document.getElementById("togglePlayer"),
  toggleThirdPerson: document.getElementById("toggleThirdPerson"),
  nextTeleport: document.getElementById("nextTeleport"),
  runtimeStatus: document.getElementById("runtimeStatus"),
  playerPosition: document.getElementById("playerPosition"),
  interactionStatus: document.getElementById("interactionStatus"),
  physicsEditorStatus: document.getElementById("physicsEditorStatus"),
  physicsEditorReadout: document.getElementById("physicsEditorReadout"),
  physicsOverrideButtons: Array.from(document.querySelectorAll("[data-physics-mode]")),
  savePhysicalMap: document.getElementById("savePhysicalMap"),
  loadPhysicalMap: document.getElementById("loadPhysicalMap"),
  clearPhysicalMap: document.getElementById("clearPhysicalMap"),
  physicalMapFile: document.getElementById("physicalMapFile"),
  resetView: document.getElementById("resetView"),
  toggleWire: document.getElementById("toggleWire"),
  toggleCull: document.getElementById("toggleCull"),
  exposure: document.getElementById("exposure"),
  sceneScale: document.getElementById("sceneScale"),
  ambientStrength: document.getElementById("ambientStrength"),
  lightStrength: document.getElementById("lightStrength"),
  reflectionStrength: document.getElementById("reflectionStrength"),
  specularStrength: document.getElementById("specularStrength"),
  normalStrength: document.getElementById("normalStrength"),
  ambientValue: document.getElementById("ambientValue"),
  lightValue: document.getElementById("lightValue"),
  reflectionValue: document.getElementById("reflectionValue"),
  specularValue: document.getElementById("specularValue"),
  normalValue: document.getElementById("normalValue"),
};

const state = {
  meshes: [],
  allObjects: [],
  objectFilter: "all",
  objectSearch: "",
  metadata: null,
  runtime: null,
  loopRotations: [],
  transformAnimations: [],
  selectedObjectPath: "",
  selectedObjectBounds: null,
  selectedRuntimeNodes: [],
  physicsOverrides: loadPhysicsOverrides(),
  player: {
    enabled: false,
    thirdPerson: false,
    position: [0, 1.7, 0],
    velocityY: 0,
    yaw: 0,
    pitch: 0,
    height: 1.7,
    radius: 0.28,
    speed: 6.5,
    sprintMultiplier: 1.65,
    stepHeight: 0.45,
    grounded: false,
    jumpsUsed: 0,
    maxJumps: 2,
    jumpSpeed: 5.2,
    respawnY: -30,
  },
  keys: new Set(),
  lastFrameTime: performance.now() * 0.001,
  metadataByPath: new Map(),
  runtimeDebug: {
    colliders: false,
    spawn: true,
    teleport: true,
    triggers: true,
    collectibles: true,
  },
  runtimeLineCache: null,
  teleportIndex: 0,
  nearbyTeleport: null,
  nearbyTrigger: null,
  totalMeshes: 0,
  yaw: -0.55,
  pitch: 0.38,
  distance: 90,
  target: [0, 18, 0],
  wire: false,
  cull: false,
  exposure: 0.9,
  sceneScale: 1,
  ambientStrength: 0.55,
  lightStrength: 0.5,
  reflectionStrength: 0.75,
  specularStrength: 0.55,
  normalStrength: 0.8,
  dragging: false,
  pointerLook: false,
  lastX: 0,
  lastY: 0,
  lighting: defaultLighting(),
};

const program = createProgram(`
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUv;
uniform mat4 uModel;
uniform mat4 uView;
uniform mat4 uProjection;
uniform float uSceneScale;
uniform vec3 uEye;
uniform int uLightCount;
uniform vec4 uLightData[4];
uniform vec4 uLightColor[4];
varying vec3 vNormal;
varying vec3 vWorld;
varying vec2 vUv;
void main() {
  vec4 world = uModel * vec4(aPosition * uSceneScale, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(uModel) * aNormal;
  vUv = aUv;
  gl_Position = uProjection * uView * world;
}
`, `
#extension GL_OES_standard_derivatives : enable
precision mediump float;
uniform vec4 uColor;
uniform sampler2D uTexture;
uniform sampler2D uNormalTexture;
uniform float uExposure;
uniform float uHasTexture;
uniform float uHasNormalTexture;
uniform float uNormalScale;
uniform float uWater;
uniform float uGlass;
uniform float uSmoothness;
uniform float uMetallic;
uniform float uReflective;
uniform float uReflectionScale;
uniform float uSpecularScale;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uEye;
uniform int uLightCount;
uniform vec4 uLightData[4];
uniform vec4 uLightColor[4];
varying vec3 vNormal;
varying vec3 vWorld;
varying vec2 vUv;

vec3 normalFromMap(vec3 n) {
  if (uHasNormalTexture < 0.5) return n;
  vec3 map = texture2D(uNormalTexture, vUv).xyz * 2.0 - 1.0;
  vec3 dp1 = dFdx(vWorld);
  vec3 dp2 = dFdy(vWorld);
  vec2 duv1 = dFdx(vUv);
  vec2 duv2 = dFdy(vUv);
  vec3 tangent = normalize(dp1 * duv2.y - dp2 * duv1.y);
  vec3 bitangent = normalize(-dp1 * duv2.x + dp2 * duv1.x);
  if (length(tangent) < 0.01 || length(bitangent) < 0.01) return n;
  mat3 tbn = mat3(tangent, bitangent, n);
  return normalize(tbn * vec3(map.xy * uNormalScale, map.z));
}

void main() {
  vec3 n = normalFromMap(normalize(vNormal));
  vec3 v = normalize(uEye - vWorld);
  float hemiMix = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 ambient = mix(uGroundColor, uSkyColor, hemiMix) * 0.58;
  vec4 texel = texture2D(uTexture, vUv);
  vec4 base = mix(uColor, texel * uColor, uHasTexture);

  float smooth = clamp(uSmoothness, 0.0, 1.0);
  float metal = clamp(uMetallic, 0.0, 1.0);
  float reflective = clamp(uReflective + uGlass * 0.55 + uWater * 0.45, 0.0, 1.0);
  float specPower = mix(16.0, 180.0, smooth);
  vec3 directLight = vec3(0.0);
  float spec = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= uLightCount) break;
    vec4 data = uLightData[i];
    vec4 color = uLightColor[i];
    vec3 lightVec = data.xyz;
    float attenuation = 1.0;
    if (data.w > 0.5) {
      lightVec = data.xyz - vWorld;
      float dist = length(lightVec);
      float range = max(color.w, 0.001);
      attenuation = pow(clamp(1.0 - dist / range, 0.0, 1.0), 2.0);
    }
    vec3 l = normalize(lightVec);
    float ndotl = max(dot(n, l), 0.0);
    directLight += color.rgb * ndotl * attenuation;
    vec3 h = normalize(l + v);
    spec += pow(max(dot(n, h), 0.0), specPower) * attenuation * max(max(color.r, color.g), color.b);
  }
  float fresnel = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), mix(3.5, 1.8, reflective));
  vec3 env = mix(uGroundColor, uSkyColor, clamp(reflect(-v, n).y * 0.5 + 0.5, 0.0, 1.0));
  float shimmer = sin((vWorld.x + vWorld.z) * 0.08 + vWorld.y * 0.03) * 0.035;

  vec3 diffuseColor = base.rgb * (1.0 - metal * 0.45);
  vec3 lit = diffuseColor * (ambient + directLight + vec3(shimmer * uWater)) * uExposure;
  vec3 reflection = env * (fresnel * reflective + spec * smooth * (0.25 + reflective)) * uReflectionScale;
  vec3 waterTint = mix(lit, vec3(0.08, 0.48, 0.55), 0.28 * uWater);
  vec3 finalColor = mix(waterTint, reflection + waterTint * (1.0 - reflective * 0.35), clamp(reflective * 0.65 + uWater * 0.2, 0.0, 0.85));
  finalColor += vec3(spec) * smooth * (0.18 + 0.55 * reflective) * uSpecularScale;
  finalColor += vec3(fresnel) * (uGlass * 0.22 + uWater * 0.12);
  gl_FragColor = vec4(finalColor, base.a);
}
`);

const loc = {
  aPosition: gl.getAttribLocation(program, "aPosition"),
  aNormal: gl.getAttribLocation(program, "aNormal"),
  aUv: gl.getAttribLocation(program, "aUv"),
  uModel: gl.getUniformLocation(program, "uModel"),
  uView: gl.getUniformLocation(program, "uView"),
  uProjection: gl.getUniformLocation(program, "uProjection"),
  uColor: gl.getUniformLocation(program, "uColor"),
  uTexture: gl.getUniformLocation(program, "uTexture"),
  uNormalTexture: gl.getUniformLocation(program, "uNormalTexture"),
  uHasTexture: gl.getUniformLocation(program, "uHasTexture"),
  uHasNormalTexture: gl.getUniformLocation(program, "uHasNormalTexture"),
  uNormalScale: gl.getUniformLocation(program, "uNormalScale"),
  uWater: gl.getUniformLocation(program, "uWater"),
  uGlass: gl.getUniformLocation(program, "uGlass"),
  uSmoothness: gl.getUniformLocation(program, "uSmoothness"),
  uMetallic: gl.getUniformLocation(program, "uMetallic"),
  uReflective: gl.getUniformLocation(program, "uReflective"),
  uReflectionScale: gl.getUniformLocation(program, "uReflectionScale"),
  uSpecularScale: gl.getUniformLocation(program, "uSpecularScale"),
  uEye: gl.getUniformLocation(program, "uEye"),
  uLightCount: gl.getUniformLocation(program, "uLightCount"),
  uLightData: Array.from({ length: MAX_LIGHTS }, (_, i) => gl.getUniformLocation(program, `uLightData[${i}]`)),
  uLightColor: Array.from({ length: MAX_LIGHTS }, (_, i) => gl.getUniformLocation(program, `uLightColor[${i}]`)),
  uSkyColor: gl.getUniformLocation(program, "uSkyColor"),
  uGroundColor: gl.getUniformLocation(program, "uGroundColor"),
  uExposure: gl.getUniformLocation(program, "uExposure"),
  uSceneScale: gl.getUniformLocation(program, "uSceneScale"),
};

init();
requestAnimationFrame(render);

async function init() {
  const scene = await fetchJson(EXPORT_BASE + "scene.json");
  state.metadata = await fetchOptionalJson(EXPORT_BASE + "spatial.scene.json");
  state.runtime = await fetchOptionalJson(EXPORT_BASE + "webxr.runtime.json");
  state.loopRotations = state.runtime?.behaviours?.loopRotations || [];
  state.transformAnimations = state.runtime?.behaviours?.transformAnimations || [];
  indexMetadata(state.metadata);
  state.lighting = normalizeLighting(scene.lighting);
  const renderable = scene.objects.filter((item) => item.mesh && item.mesh.endsWith(".obj"));
  state.allObjects = scene.objects;
  state.totalMeshes = renderable.length;
  ui.objectCount.textContent = scene.objects.length;
  populateMetadataPanel(state.metadata);
  populateObjectList(scene.objects);

  let loaded = 0;
  const queue = [...renderable];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        const text = await fetchText(EXPORT_BASE + item.mesh);
        const parsed = parseObj(text);
        if (parsed.positions.length > 0) {
          state.meshes.push(await createMesh(item, parsed));
        }
      } catch (error) {
        console.warn("Failed to load", item.mesh, error);
      }
      loaded += 1;
      ui.loadedCount.textContent = String(loaded);
      ui.progressBar.style.width = `${Math.round((loaded / state.totalMeshes) * 100)}%`;
    }
  });

  await Promise.all(workers);
  fitCameraFromScene();
  focusPlayerSpawn();
  resetPlayerToSpawn();
}

function populateObjectList(items) {
  if (!ui.objectList) return;
  const filtered = filterObjects(items);
  ui.objectList.innerHTML = "";
  if (ui.objectListCount) ui.objectListCount.textContent = `${filtered.length} shown`;
  for (const item of filtered.slice(0, 260)) {
    const meta = metaFor(item);
    const li = document.createElement("li");
    li.className = `kind-${semanticToken(meta, item)}`;
    if ((item.hierarchyPath || item.name || "") === state.selectedObjectPath) li.classList.add("is-selected");
    li.tabIndex = 0;
    const label = document.createElement("span");
    label.textContent = item.hierarchyPath || item.name;
    const chip = document.createElement("b");
    chip.textContent = semanticLabel(meta, item);
    li.append(label, chip);
    li.addEventListener("click", () => selectObject(item));
    li.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectObject(item);
      }
    });
    ui.objectList.appendChild(li);
  }
}

function selectObject(item) {
  state.selectedObjectPath = item.hierarchyPath || item.name || "";
  state.selectedObjectBounds = boundsForObject(item);
  state.selectedRuntimeNodes = runtimeNodesForObject(item);
  state.runtimeLineCache = null;
  populateObjectList(state.allObjects);
  updatePhysicsEditor(item);
  focusSelectedObject(item);
  if (ui.runtimeStatus) {
    const colliderCount = state.selectedRuntimeNodes.reduce((sum, node) => sum + (node.colliders || []).length, 0);
    ui.runtimeStatus.textContent = `selected: ${item.name || "object"} (${colliderCount} colliders)`;
  }
}

function runtimeNodesForObject(item) {
  const path = item.hierarchyPath || item.name || "";
  const pools = [
    ...(state.runtime?.physics?.colliders || []),
    ...(state.runtime?.physics?.triggerColliders || []),
    ...(state.runtime?.navigation?.teleport || []),
    ...(state.runtime?.interactions?.triggers || []),
    ...(state.runtime?.interactions?.collectibles || []),
  ];
  return pools.filter((node) => {
    const nodePath = node.path || node.name || "";
    return nodePath === path || nodePath.startsWith(`${path}/`) || path.startsWith(`${nodePath}/`);
  });
}

function focusSelectedObject(item) {
  const bounds = unionRuntimeBounds([
    boundsForObject(item),
    ...state.selectedRuntimeNodes.map((node) => node.bounds),
  ]);
  if (!bounds) return;
  const center = boundsCenter(bounds);
  const size = Math.max(boundsSize(bounds), 4);
  state.target = center;
  state.distance = clamp(size * 2.4, 8, 220);
  state.pitch = 0.32;
  if (!state.player.enabled) state.yaw = -0.65;
}

function boundsForObject(item) {
  if (item.bounds?.min && item.bounds?.max) return item.bounds;
  const path = item.hierarchyPath || item.name || "";
  const mesh = state.meshes.find((candidate) => candidate.path === path || candidate.name === item.name);
  return mesh?.bounds || null;
}

function selectedObject() {
  if (!state.selectedObjectPath) return null;
  return state.allObjects.find((item) => (item.hierarchyPath || item.name || "") === state.selectedObjectPath) || null;
}

function physicsKeyForItem(item) {
  return item?.mesh || item?.hierarchyPath || item?.path || item?.name || "";
}

function physicsModeForKey(key) {
  return state.physicsOverrides[key] || "auto";
}

function effectivePhysicsModeForMesh(mesh) {
  const override = physicsModeForKey(mesh.sourceMesh || mesh.path || mesh.name);
  return override === "auto" ? "walkable" : override;
}

function updatePhysicsEditor(item = selectedObject()) {
  const key = physicsKeyForItem(item);
  const mode = key ? physicsModeForKey(key) : "auto";
  const mesh = key ? state.meshes.find((candidate) => candidate.sourceMesh === item?.mesh || candidate.path === (item?.hierarchyPath || item?.name || "")) : null;
  ui.physicsOverrideButtons.forEach((button) => {
    button.disabled = !key;
    button.classList.toggle("is-active", button.dataset.physicsMode === mode);
  });
  if (ui.physicsEditorStatus) ui.physicsEditorStatus.textContent = key ? mode : "select object";
  if (ui.physicsEditorReadout) {
    if (!key) {
      ui.physicsEditorReadout.textContent = "no selection";
    } else {
      const tris = mesh?.collisionTriangles?.length ? Math.floor(mesh.collisionTriangles.length / 9) : 0;
      ui.physicsEditorReadout.textContent = `${item.name || "object"} - ${mesh ? `${tris} mesh triangles` : "no visual mesh"} - ${mode}`;
    }
  }
}

function setSelectedPhysicsMode(mode) {
  const item = selectedObject();
  const key = physicsKeyForItem(item);
  if (!key) return;
  if (mode === "auto") {
    delete state.physicsOverrides[key];
  } else {
    state.physicsOverrides[key] = mode;
  }
  savePhysicsOverrides();
  state.runtimeLineCache = null;
  updatePhysicsEditor(item);
  populateObjectList(state.allObjects);
  if (ui.runtimeStatus) ui.runtimeStatus.textContent = `collider: ${mode}`;
}

function physicalMapPayload() {
  return {
    version: 1,
    kind: "spatialExporter.physicalMap",
    scene: state.metadata?.scene || "BodyLab3_Scene",
    createdAt: new Date().toISOString(),
    overrides: { ...state.physicsOverrides },
  };
}

function downloadPhysicalMap() {
  const payload = physicalMapPayload();
  const text = JSON.stringify(payload, null, 2);
  const blob = new Blob([text], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${payload.scene || "scene"}.physical-map.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
  if (ui.runtimeStatus) ui.runtimeStatus.textContent = `saved ${Object.keys(payload.overrides).length} overrides`;
}

function loadPhysicalMapFromText(text) {
  const parsed = JSON.parse(text);
  const source = parsed.overrides || parsed.physicsOverrides || parsed;
  const next = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (!key || !PHYSICS_MODES.has(value) || value === "auto") continue;
    next[key] = value;
  }
  state.physicsOverrides = next;
  savePhysicsOverrides();
  state.runtimeLineCache = null;
  updatePhysicsEditor();
  populateObjectList(state.allObjects);
  if (ui.runtimeStatus) ui.runtimeStatus.textContent = `loaded ${Object.keys(next).length} overrides`;
}

function clearPhysicalMap() {
  state.physicsOverrides = {};
  savePhysicsOverrides();
  state.runtimeLineCache = null;
  updatePhysicsEditor();
  populateObjectList(state.allObjects);
  if (ui.runtimeStatus) ui.runtimeStatus.textContent = "cleared physical map";
}

function filterObjects(items) {
  const needle = state.objectSearch.trim().toLowerCase();
  return items.filter((item) => {
    const meta = metaFor(item);
    const token = semanticToken(meta, item);
    const matchesFilter = state.objectFilter === "all" || token === state.objectFilter;
    const haystack = `${item.hierarchyPath || ""} ${item.name || ""} ${token}`.toLowerCase();
    return matchesFilter && (!needle || haystack.includes(needle));
  });
}

function populateMetadataPanel(metadata) {
  if (!ui.semanticStats) return;
  if (!metadata) {
    if (ui.metadataStatus) ui.metadataStatus.textContent = "missing";
    ui.semanticStats.innerHTML = "<span>Run spatialExporter to build metadata.</span>";
    return;
  }
  const stats = metadata.stats || {};
  const webxr = metadata.webxr || {};
  const interactions = webxr.interactions || {};
  const runtimeSummary = state.runtime?.summary || {};
  const totalAnimations = (runtimeSummary.loopRotations || stats.loopRotations || 0) + (runtimeSummary.transformAnimations || stats.transformAnimations || 0);
  const appliedAnimations = (runtimeSummary.loopRotations || stats.loopRotations || 0) + (runtimeSummary.appliedTransformAnimations || 0);
  const entries = [
    ["Colliders", stats.colliders],
    ["Materials", stats.materials],
    ["Textures", stats.texturedMaterials],
    ["Lights", stats.lights],
    ["Entrances", stats.entrancePoints],
    ["Animations", `${appliedAnimations}/${totalAnimations}`],
    ["Teleport", (interactions.teleport || []).length],
    ["Triggers", (interactions.triggers || []).length],
  ];
  if (ui.metadataStatus) ui.metadataStatus.textContent = metadata.mode || "physical";
  ui.semanticStats.innerHTML = entries.map(([label, value]) => `<span><b>${value ?? 0}</b>${label}</span>`).join("");
}

function indexMetadata(metadata) {
  state.metadataByPath = new Map();
  for (const node of metadata?.nodes || []) {
    if (node.path) state.metadataByPath.set(node.path, node);
  }
}

function metaFor(item) {
  return state.metadataByPath.get(item.hierarchyPath) || state.metadataByPath.get(item.name) || null;
}

function semanticToken(meta, item) {
  const flags = meta?.flags || {};
  const kind = String(meta?.kind || "").toLowerCase();
  const path = `${item.hierarchyPath || ""} ${item.name || ""}`.toLowerCase();
  if (flags.teleport || kind.includes("teleport") || path.includes("teleport")) return "teleport";
  if (flags.collectible || kind.includes("collectible") || path.includes("collectible")) return "collectible";
  if (flags.trigger || kind.includes("trigger") || path.includes("trigger")) return "trigger";
  if (flags.hasCollider || kind.includes("collider") || (item.colliders || []).length) return "collider";
  return "mesh";
}

function semanticLabel(meta, item) {
  const override = physicsModeForKey(physicsKeyForItem(item));
  if (override !== "auto") return override;
  const labels = {
    mesh: "mesh",
    teleport: "teleport",
    collectible: "collect",
    trigger: "trigger",
    collider: "collider",
  };
  return labels[semanticToken(meta, item)] || "mesh";
}

async function createMesh(item, parsed) {
  const model = modelMatrix(item.transform);
  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(parsed.positions), gl.STATIC_DRAW);

  const normalBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(parsed.normals), gl.STATIC_DRAW);

  const uvBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(parsed.uvs), gl.STATIC_DRAW);

  const materials = await materialData(item);
  const bounds = transformBounds(parsed.bounds, model);
  const collisionTriangles = sampleVisualCollisionTriangles(parsed.positions, model);

  return {
    name: item.name,
    path: item.hierarchyPath || item.name || "",
    sourceMesh: item.mesh || "",
    count: parsed.positions.length / 3,
    positionBuffer,
    normalBuffer,
    uvBuffer,
    model,
    baseModel: new Float32Array(model),
    materials,
    hasTransparent: materials.some((material) => material.transparent),
    groups: parsed.groups,
    bounds,
    collisionTriangles,
  };
}

function sampleVisualCollisionTriangles(positions, model) {
  if (!positions?.length) return [];
  const triangleCount = Math.floor(positions.length / 9);
  const maxTriangles = 900;
  const stride = Math.max(1, Math.floor(triangleCount / maxTriangles));
  const triangles = [];
  for (let triangle = 0; triangle < triangleCount && triangles.length < maxTriangles * 9; triangle += stride) {
    const i = triangle * 9;
    const a = transformPoint(model, [positions[i], positions[i + 1], positions[i + 2]]);
    const b = transformPoint(model, [positions[i + 3], positions[i + 4], positions[i + 5]]);
    const c = transformPoint(model, [positions[i + 6], positions[i + 7], positions[i + 8]]);
    triangles.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }
  return triangles;
}

function parseObj(text) {
  const vertices = [[0, 0, 0]];
  const normals = [[0, 1, 0]];
  const uvs = [[0, 0]];
  const outPositions = [];
  const outNormals = [];
  const outUvs = [];
  const groups = [];
  let currentGroup = { start: 0, count: 0, materialIndex: 0 };
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (line.startsWith("v ")) {
      const p = line.split(/\s+/);
      vertices.push([Number(p[1]), Number(p[2]), Number(p[3])]);
    } else if (line.startsWith("vn ")) {
      const p = line.split(/\s+/);
      normals.push([Number(p[1]), Number(p[2]), Number(p[3])]);
    } else if (line.startsWith("vt ")) {
      const p = line.split(/\s+/);
      uvs.push([Number(p[1]), Number(p[2])]);
    } else if (line.startsWith("g submesh_")) {
      if (currentGroup.count > 0) groups.push(currentGroup);
      const match = line.match(/submesh_(\d+)/);
      currentGroup = { start: outPositions.length / 3, count: 0, materialIndex: match ? Number(match[1]) : 0 };
    } else if (line.startsWith("f ")) {
      const parts = line.trim().split(/\s+/).slice(1);
      for (let i = 1; i < parts.length - 1; i++) {
        addFaceVertex(parts[0], vertices, normals, uvs, outPositions, outNormals, outUvs);
        addFaceVertex(parts[i], vertices, normals, uvs, outPositions, outNormals, outUvs);
        addFaceVertex(parts[i + 1], vertices, normals, uvs, outPositions, outNormals, outUvs);
        currentGroup.count += 3;
      }
    }
  }

  if (currentGroup.count > 0) groups.push(currentGroup);
  return { positions: outPositions, normals: outNormals, uvs: outUvs, groups, bounds: localBounds(outPositions) };
}

function addFaceVertex(token, vertices, normals, uvs, outPositions, outNormals, outUvs) {
  const [vIndex, uvIndex, nIndex] = token.split("/");
  const v = vertices[parseInt(vIndex, 10)] || vertices[0];
  const n = normals[parseInt(nIndex || "0", 10)] || normals[0];
  const uv = uvs[parseInt(uvIndex || "0", 10)] || uvs[0];
  outPositions.push(v[0], v[1], v[2]);
  outNormals.push(n[0], n[1], n[2]);
  outUvs.push(uv[0], uv[1]);
}

async function materialData(item) {
  const materials = Array.isArray(item.materials) && item.materials.length ? item.materials : [{ color: [0.72, 0.78, 0.82, 1] }];
  return Promise.all(materials.map(async (material) => ({
    color: materialColor(material),
    texture: material.texture ? await loadTexture(EXPORT_BASE + material.texture) : null,
    normalTexture: normalMapExt && materialNormalTexture(material) ? await loadTexture(EXPORT_BASE + materialNormalTexture(material)) : null,
    transparent: (material?.isTransparent || materialAlpha(material, pickMaterialColor(material)) < 0.98),
    semantic: materialSemantic(material),
    smoothness: materialFloat(material, ["_Smoothness", "_Glossiness", "_GlossMapScale", "smoothness"], 0.38),
    metallic: materialFloat(material, ["_Metallic", "metallic"], 0),
    reflective: materialReflective(material),
    normalScale: materialFloat(material, ["_BumpScale", "normal strength", "normal scale"], materialSemantic(material) === "water" ? 0.45 : 0.85),
  })));
}

function materialColor(material) {
  const color = pickMaterialColor(material);
  const alpha = materialAlpha(material, color);
  return [clamp(color[0], 0.04, 1), clamp(color[1], 0.04, 1), clamp(color[2], 0.04, 1), alpha];
}

function pickMaterialColor(material) {
  const semantic = materialSemantic(material);
  if (semantic === "water") {
    const shallow = findColorProperty(material, "shallow") || findColorProperty(material, "water") || [0.1, 0.55, 0.62, 0.58];
    return shallow;
  }
  if (semantic === "glass") {
    return findColorProperty(material, "multiply") || findColorProperty(material, "base") || [0.74, 0.58, 0.82, 0.34];
  }
  const color = material?.color;
  return Array.isArray(color) && color.length >= 3 ? color : [0.72, 0.78, 0.82, 1];
}

function materialAlpha(material, color) {
  const semantic = materialSemantic(material);
  if (semantic === "water") return 0.58;
  if (semantic === "glass") return Math.min(color[3] ?? 0.34, 0.42);
  if (material?.isTransparent) return Math.min(color[3] ?? 0.55, 0.62);
  return color[3] ?? 1;
}

function materialSemantic(material) {
  const name = `${material?.name || ""} ${material?.shader || ""}`.toLowerCase();
  if (name.includes("water")) return "water";
  if (name.includes("glass") || name.includes("blur")) return "glass";
  return "solid";
}

function findColorProperty(material, needle) {
  const prop = material?.properties?.find((item) => item.type === "Color" && `${item.name} ${item.label}`.toLowerCase().includes(needle));
  return prop?.color || null;
}

function materialNormalTexture(material) {
  const prop = material?.properties?.find((item) => {
    const key = `${item.name || ""} ${item.label || ""}`.toLowerCase();
    return item.type === "Texture" && item.texture && (key.includes("normal") || key.includes("bump"));
  });
  return prop?.texture || "";
}

function materialFloat(material, needles, fallback) {
  const list = Array.isArray(needles) ? needles : [needles];
  const props = material?.properties || [];
  for (const needle of list) {
    const key = String(needle).toLowerCase();
    const prop = props.find((item) => item.type !== "Texture" && `${item.name} ${item.label}`.toLowerCase().includes(key));
    if (prop && Number.isFinite(prop.value)) return prop.value;
  }
  return fallback;
}

function materialReflective(material) {
  const semantic = materialSemantic(material);
  if (semantic === "glass") return 0.92;
  if (semantic === "water") return 0.72;
  const env = materialFloat(material, ["_EnvironmentReflections", "EnvironmentReflections", "reflection intensity"], 0);
  const spec = materialFloat(material, ["_SpecularHighlights", "specular intensity", "specular power"], 0);
  const smooth = materialFloat(material, ["_Smoothness", "_Glossiness", "smoothness"], 0);
  const metal = materialFloat(material, ["_Metallic", "metallic"], 0);
  return clamp(env * 0.26 + spec * 0.18 + smooth * 0.32 + metal * 0.24, 0, 1);
}

async function loadTexture(url) {
  if (textureCache.has(url)) return textureCache.get(url);
  const promise = new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (isPowerOfTwo(image.width) && isPowerOfTwo(image.height)) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.generateMipmap(gl.TEXTURE_2D);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      resolve(texture);
    };
    image.onerror = () => resolve(null);
    image.src = url;
  });
  textureCache.set(url, promise);
  return promise;
}

function localBounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    min[0] = Math.min(min[0], positions[i]);
    min[1] = Math.min(min[1], positions[i + 1]);
    min[2] = Math.min(min[2], positions[i + 2]);
    max[0] = Math.max(max[0], positions[i]);
    max[1] = Math.max(max[1], positions[i + 1]);
    max[2] = Math.max(max[2], positions[i + 2]);
  }
  return { min, max };
}

function transformBounds(bounds, matrix) {
  const corners = [
    [bounds.min[0], bounds.min[1], bounds.min[2]],
    [bounds.max[0], bounds.min[1], bounds.min[2]],
    [bounds.min[0], bounds.max[1], bounds.min[2]],
    [bounds.min[0], bounds.min[1], bounds.max[2]],
    [bounds.max[0], bounds.max[1], bounds.min[2]],
    [bounds.max[0], bounds.min[1], bounds.max[2]],
    [bounds.min[0], bounds.max[1], bounds.max[2]],
    [bounds.max[0], bounds.max[1], bounds.max[2]],
  ].map((point) => transformPoint(matrix, point));
  return localBounds(corners.flat());
}

function transformPoint(m, p) {
  return [
    p[0] * m[0] + p[1] * m[4] + p[2] * m[8] + m[12],
    p[0] * m[1] + p[1] * m[5] + p[2] * m[9] + m[13],
    p[0] * m[2] + p[1] * m[6] + p[2] * m[10] + m[14],
  ];
}

function boundsCenter(bounds) {
  return [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
}

function boundsSize(bounds) {
  return Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
}

function unionRuntimeBounds(boundsItems) {
  const valid = boundsItems.filter((bounds) => bounds?.min && bounds?.max);
  if (!valid.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const bounds of valid) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], bounds.min[i]);
      max[i] = Math.max(max[i], bounds.max[i]);
    }
  }
  return { min, max };
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}


function modelMatrix(transform) {
  if (Array.isArray(transform?.matrix) && transform.matrix.length === 16) {
    return new Float32Array(transform.matrix);
  }
  const p = transform?.position || [0, 0, 0];
  const r = (transform?.rotationEuler || [0, 0, 0]).map((d) => d * Math.PI / 180);
  const s = transform?.scale || [1, 1, 1];
  return composeMatrix(p, r, s);
}

function fitCameraFromScene() {
  if (!state.meshes.length) return;
  const usable = robustCameraMeshes(state.meshes);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const mesh of usable) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], mesh.bounds.min[i]);
      max[i] = Math.max(max[i], mesh.bounds.max[i]);
    }
  }

  state.target = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 10);
  state.distance = clamp(span * 1.55, 8, 2200);
}

function jumpToNextTeleport() {
  const teleports = runtimeTeleportTargets();
  if (!teleports.length) {
    if (ui.runtimeStatus) ui.runtimeStatus.textContent = "no teleport";
    return;
  }
  const target = teleports[state.teleportIndex % teleports.length];
  state.teleportIndex += 1;
  teleportPlayerToTarget(target, `teleport ${state.teleportIndex}/${teleports.length}`);
}

function teleportPlayerToTarget(target, label = "teleport") {
  if (!target || !Array.isArray(target.position)) return false;
  if (!state.player.enabled) {
    state.target = [...target.position];
    state.distance = clamp(Math.max((target.radius || 2) * 6, 16), 8, 120);
    state.pitch = clamp(state.pitch, -0.15, 0.75);
    if (ui.runtimeStatus) ui.runtimeStatus.textContent = label;
    return true;
  }
  state.player.position = [
    Number(target.position[0]) || 0,
    (Number(target.position[1]) || 0) + state.player.height * 0.5,
    Number(target.position[2]) || 0,
  ];
  state.player.velocityY = 0;
  snapPlayerToGround(state.player.position);
  updatePlayerReadout();
  if (ui.runtimeStatus) ui.runtimeStatus.textContent = label;
  return true;
}

function activateNearestInteraction() {
  if (!state.player.enabled) return false;
  if (state.nearbyTeleport) {
    teleportPlayerToTarget(state.nearbyTeleport, `teleport: ${state.nearbyTeleport.name || "target"}`);
    return true;
  }
  if (state.nearbyTrigger) {
    if (ui.runtimeStatus) ui.runtimeStatus.textContent = `trigger: ${state.nearbyTrigger.name || "event"}`;
    return true;
  }
  if (ui.runtimeStatus) ui.runtimeStatus.textContent = "no nearby interaction";
  return false;
}

function focusPlayerSpawn() {
  const spawn = state.runtime?.player?.spawn;
  if (!spawn || !Array.isArray(spawn.position) || spawn.position.length < 3) return;
  const position = [
    Number(spawn.position[0]) || 0,
    Number(spawn.position[1]) || 0,
    Number(spawn.position[2]) || 0,
  ];
  state.target = [position[0], position[1] + 1.15, position[2]];
  state.distance = 18;
  state.pitch = 0.22;
  const yawDegrees = Array.isArray(spawn.rotationEuler) ? Number(spawn.rotationEuler[1]) || 0 : 0;
  state.yaw = (yawDegrees * Math.PI / 180) - 0.45;
  if (ui.runtimeStatus) ui.runtimeStatus.textContent = `spawn: ${spawn.name || spawn.source || "player"}`;
}

function resetPlayerToSpawn() {
  const spawn = state.runtime?.player?.spawn;
  const rig = state.runtime?.player?.rig || state.runtime?.navigation?.defaultRig || {};
  const position = Array.isArray(spawn?.position) ? spawn.position : [0, 1.7, 0];
  state.player.height = Number(rig.height) || 1.7;
  state.player.radius = clamp(Number(rig.radius) || 0.22, 0.14, 0.22);
  state.player.position = [
    Number(position[0]) || 0,
    (Number(position[1]) || 0) + state.player.height * 0.5,
    Number(position[2]) || 0,
  ];
  state.player.velocityY = 0;
  state.player.grounded = false;
  state.player.jumpsUsed = 0;
  const yawDegrees = Array.isArray(spawn?.rotationEuler) ? Number(spawn.rotationEuler[1]) || 0 : 0;
  state.player.yaw = yawDegrees * Math.PI / 180;
  state.player.pitch = 0;
  updatePlayerReadout();
}

function runtimeSpawnMarker() {
  const spawn = state.runtime?.player?.spawn;
  if (!spawn || !Array.isArray(spawn.position) || spawn.position.length < 3) return [];
  return [{
    id: spawn.id || "spawn",
    name: spawn.name || "Player spawn",
    position: spawn.position,
  }];
}

function runtimeTeleportTargets() {
  return (state.runtime?.navigation?.teleport || [])
    .filter((item) => Array.isArray(item.position) && item.position.length >= 3)
    .map((item) => ({
      id: item.id,
      name: item.name,
      position: [
        Number(item.position[0]) || 0,
        Number(item.position[1]) || 0,
        Number(item.position[2]) || 0,
      ],
      radius: runtimeBoundsRadius(item.bounds),
    }));
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

function togglePlayerMode() {
  state.player.enabled = !state.player.enabled;
  if (state.player.enabled) {
    resetPlayerToSpawn();
    if (ui.runtimeStatus) ui.runtimeStatus.textContent = "player mode";
  } else if (ui.runtimeStatus) {
    ui.runtimeStatus.textContent = "orbit mode";
  }
  if (ui.togglePlayer) ui.togglePlayer.classList.toggle("is-active", state.player.enabled);
  if (ui.toggleThirdPerson) ui.toggleThirdPerson.classList.toggle("is-active", state.player.enabled && state.player.thirdPerson);
  updatePlayerReadout();
}

function toggleThirdPersonMode() {
  state.player.thirdPerson = !state.player.thirdPerson;
  if (!state.player.enabled) {
    state.player.enabled = true;
    resetPlayerToSpawn();
  }
  if (ui.togglePlayer) ui.togglePlayer.classList.add("is-active");
  if (ui.toggleThirdPerson) ui.toggleThirdPerson.classList.toggle("is-active", state.player.thirdPerson);
  if (ui.runtimeStatus) ui.runtimeStatus.textContent = state.player.thirdPerson ? "third person" : "first person";
  updatePlayerReadout();
}

function currentCamera() {
  if (!state.player.enabled) {
    const eye = orbitEye();
    return { eye, target: state.target };
  }

  const eye = playerEye();
  const forward = playerForward();
  if (state.player.thirdPerson) {
    const flatForward = [Math.sin(state.player.yaw), 0, Math.cos(state.player.yaw)];
    const followEye = [
      state.player.position[0] - flatForward[0] * 8,
      state.player.position[1] + state.player.height * 2.6,
      state.player.position[2] - flatForward[2] * 8,
    ];
    return {
      eye: followEye,
      target: [eye[0], eye[1] - state.player.height * 0.2, eye[2]],
    };
  }
  return {
    eye,
    target: [eye[0] + forward[0], eye[1] + forward[1], eye[2] + forward[2]],
  };
}

function playerEye() {
  return [
    state.player.position[0],
    state.player.position[1] + state.player.height * 0.42,
    state.player.position[2],
  ];
}

function playerForward() {
  const cp = Math.cos(state.player.pitch);
  return [
    Math.sin(state.player.yaw) * cp,
    Math.sin(state.player.pitch),
    Math.cos(state.player.yaw) * cp,
  ];
}

function updatePlayer(dt) {
  if (!state.player.enabled) return;

  const forward = [Math.sin(state.player.yaw), 0, Math.cos(state.player.yaw)];
  const right = [-Math.cos(state.player.yaw), 0, Math.sin(state.player.yaw)];
  let moveX = 0;
  let moveZ = 0;
  if (state.keys.has("KeyW") || state.keys.has("ArrowUp")) { moveX += forward[0]; moveZ += forward[2]; }
  if (state.keys.has("KeyS") || state.keys.has("ArrowDown")) { moveX -= forward[0]; moveZ -= forward[2]; }
  if (state.keys.has("KeyD") || state.keys.has("ArrowRight")) { moveX += right[0]; moveZ += right[2]; }
  if (state.keys.has("KeyA") || state.keys.has("ArrowLeft")) { moveX -= right[0]; moveZ -= right[2]; }
  const len = Math.hypot(moveX, moveZ) || 1;
  const sprinting = state.keys.has("ShiftLeft") || state.keys.has("ShiftRight");
  const speed = state.player.speed * (sprinting ? state.player.sprintMultiplier : 1);
  moveX = moveX / len * speed * dt;
  moveZ = moveZ / len * speed * dt;

  state.player.velocityY -= 9.81 * dt;
  const next = [...state.player.position];
  movePlayerAxis(next, 0, moveX);
  movePlayerAxis(next, 2, moveZ);
  movePlayerAxis(next, 1, state.player.velocityY * dt);
  snapPlayerToGround(next);
  state.player.position = next;
  if (state.player.position[1] < state.player.respawnY) {
    resetPlayerToSpawn();
    if (ui.runtimeStatus) ui.runtimeStatus.textContent = "respawn";
  }
  updateInteractions();
  updatePlayerReadout();
}

function jumpPlayer() {
  if (!state.player.enabled) return;
  if (state.player.grounded) state.player.jumpsUsed = 0;
  if (state.player.jumpsUsed >= state.player.maxJumps) return;
  state.player.velocityY = state.player.jumpSpeed;
  state.player.grounded = false;
  state.player.jumpsUsed += 1;
}

function movePlayerAxis(position, axis, delta) {
  if (Math.abs(delta) < 0.000001) return;
  const before = position[axis];
  position[axis] += delta;
  const hit = playerCollision(position);
  if (hit) {
    position[axis] = before;
    if ((axis === 0 || axis === 2) && state.player.grounded) {
      position[1] += state.player.stepHeight;
      position[axis] += delta;
      if (!playerCollision(position)) {
        state.player.velocityY = 0;
        snapPlayerToGround(position);
        return;
      }
      position[axis] = before;
      position[1] -= state.player.stepHeight;
    }
    if (axis === 1 && delta < 0) {
      state.player.velocityY = 0;
      state.player.grounded = true;
      state.player.jumpsUsed = 0;
    }
  }
}

function snapPlayerToGround(position) {
  if (state.player.velocityY > 0) {
    state.player.grounded = false;
    return;
  }
  let bestY = -Infinity;
  const feetY = position[1] - state.player.height * 0.5;
  const maxSnapUp = state.player.grounded ? 0.85 : 0.18;
  const maxSnapDown = state.player.grounded ? 1.2 : state.player.stepHeight + 0.18;
  for (const item of solidColliders()) {
    const b = item.bounds;
    if (!b?.min || !b?.max) continue;
    if (!circleOverlapsAabb(position[0], position[2], state.player.radius, b.min[0], b.max[0], b.min[2], b.max[2])) continue;
    const groundY = colliderSurfaceY(item, position);
    if (groundY === null) continue;
    if (groundY - feetY <= maxSnapUp && feetY - groundY <= maxSnapDown && groundY > bestY) bestY = groundY;
  }
  if (Number.isFinite(bestY)) {
    position[1] = bestY + state.player.height * 0.5;
    state.player.velocityY = 0;
    state.player.grounded = true;
    state.player.jumpsUsed = 0;
  } else {
    state.player.grounded = false;
  }
}

function playerCollision(position) {
  const minY = position[1] - state.player.height * 0.5;
  const maxY = position[1] + state.player.height * 0.5;
  for (const item of solidColliders()) {
    if (item.physicsMode !== "solid") continue;
    const b = item.bounds;
    if (!b?.min || !b?.max) continue;
    if (maxY <= b.min[1] || minY >= b.max[1]) continue;
    if (circleOverlapsAabb(position[0], position[2], state.player.radius, b.min[0], b.max[0], b.min[2], b.max[2])) {
      return item;
    }
  }
  return null;
}

function solidColliders() {
  return state.meshes
    .map((mesh) => ({ mesh, physicsMode: effectivePhysicsModeForMesh(mesh) }))
    .filter(({ mesh, physicsMode }) => mesh.bounds?.min && mesh.bounds?.max && physicsMode !== "none" && physicsMode !== "trigger")
    .filter(({ mesh, physicsMode }) => physicsMode === "solid" || mesh.collisionTriangles?.length)
    .map(({ mesh, physicsMode }) => ({
      name: mesh.name,
      path: mesh.path,
      mesh: mesh.sourceMesh,
      bounds: mesh.bounds,
      collisionTriangles: physicsMode === "solid" ? [] : mesh.collisionTriangles,
      physicsMode,
    }));
}

function isRampCollider(item) {
  const text = `${item.name || ""} ${item.path || ""}`.toLowerCase();
  return text.includes("scala") || text.includes("ramp") || text.includes("stairs");
}

function colliderSurfaceY(item, position) {
  if (item.physicsMode === "solid") return null;
  let bestY = colliderTriangleSurfaceYAt(item, position[0], position[2]);
  const radius = state.player.radius * 0.85;
  const probes = [
    [radius, 0],
    [-radius, 0],
    [0, radius],
    [0, -radius],
    [radius * 0.7, radius * 0.7],
    [-radius * 0.7, radius * 0.7],
    [radius * 0.7, -radius * 0.7],
    [-radius * 0.7, -radius * 0.7],
  ];
  for (const [dx, dz] of probes) {
    const y = colliderTriangleSurfaceYAt(item, position[0] + dx, position[2] + dz);
    if (y !== null && (bestY === null || y > bestY)) bestY = y;
  }
  return bestY;
}

function colliderTriangleSurfaceY(item, position) {
  return colliderTriangleSurfaceYAt(item, position[0], position[2]);
}

function colliderTriangleSurfaceYAt(item, x, z) {
  let bestY = -Infinity;
  for (const triangles of colliderTriangleSets(item)) {
    for (let i = 0; i + 8 < triangles.length; i += 9) {
      const y = triangleYAtXZ(x, z,
        [triangles[i], triangles[i + 1], triangles[i + 2]],
        [triangles[i + 3], triangles[i + 4], triangles[i + 5]],
        [triangles[i + 6], triangles[i + 7], triangles[i + 8]]
      );
      if (y !== null && y > bestY) bestY = y;
    }
  }
  return Number.isFinite(bestY) ? bestY : null;
}

function colliderTriangleSets(item) {
  const sets = [];
  if (Array.isArray(item.collisionTriangles) && item.collisionTriangles.length) {
    sets.push(item.collisionTriangles);
  }
  for (const collider of item.colliders || []) {
    if (Array.isArray(collider.triangles) && collider.triangles.length) sets.push(collider.triangles);
  }
  const meshTriangles = visualMeshTrianglesForNode(item);
  if (meshTriangles.length) sets.push(meshTriangles);
  return sets;
}

function visualMeshTrianglesForNode(item) {
  if (!item?.mesh) return [];
  const mesh = state.meshes.find((candidate) => candidate.sourceMesh === item.mesh || candidate.path === item.path);
  return mesh?.collisionTriangles || [];
}

function triangleYAtXZ(x, z, a, b, c) {
  if (!isWalkableTriangle(a, b, c)) return null;
  const v0x = b[0] - a[0];
  const v0z = b[2] - a[2];
  const v1x = c[0] - a[0];
  const v1z = c[2] - a[2];
  const v2x = x - a[0];
  const v2z = z - a[2];
  const denom = v0x * v1z - v1x * v0z;
  if (Math.abs(denom) < 0.00001) return null;
  const u = (v2x * v1z - v1x * v2z) / denom;
  const v = (v0x * v2z - v2x * v0z) / denom;
  const w = 1 - u - v;
  const epsilon = -0.03;
  if (u < epsilon || v < epsilon || w < epsilon) return null;
  return a[1] * w + b[1] * u + c[1] * v;
}

function isWalkableTriangle(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return Math.abs(ny) / len > 0.22;
}

function rampSurfaceY(item, position) {
  if (!isRampCollider(item)) return null;
  const b = item.bounds;
  if (!b?.min || !b?.max) return null;
  const spanX = Math.abs(b.max[0] - b.min[0]);
  const spanZ = Math.abs(b.max[2] - b.min[2]);
  const spanY = Math.abs(b.max[1] - b.min[1]);
  if (spanY < 0.1) return b.max[1];
  const t = spanX >= spanZ
    ? clamp((position[0] - b.min[0]) / Math.max(spanX, 0.001), 0, 1)
    : clamp((position[2] - b.min[2]) / Math.max(spanZ, 0.001), 0, 1);
  return b.min[1] + t * spanY;
}

function circleOverlapsAabb(x, z, radius, minX, maxX, minZ, maxZ) {
  const cx = clamp(x, minX, maxX);
  const cz = clamp(z, minZ, maxZ);
  return (x - cx) * (x - cx) + (z - cz) * (z - cz) <= radius * radius;
}

function updateInteractions() {
  const labels = [];
  state.nearbyTeleport = nearestTeleportTarget();
  state.nearbyTrigger = null;
  if (state.nearbyTeleport) labels.push(`E teleport: ${state.nearbyTeleport.name || "target"}`);
  for (const item of state.runtime?.interactions?.triggers || []) {
    if (playerOverlapsBounds(item.bounds)) {
      state.nearbyTrigger = item;
      labels.push(`E trigger: ${item.name}`);
    }
  }
  for (const item of state.runtime?.interactions?.collectibles || []) {
    if (playerOverlapsBounds(item.bounds)) labels.push(`collect: ${item.name}`);
  }
  if (ui.interactionStatus) ui.interactionStatus.textContent = labels[0] || "no interaction";
}

function nearestTeleportTarget() {
  if (!state.player.enabled) return null;
  const p = state.player.position;
  let best = null;
  let bestDistance = Infinity;
  for (const target of runtimeTeleportTargets()) {
    const dx = p[0] - target.position[0];
    const dz = p[2] - target.position[2];
    const dy = Math.abs((p[1] - state.player.height * 0.5) - target.position[1]);
    const dist = Math.hypot(dx, dz);
    const radius = clamp((target.radius || 2) * 0.5, 1.4, 5.5);
    if (dist <= radius && dy <= 3.5 && dist < bestDistance) {
      best = target;
      bestDistance = dist;
    }
  }
  return best;
}

function playerOverlapsBounds(bounds) {
  if (!bounds?.min || !bounds?.max) return false;
  const p = state.player.position;
  const minY = p[1] - state.player.height * 0.5;
  const maxY = p[1] + state.player.height * 0.5;
  if (maxY < bounds.min[1] || minY > bounds.max[1]) return false;
  return circleOverlapsAabb(p[0], p[2], state.player.radius, bounds.min[0], bounds.max[0], bounds.min[2], bounds.max[2]);
}

function updatePlayerReadout() {
  if (!ui.playerPosition) return;
  if (!state.player.enabled) {
    ui.playerPosition.textContent = "orbit camera";
    return;
  }
  const p = state.player.position.map((value) => value.toFixed(1));
  const jumpText = state.player.grounded ? "grounded" : `air ${state.player.jumpsUsed}/${state.player.maxJumps}`;
  const speedText = (state.keys.has("ShiftLeft") || state.keys.has("ShiftRight")) ? "run" : "walk";
  const cameraText = state.player.thirdPerson ? "TP" : "FP";
  ui.playerPosition.textContent = `player ${p[0]}, ${p[1]}, ${p[2]} ${jumpText} ${speedText} ${cameraText}`;
}

function robustCameraMeshes(meshes) {
  if (meshes.length < 8) return meshes;
  const centers = meshes.map((mesh) => boundsCenter(mesh.bounds));
  const median = [medianOf(centers.map((p) => p[0])), medianOf(centers.map((p) => p[1])), medianOf(centers.map((p) => p[2]))];
  const ranked = meshes
    .map((mesh) => ({ mesh, distance: distance(boundsCenter(mesh.bounds), median), size: boundsSize(mesh.bounds) }))
    .filter((item) => item.size < 2500)
    .sort((a, b) => a.distance - b.distance);
  const keepCount = Math.max(8, Math.ceil(ranked.length * 0.92));
  return ranked.slice(0, keepCount).map((item) => item.mesh);
}

function render() {
  const now = performance.now() * 0.001;
  const dt = clamp(now - state.lastFrameTime, 0.001, 0.05);
  state.lastFrameTime = now;
  updatePlayer(dt);

  resizeCanvas();
  gl.viewport(0, 0, canvas.width, canvas.height);
  drawSkyBackground();
  gl.clear(gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  if (state.cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);

  const aspect = canvas.width / Math.max(canvas.height, 1);
  const projection = perspective(45 * Math.PI / 180, aspect, 0.1, Math.max(4000, state.distance * 6));
  const camera = currentCamera();
  const eye = camera.eye;
  const view = lookAt(camera.eye, camera.target, [0, 1, 0]);

  gl.useProgram(program);
  gl.uniformMatrix4fv(loc.uProjection, false, projection);
  gl.uniformMatrix4fv(loc.uView, false, view);
  gl.uniform1f(loc.uExposure, state.exposure);
  gl.uniform1f(loc.uSceneScale, state.sceneScale);
  gl.uniform3fv(loc.uSkyColor, scaleColor(state.lighting.skyColor, state.ambientStrength));
  gl.uniform3fv(loc.uGroundColor, scaleColor(state.lighting.groundColor, state.ambientStrength));
  gl.uniform3fv(loc.uEye, eye);
  gl.uniform1f(loc.uReflectionScale, state.reflectionStrength);
  gl.uniform1f(loc.uSpecularScale, state.specularStrength);
  applyLightingUniforms();

  drawMeshes(state.meshes.filter((mesh) => !mesh.hasTransparent), false, now);
  drawMeshes(sortedTransparentMeshes(eye), true, now);
  drawRuntimeDebug(projection, view);

  requestAnimationFrame(render);
}

function drawSkyBackground() {
  if (skyCanvas.width !== canvas.width || skyCanvas.height !== canvas.height) {
    skyCanvas.width = canvas.width;
    skyCanvas.height = canvas.height;
  }

  const bg = skyCtx.createLinearGradient(0, 0, 0, skyCanvas.height);
  bg.addColorStop(0, "#1b2026");
  bg.addColorStop(0.42, "#34454c");
  bg.addColorStop(1, "#647f83");
  skyCtx.fillStyle = bg;
  skyCtx.fillRect(0, 0, skyCanvas.width, skyCanvas.height);

  const haze = skyCtx.createRadialGradient(
    skyCanvas.width * 0.48,
    skyCanvas.height * 0.2,
    0,
    skyCanvas.width * 0.48,
    skyCanvas.height * 0.2,
    Math.max(skyCanvas.width, skyCanvas.height) * 0.72
  );
  haze.addColorStop(0, "rgba(238, 210, 235, 0.28)");
  haze.addColorStop(0.48, "rgba(150, 190, 205, 0.1)");
  haze.addColorStop(1, "rgba(0, 0, 0, 0)");
  skyCtx.fillStyle = haze;
  skyCtx.fillRect(0, 0, skyCanvas.width, skyCanvas.height);

  const pixels = new Uint8Array(skyCanvas.width * skyCanvas.height * 4);
  const imageData = skyCtx.getImageData(0, 0, skyCanvas.width, skyCanvas.height);
  pixels.set(imageData.data);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  if (!drawSkyBackground.texture) {
    drawSkyBackground.texture = gl.createTexture();
  }
  if (!drawSkyBackground.program) {
    drawSkyBackground.program = createProgram(`
      attribute vec2 aPosition;
      varying vec2 vUv;
      void main() {
        vUv = aPosition * 0.5 + 0.5;
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }
    `, `
      precision mediump float;
      uniform sampler2D uTexture;
      varying vec2 vUv;
      void main() {
        gl_FragColor = texture2D(uTexture, vec2(vUv.x, 1.0 - vUv.y));
      }
    `);
    drawSkyBackground.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, drawSkyBackground.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
  }
  gl.useProgram(drawSkyBackground.program);
  gl.bindTexture(gl.TEXTURE_2D, drawSkyBackground.texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, skyCanvas.width, skyCanvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const pos = gl.getAttribLocation(drawSkyBackground.program, "aPosition");
  gl.bindBuffer(gl.ARRAY_BUFFER, drawSkyBackground.buffer);
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(gl.getUniformLocation(drawSkyBackground.program, "uTexture"), 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.enable(gl.DEPTH_TEST);
}
function drawMeshes(meshes, transparentPass, time) {
  gl.depthMask(!transparentPass);
  for (const mesh of meshes) {
    gl.uniformMatrix4fv(loc.uModel, false, animatedModel(mesh, time));

    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.positionBuffer);
    gl.enableVertexAttribArray(loc.aPosition);
    gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normalBuffer);
    gl.enableVertexAttribArray(loc.aNormal);
    gl.vertexAttribPointer(loc.aNormal, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuffer);
    gl.enableVertexAttribArray(loc.aUv);
    gl.vertexAttribPointer(loc.aUv, 2, gl.FLOAT, false, 0, 0);

    const groups = mesh.groups.length ? mesh.groups : [{ start: 0, count: mesh.count, materialIndex: 0 }];
    for (const group of groups) {
      const material = mesh.materials[group.materialIndex] || mesh.materials[0];
      if (transparentPass !== material.transparent) continue;
      gl.uniform4fv(loc.uColor, material.color);
      gl.uniform1f(loc.uHasTexture, material.texture ? 1 : 0);
      gl.uniform1f(loc.uHasNormalTexture, material.normalTexture ? 1 : 0);
      gl.uniform1f(loc.uNormalScale, material.normalScale * state.normalStrength);
      gl.uniform1f(loc.uWater, material.semantic === "water" ? 1 : 0);
      gl.uniform1f(loc.uGlass, material.semantic === "glass" ? 1 : 0);
      gl.uniform1f(loc.uSmoothness, material.smoothness);
      gl.uniform1f(loc.uMetallic, material.metallic);
      gl.uniform1f(loc.uReflective, material.reflective);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, material.texture || defaultTexture());
      gl.uniform1i(loc.uTexture, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, material.normalTexture || defaultTexture());
      gl.uniform1i(loc.uNormalTexture, 1);
      gl.drawArrays(state.wire ? gl.LINES : gl.TRIANGLES, group.start, group.count);
    }
  }
  gl.depthMask(true);
}

function animatedModel(mesh, time) {
  const rotations = matchingLoopRotations(mesh.path);
  const transforms = matchingTransformAnimations(mesh.path);
  if (!rotations.length && !transforms.length) return mesh.baseModel || mesh.model;

  let model = mesh.baseModel || mesh.model;
  for (const rotation of rotations) {
    const amount = time * (Number(rotation.radiansPerSecond) || 0);
    model = multiplyMatrix4(model, axisRotationMatrix(rotation.axis, amount));
  }
  for (const animation of transforms) {
    const amount = transformAnimationAmount(animation, time);
    model = multiplyMatrix4(model, axisRotationMatrix(animation.axis, amount));
  }
  return model;
}

function matchingLoopRotations(path) {
  if (!path || !state.loopRotations.length) return [];
  return state.loopRotations.filter((rotation) => {
    const target = rotation.targetPath || "";
    return target && (path === target || path.startsWith(`${target}/`));
  });
}

function matchingTransformAnimations(path) {
  if (!path || !state.transformAnimations.length) return [];
  return state.transformAnimations.filter((animation) => {
    const target = animation.targetPath || "";
    return target && (path === target || path.startsWith(`${target}/`));
  });
}

function transformAnimationAmount(animation, time) {
  const duration = Math.max(Number(animation.duration) || 1, 0.0001);
  let t = (time % duration) / duration;
  if (animation.previewMode === "pingPong") {
    const cycle = (time % (duration * 2)) / duration;
    t = cycle <= 1 ? cycle : 2 - cycle;
  }
  const from = Number(animation.fromRadians) || 0;
  const to = Number(animation.toRadians) || 0;
  const eased = t * t * (3 - 2 * t);
  return from + (to - from) * eased;
}

function drawRuntimeDebug(projection, view) {
  const lines = runtimeDebugLines();
  if (!lines.length) return;
  if (!drawRuntimeDebug.program) {
    drawRuntimeDebug.program = createProgram(`
      attribute vec3 aPosition;
      uniform mat4 uProjection;
      uniform mat4 uView;
      uniform vec4 uColor;
      varying vec4 vColor;
      void main() {
        vColor = uColor;
        gl_Position = uProjection * uView * vec4(aPosition, 1.0);
      }
    `, `
      precision mediump float;
      varying vec4 vColor;
      void main() {
        gl_FragColor = vColor;
      }
    `);
    drawRuntimeDebug.position = gl.getAttribLocation(drawRuntimeDebug.program, "aPosition");
    drawRuntimeDebug.uProjection = gl.getUniformLocation(drawRuntimeDebug.program, "uProjection");
    drawRuntimeDebug.uView = gl.getUniformLocation(drawRuntimeDebug.program, "uView");
    drawRuntimeDebug.uColor = gl.getUniformLocation(drawRuntimeDebug.program, "uColor");
    drawRuntimeDebug.buffer = gl.createBuffer();
  }

  gl.useProgram(drawRuntimeDebug.program);
  gl.uniformMatrix4fv(drawRuntimeDebug.uProjection, false, projection);
  gl.uniformMatrix4fv(drawRuntimeDebug.uView, false, view);
  gl.bindBuffer(gl.ARRAY_BUFFER, drawRuntimeDebug.buffer);
  gl.enableVertexAttribArray(drawRuntimeDebug.position);
  gl.vertexAttribPointer(drawRuntimeDebug.position, 3, gl.FLOAT, false, 0, 0);
  gl.disable(gl.CULL_FACE);
  gl.depthMask(false);
  gl.lineWidth(1);

  for (const group of lines) {
    gl.uniform4fv(drawRuntimeDebug.uColor, group.color);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(group.points), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.LINES, 0, group.points.length / 3);
  }

  gl.depthMask(true);
}

function runtimeDebugLines() {
  if (!state.runtime) return [];
  if (state.runtimeLineCache && !state.player.enabled) return state.runtimeLineCache;
  const groups = [];
  if (state.runtimeDebug.colliders) {
    groups.push({ color: [0.47, 0.96, 0.83, 0.72], points: meshColliderDebugLines() });
  }
  if (state.runtimeDebug.spawn && !state.player.enabled) {
    groups.push({ color: [0.88, 1.0, 0.62, 1.0], points: markerLines(runtimeSpawnMarker(), 3.2) });
  }
  if (state.player.enabled) {
    groups.push({ color: [0.78, 1.0, 0.52, 1.0], points: playerLines() });
  }
  if (state.selectedObjectBounds || state.selectedRuntimeNodes.length) {
    groups.push({ color: [1.0, 0.78, 0.28, 1.0], points: selectedColliderLines() });
    groups.push({ color: [0.38, 0.92, 1.0, 0.82], points: selectedTriangleLines() });
  }
  if (state.runtimeDebug.teleport) {
    groups.push({ color: [0.55, 0.74, 1.0, 0.9], points: markerLines(state.runtime.navigation?.teleport || [], 2.2) });
  }
  if (state.nearbyTeleport) {
    groups.push({ color: [0.95, 1.0, 0.42, 1.0], points: markerLines([state.nearbyTeleport], 4.2) });
  }
  if (state.runtimeDebug.triggers) {
    const triggers = state.runtime.interactions?.triggers || [];
    groups.push({ color: [1.0, 0.46, 0.58, 0.84], points: boundsLines(triggers.map((item) => item.bounds)).concat(markerLines(triggers, 1.3)) });
  }
  if (state.runtimeDebug.collectibles) {
    const collectibles = state.runtime.interactions?.collectibles || [];
    groups.push({ color: [1.0, 0.78, 0.36, 0.92], points: boundsLines(collectibles.map((item) => item.bounds)).concat(markerLines(collectibles, 1.1)) });
  }
  const result = groups.filter((group) => group.points.length > 0);
  if (!state.player.enabled) state.runtimeLineCache = result;
  return result;
}

function playerLines() {
  const p = state.player.position;
  const r = state.player.radius;
  const footY = p[1] - state.player.height * 0.5;
  const headY = p[1] + state.player.height * 0.5;
  const midY = p[1];
  const points = [];
  addRingLines(points, [p[0], footY, p[2]], r, 24);
  addRingLines(points, [p[0], midY, p[2]], r, 24);
  addRingLines(points, [p[0], headY, p[2]], r, 24);
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    const x = p[0] + Math.cos(a) * r;
    const z = p[2] + Math.sin(a) * r;
    addLine(points, [x, footY, z], [x, headY, z]);
  }
  return points;
}

function selectedColliderLines() {
  const bounds = [
    state.selectedObjectBounds,
    ...state.selectedRuntimeNodes.map((node) => node.bounds),
  ].filter(Boolean);
  return boundsLines(bounds);
}

function selectedTriangleLines() {
  const points = [];
  for (const node of state.selectedRuntimeNodes) {
    for (const triangles of colliderTriangleSets(node)) {
      const stride = Math.max(9, Math.ceil(triangles.length / (9 * 240)) * 9);
      for (let i = 0; i + 8 < triangles.length; i += stride) {
        const a = [triangles[i], triangles[i + 1], triangles[i + 2]];
        const b = [triangles[i + 3], triangles[i + 4], triangles[i + 5]];
        const c = [triangles[i + 6], triangles[i + 7], triangles[i + 8]];
        addLine(points, a, b);
        addLine(points, b, c);
        addLine(points, c, a);
      }
    }
  }
  return points;
}

function meshColliderDebugLines() {
  const points = [];
  for (const mesh of state.meshes) {
    const mode = effectivePhysicsModeForMesh(mesh);
    if (mode === "none" || mode === "trigger" || mode === "solid") continue;
    const triangles = mesh.collisionTriangles || [];
    const stride = Math.max(9, Math.ceil(triangles.length / (9 * 36)) * 9);
    for (let i = 0; i + 8 < triangles.length; i += stride) {
      const a = [triangles[i], triangles[i + 1], triangles[i + 2]];
      const b = [triangles[i + 3], triangles[i + 4], triangles[i + 5]];
      const c = [triangles[i + 6], triangles[i + 7], triangles[i + 8]];
      if (!isWalkableTriangle(a, b, c)) continue;
      addLine(points, a, b);
      addLine(points, b, c);
      addLine(points, c, a);
    }
  }
  return points;
}

function boundsLines(boundsItems) {
  const points = [];
  for (const bounds of boundsItems) {
    if (!bounds || !bounds.min || !bounds.max) continue;
    addBoxLines(points, bounds.min, bounds.max);
  }
  return points;
}

function markerLines(items, size) {
  const points = [];
  for (const item of items) {
    const p = item.position || centerFromBounds(item.bounds);
    if (!p) continue;
    const s = size;
    addLine(points, [p[0] - s, p[1], p[2]], [p[0] + s, p[1], p[2]]);
    addLine(points, [p[0], p[1] - s, p[2]], [p[0], p[1] + s, p[2]]);
    addLine(points, [p[0], p[1], p[2] - s], [p[0], p[1], p[2] + s]);
  }
  return points;
}

function addRingLines(points, center, radius, segments) {
  for (let i = 0; i < segments; i++) {
    const a = i / segments * Math.PI * 2;
    const b = (i + 1) / segments * Math.PI * 2;
    addLine(
      points,
      [center[0] + Math.cos(a) * radius, center[1], center[2] + Math.sin(a) * radius],
      [center[0] + Math.cos(b) * radius, center[1], center[2] + Math.sin(b) * radius]
    );
  }
}

function addBoxLines(points, min, max) {
  const c = [
    [min[0], min[1], min[2]],
    [max[0], min[1], min[2]],
    [max[0], max[1], min[2]],
    [min[0], max[1], min[2]],
    [min[0], min[1], max[2]],
    [max[0], min[1], max[2]],
    [max[0], max[1], max[2]],
    [min[0], max[1], max[2]],
  ];
  for (const [a, b] of [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]) {
    addLine(points, c[a], c[b]);
  }
}

function addLine(points, a, b) {
  points.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

function centerFromBounds(bounds) {
  if (!bounds || !bounds.min || !bounds.max) return null;
  return [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  ];
}
function sortedTransparentMeshes(eye) {
  return state.meshes
    .filter((mesh) => mesh.hasTransparent)
    .slice()
    .sort((a, b) => squaredDistance(eye, boundsCenter(b.bounds)) - squaredDistance(eye, boundsCenter(a.bounds)));
}

function boundsCenter(bounds) {
  return [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  ];
}

function squaredDistance(a, b) {
  const x = a[0] - b[0];
  const y = a[1] - b[1];
  const z = a[2] - b[2];
  return x * x + y * y + z * z;
}
function orbitEye() {
  const cp = Math.cos(state.pitch);
  return [
    state.target[0] + Math.sin(state.yaw) * cp * state.distance,
    state.target[1] + Math.sin(state.pitch) * state.distance,
    state.target[2] + Math.cos(state.yaw) * cp * state.distance,
  ];
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  state.dragging = true;
  state.pointerLook = state.player.enabled;
  state.lastX = event.clientX;
  state.lastY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (!state.dragging) return;
  const dx = event.clientX - state.lastX;
  const dy = event.clientY - state.lastY;
  state.lastX = event.clientX;
  state.lastY = event.clientY;
  if (state.pointerLook) {
    applyPlayerLook(dx, dy);
  } else {
    state.yaw -= dx * 0.006;
    state.pitch = clamp(state.pitch - dy * 0.006, -1.35, 1.35);
  }
});
canvas.addEventListener("pointerup", () => {
  state.dragging = false;
  state.pointerLook = false;
});
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  if (state.player.enabled) return;
  state.distance = clamp(state.distance * (event.deltaY > 0 ? 1.08 : 0.92), 4, 2500);
}, { passive: false });

function applyPlayerLook(dx, dy) {
  state.player.yaw -= dx * 0.006;
  state.player.pitch = clamp(state.player.pitch - dy * 0.006, -1.15, 1.15);
}

function movementCode(event) {
  if (event.code === "Space" || event.key === " " || event.key === "Spacebar") return "Space";
  return event.code;
}

window.addEventListener("keydown", (event) => {
  const code = movementCode(event);
  if (code === "KeyE" && state.player.enabled) {
    activateNearestInteraction();
    event.preventDefault();
    return;
  }
  if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "ShiftLeft", "ShiftRight"].includes(code)) {
    if (code === "Space" && !state.keys.has("Space")) jumpPlayer();
    state.keys.add(code);
    if (state.player.enabled) event.preventDefault();
  }
});
window.addEventListener("keyup", (event) => {
  state.keys.delete(movementCode(event));
});

ui.resetView.addEventListener("click", fitCameraFromScene);
ui.toggleWire.addEventListener("click", () => { state.wire = !state.wire; });
ui.toggleCull.addEventListener("click", () => { state.cull = !state.cull; });
bindRange(ui.exposure, null, (value) => { state.exposure = value; });
bindRange(ui.sceneScale, null, (value) => { state.sceneScale = value; });
bindRange(ui.ambientStrength, ui.ambientValue, (value) => { state.ambientStrength = value; });
bindRange(ui.lightStrength, ui.lightValue, (value) => { state.lightStrength = value; });
bindRange(ui.reflectionStrength, ui.reflectionValue, (value) => { state.reflectionStrength = value; });
bindRange(ui.specularStrength, ui.specularValue, (value) => { state.specularStrength = value; });
bindRange(ui.normalStrength, ui.normalValue, (value) => { state.normalStrength = value; });

ui.filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.objectFilter = button.dataset.filter || "all";
    ui.filterButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    populateObjectList(state.allObjects);
  });
});
if (ui.objectSearch) {
  ui.objectSearch.addEventListener("input", () => {
    state.objectSearch = ui.objectSearch.value;
    populateObjectList(state.allObjects);
  });
}
if (ui.nextTeleport) {
  ui.nextTeleport.addEventListener("click", jumpToNextTeleport);
}
if (ui.togglePlayer) {
  ui.togglePlayer.addEventListener("click", togglePlayerMode);
}
if (ui.toggleThirdPerson) {
  ui.toggleThirdPerson.addEventListener("click", toggleThirdPersonMode);
}
ui.physicsOverrideButtons.forEach((button) => {
  button.addEventListener("click", () => setSelectedPhysicsMode(button.dataset.physicsMode || "auto"));
});
if (ui.savePhysicalMap) {
  ui.savePhysicalMap.addEventListener("click", downloadPhysicalMap);
}
if (ui.loadPhysicalMap && ui.physicalMapFile) {
  ui.loadPhysicalMap.addEventListener("click", () => ui.physicalMapFile.click());
  ui.physicalMapFile.addEventListener("change", async () => {
    const file = ui.physicalMapFile.files?.[0];
    if (!file) return;
    try {
      loadPhysicalMapFromText(await file.text());
    } catch (error) {
      console.warn("Invalid physical map", error);
      if (ui.runtimeStatus) ui.runtimeStatus.textContent = "invalid physical map";
    } finally {
      ui.physicalMapFile.value = "";
    }
  });
}
if (ui.clearPhysicalMap) {
  ui.clearPhysicalMap.addEventListener("click", clearPhysicalMap);
}
ui.runtimeDebugButtons.forEach((button) => {
  const key = button.dataset.debug;
  button.classList.toggle("is-active", Boolean(state.runtimeDebug[key]));
  button.addEventListener("click", () => {
    state.runtimeDebug[key] = !state.runtimeDebug[key];
    button.classList.toggle("is-active", state.runtimeDebug[key]);
    state.runtimeLineCache = null;
  });
});

function bindRange(input, output, apply) {
  if (!input) return;
  const update = () => {
    const value = Number(input.value);
    apply(value);
    if (output) output.textContent = value.toFixed(2);
  };
  input.addEventListener("input", update);
  update();
}

function scaleColor(color, scale) {
  return [color[0] * scale, color[1] * scale, color[2] * scale];
}

function scaleLightColor(color, scale) {
  return [color[0] * scale, color[1] * scale, color[2] * scale, color[3]];
}
function isPowerOfTwo(value) {
  return (value & (value - 1)) === 0;
}

function defaultTexture() {
  if (defaultTexture.value) return defaultTexture.value;
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  defaultTexture.value = texture;
  return texture;
}

function defaultLighting() {
  return {
    skyColor: [0.86, 0.75, 0.9],
    groundColor: [0.08, 0.33, 0.36],
    ambientIntensity: 1,
    lights: [
      { type: "Directional", data: [0.35, 0.75, 0.45, 0], color: [0.62, 0.58, 0.5, 1] },
      { type: "Directional", data: [-0.65, 0.2, -0.55, 0], color: [0.16, 0.18, 0.22, 1] },
    ],
  };
}

function normalizeLighting(source) {
  const fallback = defaultLighting();
  if (!source) return fallback;
  const ambientBoost = clamp(Number(source.ambientIntensity ?? 1), 0.15, 2.5);
  const sky = color3(source.ambientSkyColor || source.ambientLight || fallback.skyColor, fallback.skyColor, ambientBoost);
  const ground = color3(source.ambientGroundColor || source.ambientEquatorColor || fallback.groundColor, fallback.groundColor, ambientBoost * 0.75);
  const lights = (source.lights || [])
    .filter((light) => light && Array.isArray(light.color))
    .slice(0, MAX_LIGHTS)
    .map((light) => {
      const type = String(light.type || "Directional").toLowerCase();
      const isDirectional = type.includes("directional");
      const data = isDirectional
        ? [...normalize3(light.directionToLight || [0.35, 0.75, 0.45]), 0]
        : [...vec3(light.position || [0, 20, 0]), 1];
      const intensity = clamp(Number(light.intensity ?? 1), 0, 8);
      const range = Math.max(Number(light.range ?? 40), 0.001);
      return {
        type: light.type || "Directional",
        data,
        color: [
          clamp((light.color[0] ?? 1) * intensity, 0, 6),
          clamp((light.color[1] ?? 1) * intensity, 0, 6),
          clamp((light.color[2] ?? 1) * intensity, 0, 6),
          range,
        ],
      };
    });
  return { skyColor: sky, groundColor: ground, ambientIntensity: ambientBoost, lights: lights.length ? lights : fallback.lights };
}

function applyLightingUniforms() {
  const lights = state.lighting.lights.slice(0, MAX_LIGHTS);
  gl.uniform1i(loc.uLightCount, lights.length);
  for (let i = 0; i < MAX_LIGHTS; i++) {
    const light = lights[i] || { data: [0, 1, 0, 0], color: [0, 0, 0, 1] };
    gl.uniform4fv(loc.uLightData[i], light.data);
    gl.uniform4fv(loc.uLightColor[i], scaleLightColor(light.color, state.lightStrength));
  }
}

function color3(value, fallback, scale = 1) {
  const base = Array.isArray(value) && value.length >= 3 ? value : fallback;
  return [clamp(base[0] * scale, 0.02, 1.8), clamp(base[1] * scale, 0.02, 1.8), clamp(base[2] * scale, 0.02, 1.8)];
}

function vec3(value) {
  return Array.isArray(value) && value.length >= 3 ? [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0] : [0, 0, 0];
}

function normalize3(value) {
  const v = vec3(value);
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
async function fetchJson(url) { return (await fetch(url)).json(); }
async function fetchOptionalJson(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  }
}
async function fetchText(url) { return (await fetch(url)).text(); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function loadPhysicsOverrides() {
  try {
    const saved = JSON.parse(localStorage.getItem(PHYSICS_OVERRIDE_STORAGE) || "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch (_) {
    return {};
  }
}

function savePhysicsOverrides() {
  localStorage.setItem(PHYSICS_OVERRIDE_STORAGE, JSON.stringify(state.physicsOverrides));
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.floor(canvas.clientWidth * dpr);
  const height = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function createProgram(vsSource, fsSource) {
  const vs = compile(gl.VERTEX_SHADER, vsSource);
  const fs = compile(gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  return program;
}

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

function composeMatrix(p, r, s) {
  const [sx, sy, sz] = s;
  const [x, y, z] = r;
  const cx = Math.cos(x), sxr = Math.sin(x);
  const cy = Math.cos(y), syr = Math.sin(y);
  const cz = Math.cos(z), szr = Math.sin(z);
  const m00 = cy * cz;
  const m01 = sxr * syr * cz + cx * szr;
  const m02 = -cx * syr * cz + sxr * szr;
  const m10 = -cy * szr;
  const m11 = -sxr * syr * szr + cx * cz;
  const m12 = cx * syr * szr + sxr * cz;
  const m20 = syr;
  const m21 = -sxr * cy;
  const m22 = cx * cy;
  return new Float32Array([
    m00 * sx, m01 * sx, m02 * sx, 0,
    m10 * sy, m11 * sy, m12 * sy, 0,
    m20 * sz, m21 * sz, m22 * sz, 0,
    p[0], p[1], p[2], 1,
  ]);
}

function axisRotationMatrix(axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  if (axis === "x") {
    return new Float32Array([
      1, 0, 0, 0,
      0, c, s, 0,
      0, -s, c, 0,
      0, 0, 0, 1,
    ]);
  }
  if (axis === "y") {
    return new Float32Array([
      c, 0, -s, 0,
      0, 1, 0, 0,
      s, 0, c, 0,
      0, 0, 0, 1,
    ]);
  }
  return new Float32Array([
    c, s, 0, 0,
    -s, c, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

function multiplyMatrix4(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, (2 * far * near) * nf, 0,
  ]);
}

function lookAt(eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}









