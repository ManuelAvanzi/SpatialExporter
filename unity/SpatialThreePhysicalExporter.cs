using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEditor.SceneManagement;

public static class SpatialThreePhysicalExporter
{
    private const string MenuPath = "Tools/Spatial Reload/Export BODYLAB3 Physical Objects";
    private const string BodyLab3ScenePath = "Assets/Examples/BODYLAB3/BodyLab3_Scene.unity";

    [MenuItem(MenuPath)]
    public static void ExportBodyLab3ScenePhysicalObjects()
    {
        EditorSceneManager.OpenScene(BodyLab3ScenePath, OpenSceneMode.Single);
        ExportActiveScenePhysicalObjects();
    }

    public static void ExportFromSpatialExporterArgs()
    {
        string scenePath = GetCommandLineValue("-spatialScene", BodyLab3ScenePath);
        string exportRoot = GetCommandLineValue("-spatialOut", string.Empty);
        EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
        ExportActiveScenePhysicalObjects(string.IsNullOrWhiteSpace(exportRoot) ? null : exportRoot, false);
    }

    public static void ExportActiveScenePhysicalObjects()
    {
        ExportActiveScenePhysicalObjects(null, true);
    }

    private static void ExportActiveScenePhysicalObjects(string explicitExportRoot, bool revealInFinder)
    {
        Scene scene = SceneManager.GetActiveScene();
        if (!scene.IsValid())
        {
            Debug.LogError("No active scene is loaded.");
            return;
        }

        string projectRoot = Directory.GetParent(Application.dataPath).FullName;
        string exportRoot = string.IsNullOrWhiteSpace(explicitExportRoot)
            ? Path.Combine(projectRoot, "ThreeExport", SanitizeFileName(scene.name) + "_Physical")
            : explicitExportRoot;
        string meshDir = Path.Combine(exportRoot, "meshes");
        string textureDir = Path.Combine(exportRoot, "textures");
        Directory.CreateDirectory(meshDir);
        Directory.CreateDirectory(textureDir);

        var export = new SceneExport
        {
            sceneName = scene.name,
            exportedAtUtc = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
            unityVersion = Application.unityVersion,
            coordinateSystem = "Unity converted to Three-friendly OBJ coordinates: x,y,-z with reversed triangle winding.",
            objects = new List<PhysicalObjectExport>(),
            entrancePoints = ExportEntrancePoints(scene),
            behaviours = ExportBehaviours(scene),
            lighting = ExportLighting(scene)
        };

        var roots = scene.GetRootGameObjects();
        int meshIndex = 0;
        foreach (GameObject root in roots)
        {
            Traverse(root.transform, export.objects, meshDir, textureDir, ref meshIndex);
        }
        ExportAnimatedRenderers(scene, export.objects, meshDir, textureDir, ref meshIndex);

        string json = JsonUtility.ToJson(export, true);
        File.WriteAllText(Path.Combine(exportRoot, "scene.json"), json, Encoding.UTF8);

        AssetDatabase.Refresh();
        Debug.Log($"Exported {export.objects.Count} physical objects to: {exportRoot}");
        if (revealInFinder)
        {
            EditorUtility.RevealInFinder(exportRoot);
        }
    }

