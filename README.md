# SpatialExporter

SpatialExporter is a local Unity-to-web export tool for converting Unity scenes into browser-ready physical scene data.

Current phase: **physical export**. The tool exports meshes, baked skinned meshes, colliders, material data, textures, lights, a WebGL viewer, and WebXR-oriented runtime metadata.

## What It Produces

- `scene.json`: visual scene data exported from Unity
- `meshes/*.obj`: exported mesh geometry
- `textures/*`: material textures copied from Unity assets
- `spatial.scene.json`: semantic scene map with nodes, materials, colliders, lights and interaction candidates
- `webxr.runtime.json`: compact runtime contract for teleport, triggers, collectibles, colliders and material roles
- `<SceneName>_Viewer`: generated WebGL debug viewer

## Physical Data

SpatialExporter preserves Unity physical metadata needed by a WebXR runtime:

- GameObject tag, layer, layer name and static flag
- enabled colliders, including trigger colliders
- collider type, trigger state, physics material, world bounds and local shape data
- `BoxCollider`, `SphereCollider`, `CapsuleCollider` and `MeshCollider` details where Unity exposes them
- Rigidbody presence, mass, gravity, kinematic state, drag, collision mode, interpolation and constraints

In `webxr.runtime.json`, solid colliders and trigger colliders are separated:

- `physics.colliders`
- `physics.triggerColliders`

## Included Pieces

- `spatialExporter.js`: CLI entrypoint
- `unity/SpatialThreePhysicalExporter.cs`: Unity editor bridge
- `viewer-template/`: generated viewer template
- `launcher/`: local browser UI for selecting a Unity project/scene and running exports

## CLI Usage

```powershell
node .\spatialExporter.js --project "C:\Path\To\UnityProject" --scene "Assets/Path/Scene.unity"
```

Optional flags:

- `--out <dir>`: physical export output folder
- `--viewer <dir>`: generated viewer output folder
- `--unity <path>`: explicit `Unity.exe`
- `--template <dir>`: override viewer template
- `--force-install`: overwrite the Unity bridge in `Assets/Editor`
- `--metadata-only`: rebuild `spatial.scene.json` and `webxr.runtime.json` from an existing `scene.json` without launching Unity

## Launcher

```powershell
node .\launcher\server.js
```

Then open the local launcher URL printed by the server. The launcher can scan scenes in a Unity project and run the physical export.

## Unity Bridge

On export, the CLI checks the target Unity project for `Assets/Editor/SpatialThreePhysicalExporter.cs`.
If the bridge is missing, it installs the bundled version from `unity/`.

Unity must not already have the same project open when the CLI runs in batch mode.

## Current Viewer Features

- raw WebGL scene loading
- material color/texture/normal handling
- lighting and exposure controls
- transparent/water/glass material heuristics
- object list and semantic filters
- runtime debug overlays for colliders, teleport, triggers and collectibles

## Roadmap

- export richer Unity collider/tag/layer/component data
- build a dedicated WebXR player runtime
- replace OBJ transport with glTF/GLB
- improve PBR material fidelity, reflections and transparency
- map Spatial SDK components instead of relying on names
- package generated scenes for deployment
