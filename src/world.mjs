// The world model: every scene flattened into the objects the renderer and the physics engine will see, with world
// transforms, boxes, triangle counts and surfaces. Built from the files alone; Godot is not needed.
import { ResourceFile } from "./godot/tscn.mjs";
import { IDENTITY, toTransform, mulTransform, xformAabb, unionAabb, refId, isCall, aabbRadius, transformScale } from "./godot/variant.mjs";
import { readModel } from "./godot/glb.mjs";

const MESH_NODES = new Set(["MeshInstance3D", "SoftBody3D"]);
const LIGHTS = new Set(["DirectionalLight3D", "OmniLight3D", "SpotLight3D"]);
const BODIES = new Set(["StaticBody3D", "RigidBody3D", "CharacterBody3D", "AnimatableBody3D", "VehicleBody3D", "Area3D", "PhysicalBone3D"]);
const CSG = new Set(["CSGBox3D", "CSGSphere3D", "CSGCylinder3D", "CSGTorus3D", "CSGPolygon3D", "CSGMesh3D", "CSGCombiner3D"]);
const PARTICLES = new Set(["GPUParticles3D", "CPUParticles3D"]);
const OTHER = new Set(["OccluderInstance3D", "VoxelGI", "LightmapGI", "ReflectionProbe", "Decal", "FogVolume", "WorldEnvironment", "Camera3D", "GridMap", "Label3D", "Sprite3D", "AnimatedSprite3D", "SubViewport", "NavigationRegion3D", "Skeleton3D", "AnimationPlayer", "AnimationTree", "VisibleOnScreenEnabler3D", "VisibleOnScreenNotifier3D", "AudioStreamPlayer3D"]);

function n(v, d) {
  return typeof v === "number" ? v : d;
}
function vec3(v, d) {
  return isCall(v, "Vector3") ? v.args : d;
}
function vec2(v, d) {
  return isCall(v, "Vector2") ? v.args : d;
}

/** Triangles and box of a primitive mesh resource, from its type and properties (Godot's defaults where unset). */
export function primitiveMesh(type, get) {
  switch (type) {
    case "BoxMesh": {
      const s = vec3(get("size"), [1, 1, 1]);
      const sub = (n(get("subdivide_width"), 0) + 1) * (n(get("subdivide_height"), 0) + 1) * 4 + (n(get("subdivide_depth"), 0) + 1) * (n(get("subdivide_width"), 0) + 1) * 2;
      return { triangles: Math.max(12, sub * 2), aabb: [-s[0] / 2, -s[1] / 2, -s[2] / 2, s[0] / 2, s[1] / 2, s[2] / 2] };
    }
    case "SphereMesh": {
      const r = n(get("radius"), 0.5);
      const h = n(get("height"), 1);
      return { triangles: n(get("radial_segments"), 64) * n(get("rings"), 32) * 2, aabb: [-r, -h / 2, -r, r, h / 2, r] };
    }
    case "CapsuleMesh": {
      const r = n(get("radius"), 0.5);
      const h = n(get("height"), 2);
      return { triangles: n(get("radial_segments"), 64) * (n(get("rings"), 8) * 2 + 2) * 2, aabb: [-r, -h / 2, -r, r, h / 2, r] };
    }
    case "CylinderMesh": {
      const r = Math.max(n(get("top_radius"), 0.5), n(get("bottom_radius"), 0.5));
      const h = n(get("height"), 2);
      const seg = n(get("radial_segments"), 64);
      return { triangles: seg * (n(get("rings"), 4) + 1) * 2 + seg * 2, aabb: [-r, -h / 2, -r, r, h / 2, r] };
    }
    case "PlaneMesh":
    case "QuadMesh": {
      const s = vec2(get("size"), type === "QuadMesh" ? [1, 1] : [2, 2]);
      const tris = (n(get("subdivide_width"), 0) + 1) * (n(get("subdivide_depth"), 0) + 1) * 2;
      const flat = type === "QuadMesh" && n(get("orientation"), 2) === 2;
      return { triangles: tris, aabb: flat ? [-s[0] / 2, -s[1] / 2, 0, s[0] / 2, s[1] / 2, 0] : [-s[0] / 2, 0, -s[1] / 2, s[0] / 2, 0, s[1] / 2] };
    }
    case "PrismMesh": {
      const s = vec3(get("size"), [1, 1, 1]);
      return { triangles: 8, aabb: [-s[0] / 2, -s[1] / 2, -s[2] / 2, s[0] / 2, s[1] / 2, s[2] / 2] };
    }
    case "TorusMesh": {
      const r = n(get("outer_radius"), 1);
      return { triangles: n(get("rings"), 64) * n(get("ring_segments"), 32) * 2, aabb: [-r, -r / 2, -r, r, r / 2, r] };
    }
    case "TextMesh":
      return { triangles: 2000, aabb: [-1, -0.5, -0.1, 1, 0.5, 0.1] };
    case "RibbonTrailMesh":
    case "TubeTrailMesh":
      return { triangles: 200, aabb: [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5] };
    default:
      return null;
  }
}

