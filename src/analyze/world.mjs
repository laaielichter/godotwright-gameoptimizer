// Rules over the flattened world: draw calls, instancing, visibility ranges, shadows, lights, physics, streaming.
import { aabbRadius, aabbCenter } from "../godot/variant.mjs";

const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : String(Math.round(n)));

/** The distance at which a sphere of radius r covers `pixels` of a 1080p screen with a 75° vertical field of view. */
export function distanceForPixels(radius, pixels = 6, fovDeg = 75, screenHeight = 1080) {
  const k = screenHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
  return (2 * radius * k) / pixels;
}

/** Groups of identical meshes drawn as separate nodes that could be one MultiMesh per cell. */
export function instancingGroups(flat, { minCount = 12 } = {}) {
  const groups = new Map();
  for (const o of flat.objects) {
    if (o.kind !== "mesh" || !o.meshKey || o.inInstance || o.script || o.skinned) continue;
    if (o.depth !== 0 || !o.section) continue;
    const key = `${o.meshKey}|${o.materialKey ?? ""}|${o.castShadow ? 1 : 0}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  return [...groups.entries()].filter(([, v]) => v.length >= minCount).map(([key, items]) => ({ key, meshKey: items[0].meshKey, count: items.length, triangles: items[0].triangles, items }));
}

/** Instanced scenes that repeat: the same .tscn or model placed many times. */
export function repeatedInstances(flat, { minCount = 12 } = {}) {
  const groups = new Map();
  for (const o of flat.objects) {
    if (o.kind !== "instance" || o.depth !== 0) continue;
    if (!groups.has(o.target)) groups.set(o.target, []);
    groups.get(o.target).push(o);
  }
  return [...groups.entries()].filter(([, v]) => v.length >= minCount).map(([target, items]) => ({ target, count: items.length, items }));
}

export function analyzeWorld(flat, summary, map, project) {
  const out = [];
  const scene = flat.scene;
  const add = (f) => out.push({ scene, ...f });
  const meshes = flat.objects.filter((o) => o.kind === "mesh");
  const extent = summary.extent ? Math.max(summary.extent[0], summary.extent[2]) : 0;
  const cameras = flat.objects.filter((o) => o.kind === "camera");
  const far = cameras.length ? Math.max(...cameras.map((c) => c.far)) : 4000;

  // ---- instancing ------------------------------------------------------------------------------------------
  const groups = instancingGroups(flat);
  if (groups.length) {
    const nodes = groups.reduce((a, g) => a + g.count, 0);
    groups.sort((a, b) => b.count - a.count);
    add({
      id: "world/repeated-mesh-nodes",
      severity: nodes >= 5000 ? "high" : "medium",
      category: "scene-tree",
      title: `${fmt(nodes)} identical meshes are separate nodes (${groups.length} kinds)`,
      detail:
        "Every MeshInstance3D is a node to instantiate when the scene loads, an instance to cull each frame and memory in the scene tree. Forward+ already draws identical meshes in few draw calls, so this is not about draw calls: it is about node count, culling work and load time, and it is what makes chunks cheap to stream. A single MultiMesh is culled as one box, so the fix makes one per world cell, each with its own visibility range. Measure it: on a small world the per-cell draws can cost more than the nodes did.",
      evidence: groups.slice(0, 6).map((g) => ({ mesh: g.meshKey, count: g.count, triangles_each: g.triangles })),
      metric: { nodes, kinds: groups.length },
      fix: { fix: "instancing", scene },
      gain: "fewer nodes and culled instances, faster scene load and chunk streaming",
      risk: "structural",
    });
  }
  const rep = repeatedInstances(flat);
  if (rep.length) {
    rep.sort((a, b) => b.count - a.count);
    const total = rep.reduce((a, r) => a + r.count, 0);
    add({
      id: "world/repeated-scene-instances",
      severity: total >= 1000 ? "high" : "medium",
      category: "streaming",
      title: `${fmt(total)} placed copies of ${rep.length} scenes or models live in one scene`,
      detail: "All of them are instantiated when the scene loads and stay in memory wherever the player is. Cut the scene into streamed chunks so only the copies near the camera exist.",
      evidence: rep.slice(0, 6).map((r) => ({ scene: r.target, count: r.count })),
      metric: { copies: total },
      fix: { fix: "partition", scene },
      gain: "load time and memory scale with what is near, not with the whole world",
      risk: "structural",
    });
  }

  // ---- visibility ranges ----------------------------------------------------------------------------------
  if (meshes.length >= 50 && extent > 200) {
    let small = 0;
    let smallTris = 0;
    const examples = [];
    for (const o of meshes) {
      if (o.visEnd > 0 || !o.aabb) continue;
      const r = aabbRadius(o.aabb);
      if (r <= 0) continue;
      const d = distanceForPixels(r, 6);
      if (d < Math.min(far, extent) * 0.6) {
        small++;
        smallTris += o.triangles ?? 0;
        if (examples.length < 5) examples.push({ node: o.path, radius_m: Math.round(r * 100) / 100, invisible_beyond_m: Math.round(d) });
      }
    }
    if (small >= 30) {
      add({
        id: "world/no-visibility-range",
        severity: small >= 500 ? "high" : "medium",
        category: "culling",
        title: `${fmt(small)} small objects are drawn at any distance`,
        detail: `They have no visibility range, so they are culled only by the camera's far plane (${far} m) although they are smaller than 6 pixels long before that. A range sized from each object's own box removes them from the frame with a short fade, with no visible change.`,
        evidence: examples,
        metric: { objects: small, triangles: smallTris },
        fix: { fix: "ranges", scene },
        gain: `up to ${fmt(small)} culled instances and ${fmt(smallTris)} triangles less in wide views`,
        risk: "visual-safe",
      });
    }
  }

  // ---- shadows ----------------------------------------------------------------------------------------------
  const tinyCasters = meshes.filter((o) => o.castShadow && o.aabb && aabbRadius(o.aabb) < 0.35 && aabbRadius(o.aabb) > 0);
  if (tinyCasters.length >= 100) {
    add({
      id: "world/tiny-shadow-casters",
      severity: "medium",
      category: "shadows",
      title: `${fmt(tinyCasters.length)} objects smaller than 70 cm cast shadows`,
      detail: "Each one is drawn again in every shadow cascade and every shadowed light that reaches it. Their shadows are a few texels wide and flicker; turning them off costs nothing visible.",
      evidence: tinyCasters.slice(0, 5).map((o) => ({ node: o.path })),
      metric: { objects: tinyCasters.length },
      fix: { fix: "ranges", scene, shadows: true },
      gain: "fewer shadow draws (up to 4 per object with a 4-split sun)",
      risk: "visual-safe",
    });
  }
  const lights = flat.objects.filter((o) => o.kind === "light");
  const positional = lights.filter((l) => l.type !== "DirectionalLight3D");
  const shadowed = positional.filter((l) => l.shadow);
  const noFade = positional.filter((l) => !l.distanceFade);
  if (positional.length >= 16 && noFade.length >= 8) {
    add({
      id: "world/lights-without-distance-fade",
      severity: shadowed.length >= 16 ? "high" : "medium",
      category: "lights",
      title: `${noFade.length} of ${positional.length} omni and spot lights never fade out (${shadowed.length} cast shadows)`,
      detail: "Without distance fade every light in the view is clustered and shaded however far away, and its shadow map is drawn. With distance fade a light and its shadow switch off beyond a distance that follows its range.",
      evidence: noFade.slice(0, 5).map((l) => ({ node: l.path, range_m: l.range, shadow: l.shadow })),
      metric: { lights: noFade.length, shadowed: shadowed.length },
      fix: { fix: "lights", scene },
      gain: "light and shadow cost follows what is near",
      risk: "visual-safe",
    });
  }
  const omniCube = shadowed.filter((l) => l.type === "OmniLight3D" && l.shadowMode === 1);
  if (omniCube.length >= 12) {
    add({
      id: "world/many-cube-shadow-omnis",
      severity: "medium",
      category: "shadows",
      title: `${omniCube.length} omni lights use cube shadows`,
      detail: "A cube shadow renders the scene six times per light. Dual paraboloid renders it twice; use it for small and distant lights, or bake static lights.",
      evidence: omniCube.slice(0, 5).map((l) => ({ node: l.path })),
      fix: { fix: "lights", scene, paraboloid: true },
      risk: "visual",
    });
  }
  const sun = lights.filter((l) => l.type === "DirectionalLight3D" && l.shadow);
  if (sun.length > 1) {
    add({ id: "world/several-shadowed-suns", severity: "medium", category: "shadows", title: `${sun.length} directional lights cast shadows`, detail: "Each one renders all its cascades and they share the directional shadow atlas, which halves the resolution of each. Keep shadows on one.", evidence: sun.map((l) => ({ node: l.path })), fix: null, risk: "visual" });
  }
  for (const l of sun) {
    if (l.shadowMaxDistance > 500) add({ id: "world/sun-shadow-distance", severity: "low", category: "shadows", title: `Sun shadows reach ${l.shadowMaxDistance} m`, detail: "The cascades are stretched over that distance, so near shadows turn blurry and more objects are drawn into them. 150 to 300 m with 4 splits is the usual range for an open world; let fog and ambient light carry the rest.", evidence: [{ node: l.path }], fix: null, risk: "visual" });
  }

  // ---- geometry -----------------------------------------------------------------------------------------------
  const heavy = meshes.filter((o) => (o.triangles ?? 0) >= 100_000);
  if (heavy.length) {
    add({ id: "world/heavy-meshes", severity: "medium", category: "geometry", title: `${heavy.length} mesh instances have 100k triangles or more`, detail: "Make sure these have LODs (import with generate_lods, or split them so parts can be culled).", evidence: heavy.slice(0, 5).map((o) => ({ node: o.path, triangles: o.triangles })), fix: null, risk: "none" });
  }
  const csg = flat.objects.filter((o) => o.kind === "csg");
  if (csg.length >= 8) {
    add({ id: "world/csg-in-level", severity: "medium", category: "geometry", title: `${csg.length} CSG nodes in the scene`, detail: "CSG shapes are rebuilt on the CPU when the scene loads and whenever they move, and each is its own draw. They are a prototyping tool: bake them to a mesh (Mesh > Bake Mesh Instance in the editor) before shipping.", evidence: csg.slice(0, 5).map((o) => ({ node: o.path })), fix: null, risk: "none" });
  }
  const occluders = flat.objects.filter((o) => o.kind === "occluder").length;
  const bigMeshes = meshes.filter((o) => o.aabb && aabbRadius(o.aabb) > 6).length;
  if (occluders === 0 && bigMeshes >= 40 && meshes.length >= 400) {
    add({ id: "world/no-occluders", severity: "medium", category: "culling", title: "No occluders in a scene with many large objects", detail: `${bigMeshes} objects are larger than 12 m but nothing can hide what is behind them: Godot only culls against the view frustum unless occluders are baked. Add an OccluderInstance3D and bake it (terrain and buildings as occluders), and turn on rendering/occlusion_culling/use_occlusion_culling.`, fix: { fix: "settings" }, risk: "none" });
  }
  const particles = flat.objects.filter((o) => o.kind === "particles");
  const bigParticles = particles.filter((p) => p.amount >= 2000);
  if (bigParticles.length) add({ id: "world/heavy-particles", severity: "low", category: "particles", title: `${bigParticles.length} particle systems emit 2000 particles or more`, detail: "Check their visibility AABB and give them a visibility range so they stop simulating far away.", evidence: bigParticles.slice(0, 5).map((p) => ({ node: p.path, amount: p.amount })), fix: null, risk: "none" });

  // ---- physics --------------------------------------------------------------------------------------------------
  const trimesh = flat.objects.filter((o) => o.kind === "collider" && o.shapeType === "ConcavePolygonShape3D");
  if (trimesh.length >= 50) {
    const faces = trimesh.reduce((a, c) => a + c.faces, 0);
    add({ id: "world/many-trimesh-colliders", severity: "medium", category: "physics", title: `${trimesh.length} trimesh colliders (${fmt(faces)} faces)`, detail: "Concave shapes are the slowest to test and only work on static bodies. Use boxes, capsules or convex hulls for props; keep trimesh for terrain and large buildings.", evidence: trimesh.slice(0, 5).map((o) => ({ node: o.path, faces: o.faces })), fix: null, risk: "none" });
  }
  if (summary.bodies >= 2000) add({ id: "world/many-bodies", severity: "medium", category: "physics", title: `${fmt(summary.bodies)} physics bodies in one scene`, detail: "All of them are in the physics space at once. Streamed chunks add and remove their bodies with the chunk; far bodies can also be given no collision at all.", fix: { fix: "partition", scene }, risk: "structural" });

  // ---- scale ------------------------------------------------------------------------------------------------------
  if (summary.bounds) {
    const reach = Math.max(Math.abs(summary.bounds[0]), Math.abs(summary.bounds[3]), Math.abs(summary.bounds[2]), Math.abs(summary.bounds[5]));
    if (reach > 8000) add({ id: "world/far-from-origin", severity: reach > 20000 ? "high" : "medium", category: "precision", title: `Content up to ${fmt(reach)} m from the origin`, detail: "With single-precision floats, positions lose accuracy with distance: around 8 km shadows, physics and vertex positions start to jitter. Shift the origin as the player moves (move the world root so the camera stays near 0,0,0; GOStreamer chunks follow their parent), or use a double-precision build of Godot.", fix: null, risk: "none" });
  }
  const loose = flat.objects.filter((o) => o.depth === 0 && (o.kind === "mesh" || o.kind === "instance" || o.kind === "multimesh")).length;
  if (extent >= 500 && loose >= 400) {
    const hot = map?.totals;
    add({
      id: "world/monolithic-scene",
      severity: loose >= 3000 || extent >= 2000 ? "high" : "medium",
      category: "streaming",
      title: `One scene holds a ${fmt(extent)} m world with ${fmt(loose)} placed objects`,
      detail: "Godot has no built-in world streaming: this scene is loaded, instantiated and kept in memory as a whole, and loading it blocks the main thread. Partition it into chunk scenes on a grid; GOStreamer loads the chunks around the camera on a thread and attaches them within a per-frame time budget.",
      metric: { extent_m: extent, objects: loose, worst_view_triangles: hot?.viewTrianglesMax, worst_view_draws: hot?.viewDrawsMax },
      fix: { fix: "partition", scene },
      gain: "memory, load time and culling cost follow the load radius instead of the map size",
      risk: "structural",
    });
  }
  if (far >= 4000 && extent > 1000 && !flat.objects.some((o) => o.kind === "environment" && (o.fog || o.volumetricFog))) {
    add({ id: "world/far-plane-without-fog", severity: "low", category: "culling", title: `Camera far plane at ${far} m and no fog`, detail: "Everything within the far plane is drawn. Distance fog lets you pull the far plane and the visibility ranges in without a visible edge.", fix: null, risk: "visual" });
  }
  const env = flat.objects.find((o) => o.kind === "environment");
  if (env?.sdfgi && extent > 300) add({ id: "world/sdfgi-open-world", severity: "low", category: "gi", title: "SDFGI is on", detail: "SDFGI is the costliest effect of the Forward+ renderer (several ms on a mid-range GPU). Keep it for the high tiers: the quality tiers of GOQuality switch it per tier, with use_half_resolution on the middle ones.", fix: { fix: "install" }, risk: "none" });
  const probes = flat.objects.filter((o) => o.kind === "probe" && o.updateAlways);
  if (probes.length) add({ id: "world/probes-update-always", severity: "medium", category: "gi", title: `${probes.length} reflection probes update every frame`, detail: "A probe in 'Always' mode renders the scene six more times. Use 'Once' unless the surroundings change.", evidence: probes.slice(0, 5).map((p) => ({ node: p.path })), fix: null, risk: "visual" });
  return out;
}

export { aabbCenter };