    private static SceneLightingExport ExportLighting(Scene scene)
    {
        var lights = new List<LightExport>();
        foreach (GameObject root in scene.GetRootGameObjects())
        {
            Light[] found = root.GetComponentsInChildren<Light>(true);
            foreach (Light light in found)
            {
                if (light == null || !light.enabled || !light.gameObject.activeInHierarchy)
                {
                    continue;
                }

                lights.Add(new LightExport
                {
                    name = light.name,
                    hierarchyPath = GetHierarchyPath(light.transform),
                    type = light.type.ToString(),
                    color = FloatArray(light.color.r, light.color.g, light.color.b, 1f),
                    intensity = light.intensity,
                    range = light.range,
                    spotAngle = light.spotAngle,
                    position = ConvertPosition(light.transform.position),
                    directionToLight = ConvertDirection(-light.transform.forward)
                });
            }
        }

        Material skybox = RenderSettings.skybox;
        return new SceneLightingExport
        {
            ambientMode = RenderSettings.ambientMode.ToString(),
            ambientSkyColor = FloatArray(RenderSettings.ambientSkyColor.r, RenderSettings.ambientSkyColor.g, RenderSettings.ambientSkyColor.b, 1f),
            ambientEquatorColor = FloatArray(RenderSettings.ambientEquatorColor.r, RenderSettings.ambientEquatorColor.g, RenderSettings.ambientEquatorColor.b, 1f),
            ambientGroundColor = FloatArray(RenderSettings.ambientGroundColor.r, RenderSettings.ambientGroundColor.g, RenderSettings.ambientGroundColor.b, 1f),
            ambientLight = FloatArray(RenderSettings.ambientLight.r, RenderSettings.ambientLight.g, RenderSettings.ambientLight.b, 1f),
            ambientIntensity = RenderSettings.ambientIntensity,
            reflectionIntensity = RenderSettings.reflectionIntensity,
            reflectionBounces = RenderSettings.reflectionBounces,
            defaultReflectionMode = RenderSettings.defaultReflectionMode.ToString(),
            fog = RenderSettings.fog,
            fogColor = FloatArray(RenderSettings.fogColor.r, RenderSettings.fogColor.g, RenderSettings.fogColor.b, 1f),
            fogDensity = RenderSettings.fogDensity,
            fogMode = RenderSettings.fogMode.ToString(),
            skyboxMaterial = skybox != null ? skybox.name : string.Empty,
            lights = lights.ToArray()
        };
    }
    private static EntrancePointExport[] ExportEntrancePoints(Scene scene)
    {
        var points = new List<EntrancePointExport>();
        foreach (GameObject root in scene.GetRootGameObjects())
        {
            Transform[] transforms = root.GetComponentsInChildren<Transform>(true);
            foreach (Transform transform in transforms)
            {
                GameObject go = transform.gameObject;
                if (!go.activeInHierarchy || !IsEntrancePoint(go))
                {
                    continue;
                }

                points.Add(new EntrancePointExport
                {
                    name = go.name,
                    hierarchyPath = GetHierarchyPath(transform),
                    tag = go.tag,
                    layer = go.layer,
                    layerName = LayerMask.LayerToName(go.layer),
                    transform = TransformExport.From(transform),
                    radius = ReadFloatField(go, "radius", 0f)
                });
            }
        }

        return points.ToArray();
    }

    private static bool IsEntrancePoint(GameObject go)
    {
        string normalizedName = NormalizeSpatialName(go.name);
        if (normalizedName.Contains("entrancepoint") || normalizedName.Contains("spawnpoint") || normalizedName.Contains("playerstart"))
        {
            return true;
        }

        MonoBehaviour[] behaviours = go.GetComponents<MonoBehaviour>();
        foreach (MonoBehaviour behaviour in behaviours)
        {
            if (behaviour == null)
            {
                continue;
            }

            string typeName = behaviour.GetType().Name.ToLowerInvariant();
            if ((typeName.Contains("entrance") && typeName.Contains("point")) || typeName.Contains("spawnpoint"))
            {
                return true;
            }
        }

        return false;
    }

    private static string NormalizeSpatialName(string value)
    {
        return string.IsNullOrWhiteSpace(value)
            ? string.Empty
            : value.Replace(" ", string.Empty).Replace("_", string.Empty).Replace("-", string.Empty).ToLowerInvariant();
    }

    private static float ReadFloatField(GameObject go, string fieldName, float fallback)
    {
        MonoBehaviour[] behaviours = go.GetComponents<MonoBehaviour>();
        foreach (MonoBehaviour behaviour in behaviours)
        {
            if (behaviour == null)
            {
                continue;
            }

            var field = behaviour.GetType().GetField(fieldName);
            if (field != null && field.FieldType == typeof(float))
            {
                return (float)field.GetValue(behaviour);
            }
        }

        return fallback;
    }

    private static SceneBehavioursExport ExportBehaviours(Scene scene)
    {
        var animators = new List<AnimatorExport>();
        var loopRotations = new List<LoopRotationExport>();

        foreach (GameObject root in scene.GetRootGameObjects())
        {
            Animator[] found = root.GetComponentsInChildren<Animator>(true);
            foreach (Animator animator in found)
            {
                if (animator == null || !animator.enabled || !animator.gameObject.activeInHierarchy)
                {
                    continue;
                }

                RuntimeAnimatorController runtimeController = animator.runtimeAnimatorController;
                AnimatorController controller = runtimeController as AnimatorController;
                var clips = new List<AnimationClipExport>();
                if (controller != null)
                {
                    var seenClips = new HashSet<AnimationClip>();
                    foreach (AnimationClip clip in controller.animationClips)
                    {
                        if (clip == null || seenClips.Contains(clip))
                        {
                            continue;
                        }

                        seenClips.Add(clip);
                        AnimationClipSettings settings = AnimationUtility.GetAnimationClipSettings(clip);
                        clips.Add(new AnimationClipExport
                        {
                            name = clip.name,
                            assetPath = AssetDatabase.GetAssetPath(clip),
                            length = clip.length,
                            frameRate = clip.frameRate,
                            loopTime = settings.loopTime,
                            bindings = ExportClipBindings(clip)
                        });

                        loopRotations.AddRange(DetectLoopRotations(animator.transform, clip, settings.loopTime));
                    }
                }

                animators.Add(new AnimatorExport
                {
                    name = animator.name,
                    hierarchyPath = GetHierarchyPath(animator.transform),
                    enabled = animator.enabled,
                    controllerName = runtimeController != null ? runtimeController.name : string.Empty,
                    controllerPath = runtimeController != null ? AssetDatabase.GetAssetPath(runtimeController) : string.Empty,
                    clips = clips.ToArray()
                });
            }
        }

        return new SceneBehavioursExport
        {
            animators = animators.ToArray(),
            loopRotations = loopRotations.ToArray()
        };
    }