/** Triangles, surfaces and box of an ArrayMesh written as text (`_surfaces = [{...}]`). */
function arrayMeshInfo(section) {
  const surfaces = section.get("_surfaces");
  if (!Array.isArray(surfaces)) return { triangles: null, surfaces: 1, aabb: null };
  let triangles = 0;
  let aabb = null;
  for (const s of surfaces) {
    const prim = n(s.primitive, 3);
    const count = n(s.index_count, 0) || n(s.vertex_count, 0);
    triangles += prim === 3 ? Math.floor(count / 3) : prim === 4 ? Math.max(0, count - 2) : 0;
    if (isCall(s.aabb, "AABB")) {
      const a = s.aabb.args;
      aabb = unionAabb(aabb, [a[0], a[1], a[2], a[0] + a[3], a[1] + a[4], a[2] + a[5]]);
    }
  }
  return { triangles, surfaces: surfaces.length, aabb, lods: surfaces.some((s) => Array.isArray(s.lods) && s.lods.length > 0) };
}

export class World {
  constructor(project) {
    this.project = project;
    this.scenes = new Map(); // res path → {file, tree}
    this.meshInfoCache = new Map();
    this.warnings = [];
  }

  scene(path) {
    if (this.scenes.has(path)) return this.scenes.get(path);
    const text = this.project.text(path);
    let out = null;
    if (text !== null && /^\[gd_scene/.test(text)) {
      const file = new ResourceFile(text);
      out = { path, file, nodes: this.buildTree(file, path) };
    }
    this.scenes.set(path, out);
    return out;
  }

  buildTree(file) {
    const byPath = new Map();
    const list = [];
    for (const s of file.nodes) {
      const isRoot = s.attrs.parent === undefined;
      const path = isRoot ? "." : ResourceFile.nodePath(s);
      const node = {
        path,
        name: String(s.attrs.name),
        type: typeof s.attrs.type === "string" ? s.attrs.type : null,
        parent: isRoot ? null : String(s.attrs.parent),
        section: s,
        instance: null,
        children: [],
        groups: Array.isArray(s.attrs.groups) ? s.attrs.groups : [],
      };
      const inst = refId(s.attrs.instance);
      if (inst !== null) {
        const ext = file.ext.get(inst);
        if (ext) node.instance = this.project.resolveExt(ext.attrs);
      }
      node.isOverride = !node.type && !node.instance && !isRoot;
      byPath.set(path, node);
      list.push(node);
      if (!isRoot) {
        const parent = byPath.get(node.parent);
        if (parent) parent.children.push(node);
        else node.orphanParent = true; // a node inside an instanced scene
      }
    }
    return { list, byPath, root: list[0] ?? null };
  }

  /** Resolves a `mesh = ...` value to {key, triangles, surfaces, aabb, source}. */
  meshInfo(scenePath, file, value) {
    const id = refId(value);
    if (id === null) return null;
    if (value.$ === "SubResource") {
      const key = `${scenePath}::${id}`;
      if (this.meshInfoCache.has(key)) return this.meshInfoCache.get(key);
      const sub = file.sub.get(id);
      let info = null;
      if (sub) {
        const type = String(sub.attrs.type);
        const prim = primitiveMesh(type, (k) => sub.get(k));
        if (prim) info = { key, type, surfaces: 1, ...prim, material: this.refKey(scenePath, file, sub.get("material")), primitive: true };
        else if (type === "ArrayMesh") info = { key, type, ...arrayMeshInfo(sub) };
        else info = { key, type, triangles: null, surfaces: 1, aabb: null };
      }
      this.meshInfoCache.set(key, info);
      return info;
    }
    const ext = file.ext.get(id);
    if (!ext) return null;
    const path = this.project.resolveExt(ext.attrs);
    if (!path) return null;
    if (this.meshInfoCache.has(path)) return this.meshInfoCache.get(path);
    let info = { key: path, type: String(ext.attrs.type ?? "Mesh"), triangles: null, surfaces: 1, aabb: null, path };
    if (/\.obj$/i.test(path)) {
      const t = this.project.text(path) ?? "";
      let tris = 0;
      let aabb = null;
      for (const line of t.split("\n")) {
        if (line.startsWith("f ")) tris += Math.max(1, line.trim().split(/\s+/).length - 3);
        else if (line.startsWith("v ")) {
          const p = line.split(/\s+/).slice(1, 4).map(Number);
          aabb = unionAabb(aabb, [...p, ...p]);
        }
      }
      info = { ...info, triangles: tris, aabb, surfaces: Math.max(1, (t.match(/^usemtl /gm) ?? []).length) };
    } else if (/\.tres$/i.test(path)) {
      const t = this.project.text(path);
      if (t) {
        const f = new ResourceFile(t);
        const res = f.sections.find((s) => s.tag === "resource");
        const type = String(f.head?.attrs.type ?? "");
        const prim = res && primitiveMesh(type, (k) => res.get(k));
        if (prim) info = { ...info, type, ...prim };
        else if (res) info = { ...info, type, ...arrayMeshInfo(res) };
      }
    }
    this.meshInfoCache.set(path, info);
    return info;
  }

  refKey(scenePath, file, value) {
    const id = refId(value);
    if (id === null) return null;
    if (value.$ === "SubResource") return `${scenePath}::${id}`;
    const ext = file.ext.get(id);
    return ext ? this.project.resolveExt(ext.attrs) : null;
  }

  /**
   * Flattens a scene into objects. Each object: {kind, type, path (node path from the top scene), scene (file that
   * owns the node section), local (path inside that file), transform, aabb (world), triangles, surfaces, ...}.
   */
  flatten(scenePath, { maxObjects = 2_000_000 } = {}) {
    const objects = [];
    const stats = { nodes: 0, scripts: 0, instances: 0, depthLimit: false, truncated: false };
    const stack = new Set();
    const walkScene = (path, parentT, prefix, depth, overrides, inherited) => {
      if (depth > 24 || stack.has(path)) {
        stats.depthLimit = true;
        return;
      }
      const sc = this.scene(path);
      if (!sc || !sc.nodes.root) return;
      stack.add(path);
      const visit = (node, pT, pPath, topLevel) => {
        if (objects.length >= maxObjects) {
          stats.truncated = true;
          return;
        }
        stats.nodes++;
        const s = node.section;
        const here = node.parent === null ? prefix : pPath === "." || pPath === "" ? node.name : `${pPath}/${node.name}`;
        const ov = overrides?.get(node.path);
        const prop = (k) => (ov && ov.has(k) ? ov.get(k) : s.get(k));
        const hasProp = (k) => (ov && ov.has(k)) || s.has(k);
        const local = toTransform(prop("transform"));
        const t = local === IDENTITY ? pT : mulTransform(pT, local);
        const type = node.type;
        const base = { type, path: here || ".", scene: path, local: node.path, depth, transform: t, script: this.refKey(path, sc.file, prop("script")), visible: prop("visible") !== false, groups: node.groups, inInstance: depth > 0, section: depth === 0 ? s : null };
        if (base.script) stats.scripts++;
        if (node.instance && node.parent !== null) {
          stats.instances++;
          const target = node.instance;
          // Property overrides the parent scene makes on nodes inside the instance.
          const childOv = new Map();
          const pre = node.path + "/";
          for (const o of sc.nodes.list) {
            if (o.isOverride && o.orphanParent !== false && (o.path.startsWith(pre))) {
              const m = new Map();
              for (const p of o.section.props) m.set(p.key, o.section.get(p.key));
              childOv.set(o.path.slice(pre.length), m);
            }
          }
          const rootOv = new Map();
          for (const p of s.props) rootOv.set(p.key, s.get(p.key));
          childOv.set(".", rootOv);
          if (/\.(glb|gltf)$/i.test(target)) this.emitModel(objects, target, t, here, base, s);
          else if (/\.(tscn|scn)$/i.test(target)) {
            objects.push({ ...base, kind: "instance", target, aabb: null });
            const mark = objects.length;
            walkScene(target, pT, here, depth + 1, childOv, false);
            const owner = objects[mark - 1];
            owner.span = [mark, objects.length];
          }
          for (const c of node.children) if (!c.isOverride) visit(c, t, here, false);
          return;
        }
        if (node.parent === null && node.instance) {
          // Inherited scene: the base scene's nodes come first, with this file's overrides.
          const inhOv = new Map();
          for (const o of sc.nodes.list) {
            if (o === node || o.isOverride) {
              const m = new Map();
              for (const p of o.section.props) m.set(p.key, o.section.get(p.key));
              inhOv.set(o.path, m);
            }
          }
          if (/\.(glb|gltf)$/i.test(node.instance)) this.emitModel(objects, node.instance, t, here, base, s);
          else walkScene(node.instance, parentT, prefix, depth + 1, inhOv, true);
          for (const c of node.children) if (!c.isOverride) visit(c, t, here, false);
          return;
        }
        if (node.isOverride) return;
        this.emitNode(objects, base, type, prop, hasProp, sc, path, t);
        for (const c of node.children) visit(c, t, here, false);
      };
      visit(sc.nodes.root, parentT, prefix, true);
      stack.delete(path);
    };
    walkScene(scenePath, IDENTITY, "", 0, null, false);
    return { scene: scenePath, objects, stats };
  }

  emitModel(objects, target, t, here, base, section) {
    const model = readModel(this.project.abs(target));
    const imp = this.project.importOf(target);
    const lods = imp?.param("meshes/generate_lods");
    objects.push({ ...base, kind: "instance", target, aabb: model.aabb ? xformAabb(t, model.aabb) : null, model: true });
    const start = objects.length;
    for (const it of model.instances) {
      const wt = mulTransform(t, it.transform);
      const mesh = model.meshes[it.mesh];
      objects.push({
        ...base,
        section: null,
        inInstance: true,
        kind: "mesh",
        type: "MeshInstance3D",
        path: `${here}/${it.node}`,
        meshKey: `${target}#${it.mesh}`,
        materialKey: `${target}#m${it.materials.join(",")}`,
        triangles: it.triangles,
        surfaces: it.surfaces,
        aabb: mesh.aabb ? xformAabb(wt, mesh.aabb) : null,
        transform: wt,
        castShadow: true,
        visEnd: 0,
        hasLods: lods !== false,
        skinned: it.skinned,
        modelPath: target,
        script: null,
      });
    }
    objects[start - 1].span = [start, objects.length];
    objects[start - 1].triangles = model.triangles;
    objects[start - 1].surfaces = model.surfaces;
  }

  emitNode(objects, base, type, prop, hasProp, sc, path, t) {
    if (!type) return;
    if (MESH_NODES.has(type)) {
      const info = this.meshInfo(path, sc.file, prop("mesh"));
      let override = null;
      for (let i = 0; i < 8 && !override; i++) override = this.refKey(path, sc.file, prop(`surface_material_override/${i}`));
      const material = this.refKey(path, sc.file, prop("material_override")) ?? override ?? info?.material ?? null;
      objects.push({
        ...base,
        kind: "mesh",
        meshKey: info?.key ?? null,
        meshType: info?.type ?? null,
        materialKey: material,
        triangles: info?.triangles ?? null,
        surfaces: info?.surfaces ?? 1,
        aabb: info?.aabb ? xformAabb(t, info.aabb) : pointBox(t),
        localAabb: info?.aabb ?? null,
        castShadow: n(prop("cast_shadow"), 1) !== 0,
        visEnd: n(prop("visibility_range_end"), 0),
        visBegin: n(prop("visibility_range_begin"), 0),
        giMode: n(prop("gi_mode"), 1),
        hasLods: info?.lods ?? (info?.path ? undefined : false),
        skinned: hasProp("skeleton") && String(prop("skeleton")) !== "",
        primitive: !!info?.primitive,
        hasBlendShapes: false,
      });
      return;
    }
    if (type === "MultiMeshInstance3D") {
      const id = refId(prop("multimesh"));
      const mm = id !== null ? sc.file.sub.get(id) : null;
      const count = mm ? n(mm.get("instance_count"), 0) : 0;
      const info = mm ? this.meshInfo(path, sc.file, mm.get("mesh")) : null;
      objects.push({ ...base, kind: "multimesh", count, meshKey: info?.key ?? null, triangles: info?.triangles != null ? info.triangles * count : null, surfaces: info?.surfaces ?? 1, aabb: pointBox(t), castShadow: n(prop("cast_shadow"), 1) !== 0, visEnd: n(prop("visibility_range_end"), 0) });
      return;
    }
    if (LIGHTS.has(type)) {
      objects.push({
        ...base,
        kind: "light",
        shadow: prop("shadow_enabled") === true,
        range: type === "OmniLight3D" ? n(prop("omni_range"), 5) : type === "SpotLight3D" ? n(prop("spot_range"), 5) : Infinity,
        distanceFade: prop("distance_fade_enabled") === true,
        shadowMode: type === "DirectionalLight3D" ? n(prop("directional_shadow_mode"), 2) : type === "OmniLight3D" ? n(prop("omni_shadow_mode"), 1) : 0,
        shadowMaxDistance: n(prop("directional_shadow_max_distance"), 100),
        bake: n(prop("light_bake_mode"), 2),
        aabb: pointBox(t),
      });
      return;
    }
    if (BODIES.has(type)) {
      objects.push({ ...base, kind: "body", aabb: pointBox(t) });
      return;
    }
    if (type === "CollisionShape3D" || type === "CollisionPolygon3D") {
      const id = refId(prop("shape"));
      const v = prop("shape");
      let shapeType = null;
      let faces = 0;
      if (id !== null && v.$ === "SubResource") {
        const sub = sc.file.sub.get(id);
        shapeType = sub ? String(sub.attrs.type) : null;
        const data = sub?.get("data");
        if (shapeType === "ConcavePolygonShape3D" && data && data.$) faces = Math.floor(data.args.length / 9);
      } else if (id !== null) shapeType = "external";
      objects.push({ ...base, kind: "collider", shapeType, faces, disabled: prop("disabled") === true, aabb: pointBox(t) });
      return;
    }
    if (CSG.has(type)) {
      objects.push({ ...base, kind: "csg", collision: prop("use_collision") === true, aabb: pointBox(t), triangles: 200, surfaces: 1 });
      return;
    }
    if (PARTICLES.has(type)) {
      objects.push({ ...base, kind: "particles", amount: n(prop("amount"), 8), hasAabb: hasProp("visibility_aabb"), lifetime: n(prop("lifetime"), 1), aabb: pointBox(t), surfaces: 1 });
      return;
    }
    if (type === "WorldEnvironment") {
      const id = refId(prop("environment"));
      const v = prop("environment");
      let env = null;
      if (id !== null && v.$ === "SubResource") env = sc.file.sub.get(id);
      else if (id !== null) {
        const p = this.refKey(path, sc.file, v);
        const text = p && /\.tres$/.test(p) ? this.project.text(p) : null;
        if (text) env = new ResourceFile(text).sections.find((s) => s.tag === "resource");
      }
      const flag = (k) => env?.get(k) === true;
      objects.push({ ...base, kind: "environment", sdfgi: flag("sdfgi_enabled"), ssao: flag("ssao_enabled"), ssil: flag("ssil_enabled"), ssr: flag("ssr_enabled"), glow: flag("glow_enabled"), volumetricFog: flag("volumetric_fog_enabled"), fog: flag("fog_enabled"), sdfgiCascades: n(env?.get("sdfgi_cascades"), 4), aabb: null });
      return;
    }
    if (type === "Camera3D") {
      objects.push({ ...base, kind: "camera", far: n(prop("far"), 4000), near: n(prop("near"), 0.05), fov: n(prop("fov"), 75), current: prop("current") === true, aabb: pointBox(t) });
      return;
    }
    if (type === "ReflectionProbe") {
      objects.push({ ...base, kind: "probe", updateAlways: n(prop("update_mode"), 0) === 1, aabb: pointBox(t) });
      return;
    }
    if (OTHER.has(type)) {
      objects.push({ ...base, kind: type === "OccluderInstance3D" ? "occluder" : type === "VoxelGI" || type === "LightmapGI" ? "gi" : "other", aabb: pointBox(t) });
      return;
    }
    if (base.script) objects.push({ ...base, kind: "scripted", aabb: null });
  }
}

function pointBox(t) {
  return [t[9], t[10], t[11], t[9], t[10], t[11]];
}

/** Totals over a flattened scene. */
export function summarize(flat) {
  const sum = { nodes: flat.stats.nodes, meshInstances: 0, uniqueMeshes: 0, multimeshes: 0, multimeshInstances: 0, triangles: 0, trianglesUnknown: 0, surfaces: 0, materials: 0, lights: 0, shadowLights: 0, bodies: 0, colliders: 0, trimeshColliders: 0, particles: 0, csg: 0, occluders: 0, scripts: flat.stats.scripts, instances: flat.stats.instances, bounds: null };
  const meshes = new Set();
  const mats = new Set();
  for (const o of flat.objects) {
    if (o.kind === "mesh") {
      sum.meshInstances++;
      if (o.triangles == null) sum.trianglesUnknown++;
      else sum.triangles += o.triangles;
      sum.surfaces += o.surfaces;
      if (o.meshKey) meshes.add(o.meshKey);
      if (o.materialKey) mats.add(o.materialKey);
      if (o.aabb) sum.bounds = unionAabb(sum.bounds, o.aabb);
    } else if (o.kind === "multimesh") {
      sum.multimeshes++;
      sum.multimeshInstances += o.count;
      sum.triangles += o.triangles ?? 0;
      sum.surfaces += o.surfaces;
    } else if (o.kind === "light") {
      sum.lights++;
      if (o.shadow) sum.shadowLights++;
    } else if (o.kind === "body") sum.bodies++;
    else if (o.kind === "collider") {
      sum.colliders++;
      if (o.shapeType === "ConcavePolygonShape3D") sum.trimeshColliders++;
    } else if (o.kind === "particles") sum.particles++;
    else if (o.kind === "csg") sum.csg++;
    else if (o.kind === "occluder") sum.occluders++;
  }
  sum.uniqueMeshes = meshes.size;
  sum.materials = mats.size;
  if (sum.bounds) sum.extent = [sum.bounds[3] - sum.bounds[0], sum.bounds[4] - sum.bounds[1], sum.bounds[5] - sum.bounds[2]].map((x) => Math.round(x * 10) / 10);
  return sum;
}

export { aabbRadius, transformScale };