    private static AnimationBindingExport[] ExportClipBindings(AnimationClip clip)
    {
        var output = new List<AnimationBindingExport>();
        foreach (EditorCurveBinding binding in AnimationUtility.GetCurveBindings(clip))
        {
            AnimationCurve curve = AnimationUtility.GetEditorCurve(clip, binding);
            if (curve == null || curve.length == 0)
            {
                continue;
            }

            output.Add(new AnimationBindingExport
            {
                path = binding.path,
                propertyName = binding.propertyName,
                typeName = binding.type != null ? binding.type.Name : string.Empty,
                keyCount = curve.length,
                firstTime = curve.keys[0].time,
                firstValue = curve.keys[0].value,
                lastTime = curve.keys[curve.length - 1].time,
                lastValue = curve.keys[curve.length - 1].value
            });
        }

        return output.ToArray();
    }

    private static LoopRotationExport[] DetectLoopRotations(Transform animatorRoot, AnimationClip clip, bool loopTime)
    {
        var output = new List<LoopRotationExport>();
        foreach (EditorCurveBinding binding in AnimationUtility.GetCurveBindings(clip))
        {
            string property = binding.propertyName ?? string.Empty;
            if (!property.StartsWith("localEulerAnglesRaw.", StringComparison.Ordinal))
            {
                continue;
            }

            AnimationCurve curve = AnimationUtility.GetEditorCurve(clip, binding);
            if (curve == null || curve.length < 2)
            {
                continue;
            }

            Keyframe first = curve.keys[0];
            Keyframe last = curve.keys[curve.length - 1];
            float duration = Mathf.Max(last.time - first.time, 0.0001f);
            float delta = last.value - first.value;
            if (!loopTime || Mathf.Abs(delta) < 300f)
            {
                continue;
            }

            output.Add(new LoopRotationExport
            {
                clipName = clip.name,
                targetPath = CombineHierarchyPath(GetHierarchyPath(animatorRoot), binding.path),
                axis = property.Substring(property.Length - 1).ToLowerInvariant(),
                degreesPerSecond = delta / duration,
                duration = duration
            });
        }

        return output.ToArray();
    }

    private static string CombineHierarchyPath(string rootPath, string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath))
        {
            return rootPath;
        }

        return string.IsNullOrWhiteSpace(rootPath) ? relativePath : rootPath + "/" + relativePath;
    }

    private static void Traverse(Transform transform, List<PhysicalObjectExport> objects, string meshDir, string textureDir, ref int meshIndex)
    {
        GameObject go = transform.gameObject;

        if (go.activeInHierarchy)
        {
            ExportMeshFilter(go, objects, meshDir, textureDir, ref meshIndex);
            ExportSkinnedMesh(go, objects, meshDir, textureDir, ref meshIndex);
            ExportColliders(go, objects);
        }

        for (int i = 0; i < transform.childCount; i++)
        {
            Traverse(transform.GetChild(i), objects, meshDir, textureDir, ref meshIndex);
        }
    }

    private static void ExportAnimatedRenderers(Scene scene, List<PhysicalObjectExport> objects, string meshDir, string textureDir, ref int meshIndex)
    {
        foreach (GameObject root in scene.GetRootGameObjects())
        {
            Animator[] animators = root.GetComponentsInChildren<Animator>(true);
            foreach (Animator animator in animators)
            {
                if (animator == null || !animator.enabled)
                {
                    continue;
                }

                MeshRenderer[] meshRenderers = animator.GetComponentsInChildren<MeshRenderer>(true);
                foreach (MeshRenderer renderer in meshRenderers)
                {
                    MeshFilter meshFilter = renderer.GetComponent<MeshFilter>();
                    if (meshFilter == null || meshFilter.sharedMesh == null || !renderer.enabled || AlreadyExported(objects, renderer.gameObject))
                    {
                        continue;
                    }

                    string meshName = SanitizeFileName($"{meshIndex:0000}_{renderer.gameObject.name}_animated");
                    string relativeMeshPath = $"meshes/{meshName}.obj";
                    WriteObj(meshFilter.sharedMesh, Path.Combine(meshDir, meshName + ".obj"));
                    objects.Add(CreateObjectExport(renderer.gameObject, "AnimatedMeshRenderer", relativeMeshPath, renderer.sharedMaterials, GetEnabledColliders(renderer.gameObject), textureDir));
                    meshIndex++;
                }

                SkinnedMeshRenderer[] skinnedRenderers = animator.GetComponentsInChildren<SkinnedMeshRenderer>(true);
                foreach (SkinnedMeshRenderer renderer in skinnedRenderers)
                {
                    if (renderer.sharedMesh == null || !renderer.enabled || AlreadyExported(objects, renderer.gameObject))
                    {
                        continue;
                    }

                    Mesh baked = new Mesh();
                    try
                    {
                        renderer.BakeMesh(baked);
                        string meshName = SanitizeFileName($"{meshIndex:0000}_{renderer.gameObject.name}_animated_skinned");
                        string relativeMeshPath = $"meshes/{meshName}.obj";
                        WriteObj(baked, Path.Combine(meshDir, meshName + ".obj"));
                        objects.Add(CreateObjectExport(renderer.gameObject, "AnimatedSkinnedMeshRenderer", relativeMeshPath, renderer.sharedMaterials, GetEnabledColliders(renderer.gameObject), textureDir));
                        meshIndex++;
                    }
                    finally
                    {
                        UnityEngine.Object.DestroyImmediate(baked);
                    }
                }
            }
        }
    }

    private static bool AlreadyExported(List<PhysicalObjectExport> objects, GameObject go)
    {
        string path = GetHierarchyPath(go.transform);
        foreach (PhysicalObjectExport item in objects)
        {
            if (string.Equals(item.hierarchyPath, path, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private static void ExportMeshFilter(GameObject go, List<PhysicalObjectExport> objects, string meshDir, string textureDir, ref int meshIndex)
    {
        MeshFilter meshFilter = go.GetComponent<MeshFilter>();
        MeshRenderer renderer = go.GetComponent<MeshRenderer>();
        if (meshFilter == null || renderer == null || meshFilter.sharedMesh == null || !renderer.enabled)
        {
            return;
        }

        string meshName = SanitizeFileName($"{meshIndex:0000}_{go.name}");
        string relativeMeshPath = $"meshes/{meshName}.obj";
        WriteObj(meshFilter.sharedMesh, Path.Combine(meshDir, meshName + ".obj"));

        objects.Add(CreateObjectExport(go, "MeshRenderer", relativeMeshPath, renderer.sharedMaterials, GetEnabledColliders(go), textureDir));
        meshIndex++;
    }

    private static void ExportSkinnedMesh(GameObject go, List<PhysicalObjectExport> objects, string meshDir, string textureDir, ref int meshIndex)
    {
        SkinnedMeshRenderer renderer = go.GetComponent<SkinnedMeshRenderer>();
        if (renderer == null || renderer.sharedMesh == null || !renderer.enabled)
        {
            return;
        }

        Mesh baked = new Mesh();
        try
        {
            renderer.BakeMesh(baked);
            string meshName = SanitizeFileName($"{meshIndex:0000}_{go.name}_skinned");
            string relativeMeshPath = $"meshes/{meshName}.obj";
            WriteObj(baked, Path.Combine(meshDir, meshName + ".obj"));

            objects.Add(CreateObjectExport(go, "SkinnedMeshRenderer", relativeMeshPath, renderer.sharedMaterials, GetEnabledColliders(go), textureDir));
            meshIndex++;
        }
        finally
        {
            UnityEngine.Object.DestroyImmediate(baked);
        }
    }

    private static void ExportColliders(GameObject go, List<PhysicalObjectExport> objects)
    {
        Collider[] colliders = GetEnabledColliders(go);
        if (colliders.Length == 0)
        {
            return;
        }

        bool alreadyExportedAsMesh = go.GetComponent<MeshRenderer>() != null || go.GetComponent<SkinnedMeshRenderer>() != null;
        if (alreadyExportedAsMesh)
        {
            return;
        }

        objects.Add(CreateObjectExport(go, "ColliderOnly", string.Empty, Array.Empty<Material>(), colliders, string.Empty));
    }

    private static PhysicalObjectExport CreateObjectExport(GameObject go, string sourceType, string meshPath, Material[] materials, Collider[] colliders, string textureDir)
    {
        return new PhysicalObjectExport
        {
            name = go.name,
            hierarchyPath = GetHierarchyPath(go.transform),
            tag = go.tag,
            layer = go.layer,
            layerName = LayerMask.LayerToName(go.layer),
            isStatic = go.isStatic,
            sourceType = sourceType,
            mesh = meshPath,
            transform = TransformExport.From(go.transform),
            materials = ExportMaterials(materials, textureDir),
            colliders = ExportColliders(colliders),
            rigidbody = RigidbodyExport.From(go.GetComponent<Rigidbody>())
        };
    }

    private static MaterialExport[] ExportMaterials(Material[] materials, string textureDir)
    {
        var output = new List<MaterialExport>();
        foreach (Material material in materials)
        {
            if (material == null)
            {
                continue;
            }

            Color color = Color.white;
            if (material.HasProperty("_BaseColor"))
            {
                color = material.GetColor("_BaseColor");
            }
            else if (material.HasProperty("_Color"))
            {
                color = material.GetColor("_Color");
            }

            output.Add(new MaterialExport
            {
                name = material.name,
                shader = material.shader != null ? material.shader.name : string.Empty,
                color = FloatArray(color.r, color.g, color.b, color.a),
                texture = ExportMainTexture(material, textureDir),
                renderQueue = material.renderQueue,
                isTransparent = IsTransparentMaterial(material),
                properties = ExportMaterialProperties(material, textureDir)
            });
        }

        return output.ToArray();
    }
    private static string ExportMainTexture(Material material, string textureDir)
    {
        if (string.IsNullOrEmpty(textureDir) || material == null)
        {
            return string.Empty;
        }

        Texture texture = null;
        if (material.HasProperty("_BaseMap"))
        {
            texture = material.GetTexture("_BaseMap");
        }
        if (texture == null && material.HasProperty("_MainTex"))
        {
            texture = material.GetTexture("_MainTex");
        }
        if (!(texture is Texture2D texture2D))
        {
            return string.Empty;
        }

        string assetPath = AssetDatabase.GetAssetPath(texture2D);
        if (string.IsNullOrEmpty(assetPath))
        {
            return string.Empty;
        }

        string extension = Path.GetExtension(assetPath).ToLowerInvariant();
        if (extension != ".png" && extension != ".jpg" && extension != ".jpeg")
        {
            return string.Empty;
        }

        string projectRoot = Directory.GetParent(Application.dataPath).FullName;
        string sourcePath = Path.Combine(projectRoot, assetPath);
        if (!File.Exists(sourcePath))
        {
            return string.Empty;
        }

        string targetName = SanitizeFileName($"{material.name}_{texture2D.name}{extension}");
        string targetPath = Path.Combine(textureDir, targetName);
        File.Copy(sourcePath, targetPath, true);
        return $"textures/{targetName}";
    }
    private static bool IsTransparentMaterial(Material material)
    {
        if (material == null)
        {
            return false;
        }

        string shaderName = material.shader != null ? material.shader.name.ToLowerInvariant() : string.Empty;
        string materialName = material.name.ToLowerInvariant();
        if (material.renderQueue >= 3000 || shaderName.Contains("transparent") || shaderName.Contains("water") || materialName.Contains("glass") || materialName.Contains("water"))
        {
            return true;
        }

        Color color = Color.white;
        if (material.HasProperty("_BaseColor"))
        {
            color = material.GetColor("_BaseColor");
        }
        else if (material.HasProperty("_Color"))
        {
            color = material.GetColor("_Color");
        }

        return color.a < 0.98f;
    }

    private static MaterialPropertyExport[] ExportMaterialProperties(Material material, string textureDir)
    {
        var output = new List<MaterialPropertyExport>();
        Shader shader = material != null ? material.shader : null;
        if (shader == null)
        {
            return output.ToArray();
        }

        int count = ShaderUtil.GetPropertyCount(shader);
        for (int i = 0; i < count; i++)
        {
            string propertyName = ShaderUtil.GetPropertyName(shader, i);
            string description = ShaderUtil.GetPropertyDescription(shader, i);
            ShaderUtil.ShaderPropertyType type = ShaderUtil.GetPropertyType(shader, i);

            if (type == ShaderUtil.ShaderPropertyType.Color && material.HasProperty(propertyName))
            {
                Color color = material.GetColor(propertyName);
                output.Add(new MaterialPropertyExport
                {
                    name = propertyName,
                    label = description,
                    type = "Color",
                    color = FloatArray(color.r, color.g, color.b, color.a)
                });
            }
            else if ((type == ShaderUtil.ShaderPropertyType.Float || type == ShaderUtil.ShaderPropertyType.Range) && material.HasProperty(propertyName))
            {
                output.Add(new MaterialPropertyExport
                {
                    name = propertyName,
                    label = description,
                    type = "Float",
                    value = material.GetFloat(propertyName)
                });
            }
            else if (type == ShaderUtil.ShaderPropertyType.TexEnv && material.HasProperty(propertyName))
            {
                Texture texture = material.GetTexture(propertyName);
                if (texture is Texture2D texture2D)
                {
                    output.Add(new MaterialPropertyExport
                    {
                        name = propertyName,
                        label = description,
                        type = "Texture",
                        texture = ExportTexture(material, texture2D, textureDir, propertyName)
                    });
                }
            }
        }

        return output.ToArray();
    }

    private static string ExportTexture(Material material, Texture2D texture2D, string textureDir, string propertyName)
    {
        if (string.IsNullOrEmpty(textureDir) || texture2D == null)
        {
            return string.Empty;
        }

        string assetPath = AssetDatabase.GetAssetPath(texture2D);
        if (string.IsNullOrEmpty(assetPath))
        {
            return string.Empty;
        }

        string extension = Path.GetExtension(assetPath).ToLowerInvariant();
        if (extension != ".png" && extension != ".jpg" && extension != ".jpeg")
        {
            return string.Empty;
        }

        string projectRoot = Directory.GetParent(Application.dataPath).FullName;
        string sourcePath = Path.Combine(projectRoot, assetPath);
        if (!File.Exists(sourcePath))
        {
            return string.Empty;
        }

        string targetName = SanitizeFileName($"{material.name}_{propertyName}_{texture2D.name}{extension}");
        string targetPath = Path.Combine(textureDir, targetName);
        File.Copy(sourcePath, targetPath, true);
        return $"textures/{targetName}";
    }

    private static Collider[] GetEnabledColliders(GameObject go)
    {
        Collider[] all = go.GetComponents<Collider>();
        var filtered = new List<Collider>();
        foreach (Collider collider in all)
        {
            if (collider != null && collider.enabled)
            {
                filtered.Add(collider);
            }
        }

        return filtered.ToArray();
    }

    private static ColliderExport[] ExportColliders(Collider[] colliders)
    {
        var output = new List<ColliderExport>();
        foreach (Collider collider in colliders)
        {
            var item = new ColliderExport
            {
                type = collider.GetType().Name,
                name = collider.name,
                enabled = collider.enabled,
                isTrigger = collider.isTrigger,
                tag = collider.gameObject.tag,
                layer = collider.gameObject.layer,
                layerName = LayerMask.LayerToName(collider.gameObject.layer),
                physicsMaterial = collider.sharedMaterial != null ? collider.sharedMaterial.name : string.Empty,
                center = FloatArray(collider.bounds.center.x, collider.bounds.center.y, -collider.bounds.center.z),
                size = FloatArray(collider.bounds.size.x, collider.bounds.size.y, collider.bounds.size.z)
            };

            if (collider is BoxCollider box)
            {
                item.localCenter = FloatArray(box.center.x, box.center.y, -box.center.z);
                item.localSize = FloatArray(box.size.x, box.size.y, box.size.z);
            }
            else if (collider is SphereCollider sphere)
            {
                item.localCenter = FloatArray(sphere.center.x, sphere.center.y, -sphere.center.z);
                item.radius = sphere.radius;
            }
            else if (collider is CapsuleCollider capsule)
            {
                item.localCenter = FloatArray(capsule.center.x, capsule.center.y, -capsule.center.z);
                item.radius = capsule.radius;
                item.height = capsule.height;
                item.direction = capsule.direction;
            }
            else if (collider is MeshCollider meshCollider && meshCollider.sharedMesh != null)
            {
                item.meshName = meshCollider.sharedMesh.name;
                item.convex = meshCollider.convex;
            }

            output.Add(item);
        }

        return output.ToArray();
    }private static void WriteObj(Mesh mesh, string path)
    {
        var sb = new StringBuilder();
        sb.AppendLine("# Exported by SpatialThreePhysicalExporter");
        sb.AppendLine($"o {SanitizeObjName(mesh.name)}");

        Vector3[] vertices = mesh.vertices;
        Vector3[] normals = mesh.normals;
        Vector2[] uvs = mesh.uv;

        foreach (Vector3 vertex in vertices)
        {
            sb.AppendLine(FormattableString.Invariant($"v {vertex.x} {vertex.y} {-vertex.z}"));
        }

        foreach (Vector2 uv in uvs)
        {
            sb.AppendLine(FormattableString.Invariant($"vt {uv.x} {uv.y}"));
        }

        foreach (Vector3 normal in normals)
        {
            sb.AppendLine(FormattableString.Invariant($"vn {normal.x} {normal.y} {-normal.z}"));
        }

        bool hasUvs = uvs != null && uvs.Length == vertices.Length;
        bool hasNormals = normals != null && normals.Length == vertices.Length;

        for (int subMesh = 0; subMesh < mesh.subMeshCount; subMesh++)
        {
            sb.AppendLine($"g submesh_{subMesh}");
            int[] triangles = mesh.GetTriangles(subMesh);
            for (int i = 0; i < triangles.Length; i += 3)
            {
                int a = triangles[i] + 1;
                int b = triangles[i + 2] + 1;
                int c = triangles[i + 1] + 1;
                sb.AppendLine($"f {FormatObjIndex(a, hasUvs, hasNormals)} {FormatObjIndex(b, hasUvs, hasNormals)} {FormatObjIndex(c, hasUvs, hasNormals)}");
            }
        }

        File.WriteAllText(path, sb.ToString(), Encoding.UTF8);
    }

    private static string FormatObjIndex(int index, bool hasUvs, bool hasNormals)
    {
        if (hasUvs && hasNormals)
        {
            return $"{index}/{index}/{index}";
        }

        if (hasUvs)
        {
            return $"{index}/{index}";
        }

        if (hasNormals)
        {
            return $"{index}//{index}";
        }

        return index.ToString(CultureInfo.InvariantCulture);
    }

    private static string GetHierarchyPath(Transform transform)
    {
        var parts = new Stack<string>();
        Transform current = transform;
        while (current != null)
        {
            parts.Push(current.name);
            current = current.parent;
        }

        return string.Join("/", parts.ToArray());
    }

    private static string GetCommandLineValue(string key, string fallback)
    {
        string[] args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], key, StringComparison.OrdinalIgnoreCase))
            {
                return args[i + 1];
            }
        }

        return fallback;
    }

    private static string SanitizeFileName(string value)
    {
        foreach (char c in Path.GetInvalidFileNameChars())
        {
            value = value.Replace(c, '_');
        }

        return value.Replace(' ', '_');
    }

    private static string SanitizeObjName(string value)
    {
        return string.IsNullOrWhiteSpace(value) ? "mesh" : SanitizeFileName(value);
    }

    private static float[] ConvertPosition(Vector3 value)
    {
        return FloatArray(value.x, value.y, -value.z);
    }

    private static float[] ConvertDirection(Vector3 value)
    {
        Vector3 normalized = value.normalized;
        return FloatArray(normalized.x, normalized.y, -normalized.z);
    }

    private static float[] FloatArray(params float[] values)
    {
        return values;
    }

    [Serializable]
    private class SceneExport
    {
        public string sceneName;
        public string exportedAtUtc;
        public string unityVersion;
        public string coordinateSystem;
        public List<PhysicalObjectExport> objects;
        public EntrancePointExport[] entrancePoints;
        public SceneBehavioursExport behaviours;
        public SceneLightingExport lighting;
    }

    [Serializable]
    private class EntrancePointExport
    {
        public string name;
        public string hierarchyPath;
        public string tag;
        public int layer;
        public string layerName;
        public TransformExport transform;
        public float radius;
    }

    [Serializable]
    private class SceneBehavioursExport
    {
        public AnimatorExport[] animators;
        public LoopRotationExport[] loopRotations;
    }

    [Serializable]
    private class AnimatorExport
    {
        public string name;
        public string hierarchyPath;
        public bool enabled;
        public string controllerName;
        public string controllerPath;
        public AnimationClipExport[] clips;
    }

    [Serializable]
    private class AnimationClipExport
    {
        public string name;
        public string assetPath;
        public float length;
        public float frameRate;
        public bool loopTime;
        public AnimationBindingExport[] bindings;
    }

    [Serializable]
    private class AnimationBindingExport
    {
        public string path;
        public string propertyName;
        public string typeName;
        public int keyCount;
        public float firstTime;
        public float firstValue;
        public float lastTime;
        public float lastValue;
    }

    [Serializable]
    private class LoopRotationExport
    {
        public string clipName;
        public string targetPath;
        public string axis;
        public float degreesPerSecond;
        public float duration;
    }

    [Serializable]
    private class SceneLightingExport
    {
        public string ambientMode;
        public float[] ambientSkyColor;
        public float[] ambientEquatorColor;
        public float[] ambientGroundColor;
        public float[] ambientLight;
        public float ambientIntensity;
        public float reflectionIntensity;
        public int reflectionBounces;
        public string defaultReflectionMode;
        public bool fog;
        public float[] fogColor;
        public float fogDensity;
        public string fogMode;
        public string skyboxMaterial;
        public LightExport[] lights;
    }

    [Serializable]
    private class LightExport
    {
        public string name;
        public string hierarchyPath;
        public string type;
        public float[] color;
        public float intensity;
        public float range;
        public float spotAngle;
        public float[] position;
        public float[] directionToLight;
    }
    [Serializable]
    private class PhysicalObjectExport
    {
        public string name;
        public string hierarchyPath;
        public string tag;
        public int layer;
        public string layerName;
        public bool isStatic;
        public string sourceType;
        public string mesh;
        public TransformExport transform;
        public MaterialExport[] materials;
        public ColliderExport[] colliders;
        public RigidbodyExport rigidbody;
    }

    [Serializable]
    private class RigidbodyExport
    {
        public bool hasRigidbody;
        public bool isKinematic;
        public bool useGravity;
        public float mass;
        public float drag;
        public float angularDrag;
        public string collisionDetectionMode;
        public string interpolation;
        public string constraints;

        public static RigidbodyExport From(Rigidbody rigidbody)
        {
            if (rigidbody == null)
            {
                return new RigidbodyExport
                {
                    hasRigidbody = false
                };
            }

            return new RigidbodyExport
            {
                hasRigidbody = true,
                isKinematic = rigidbody.isKinematic,
                useGravity = rigidbody.useGravity,
                mass = rigidbody.mass,
                drag = rigidbody.drag,
                angularDrag = rigidbody.angularDrag,
                collisionDetectionMode = rigidbody.collisionDetectionMode.ToString(),
                interpolation = rigidbody.interpolation.ToString(),
                constraints = rigidbody.constraints.ToString()
            };
        }
    }

    [Serializable]
    private class TransformExport
    {
        public float[] position;
        public float[] rotationEuler;
        public float[] scale;
        public float[] matrix;

        public static TransformExport From(Transform transform)
        {
            Vector3 position = transform.position;
            Vector3 euler = transform.rotation.eulerAngles;
            Vector3 scale = transform.lossyScale;
            return new TransformExport
            {
                position = FloatArray(position.x, position.y, -position.z),
                rotationEuler = FloatArray(euler.x, -euler.y, -euler.z),
                scale = FloatArray(scale.x, scale.y, scale.z),
                matrix = MatrixToFloatArray(ConvertUnityToWebMatrix(transform.localToWorldMatrix))
            };
        }

        private static Matrix4x4 ConvertUnityToWebMatrix(Matrix4x4 unityMatrix)
        {
            Matrix4x4 flipZ = Matrix4x4.Scale(new Vector3(1f, 1f, -1f));
            return flipZ * unityMatrix * flipZ;
        }

        private static float[] MatrixToFloatArray(Matrix4x4 matrix)
        {
            return FloatArray(
                matrix.m00, matrix.m10, matrix.m20, matrix.m30,
                matrix.m01, matrix.m11, matrix.m21, matrix.m31,
                matrix.m02, matrix.m12, matrix.m22, matrix.m32,
                matrix.m03, matrix.m13, matrix.m23, matrix.m33
            );
        }
    }

    [Serializable]
    private class MaterialExport
    {
        public string name;
        public string shader;
        public float[] color;
        public string texture;
        public int renderQueue;
        public bool isTransparent;
        public MaterialPropertyExport[] properties;
    }

    [Serializable]
    private class MaterialPropertyExport
    {
        public string name;
        public string label;
        public string type;
        public float[] color;
        public float value;
        public string texture;
    }

    [Serializable]
    private class ColliderExport
    {
        public string type;
        public string name;
        public bool enabled;
        public bool isTrigger;
        public string tag;
        public int layer;
        public string layerName;
        public string physicsMaterial;
        public float[] center;
        public float[] size;
        public float[] localCenter;
        public float[] localSize;
        public float radius;
        public float height;
        public int direction;
        public string meshName;
        public bool convex;
    }
}






