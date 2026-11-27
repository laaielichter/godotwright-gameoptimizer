// The audit: reads a project, builds the world model of its scenes and runs every rule.
import { Project } from "./project.mjs";
import { World, summarize } from "./world.mjs";
import { buildCostMap } from "./costmap.mjs";
import { analyzeWorld } from "./analyze/world.mjs";
import { analyzeTextures } from "./analyze/textures.mjs";
import { analyzeSettings } from "./analyze/settings.mjs";
import { analyzeScripts } from "./analyze/scripts.mjs";
import { analyzeShaders } from "./analyze/shaders.mjs";
import { modelsWithoutLods } from "./fix/settings.mjs";

const SEVERITY = { high: 0, medium: 1, low: 2, info: 3 };

/** Scenes worth a world model: the main scene and every scene no other scene instances, largest first. */
export function worldScenes(project, world, { scene, limit = 6 } = {}) {
  if (scene) return [project.rel(scene)];
  const scenes = project.ext(".tscn").filter((f) => !f.startsWith("addons/"));
  const instanced = new Set();
  for (const f of scenes) {
    const sc = world.scene(f);
    if (!sc) continue;
    for (const n of sc.nodes.list) if (n.instance) instanced.add(n.instance);
  }
  const main = project.mainScene;
  const tops = scenes.filter((f) => !instanced.has(f) || f === main);
  // Rank by size on disk first (cheap), keep the main scene.
  const ranked = tops.map((f) => ({ f, size: (project.text(f) ?? "").length })).sort((a, b) => b.size - a.size).map((x) => x.f);
  const pick = ranked.slice(0, limit);
  if (main && !pick.includes(main) && project.exists(main)) pick.unshift(main);
  return pick;
}

export function audit(root, options = {}) {
  const started = Date.now();
  const project = root instanceof Project ? root : new Project(root);
  const world = new World(project);
  const scenes = worldScenes(project, world, options);
  const findings = [];
  const sceneReports = [];
  let is3d = false;
  let openWorld = false;
  let manyBodies = false;
  for (const s of scenes) {
    const flat = world.flatten(s);
    const summary = summarize(flat);
    if (summary.meshInstances + summary.multimeshes + summary.lights === 0) continue;
    is3d = true;
    const map = buildCostMap(flat.objects, { cellSize: options.cellSize, viewDistance: options.viewDistance });
    const extent = summary.extent ? Math.max(summary.extent[0], summary.extent[2]) : 0;
    if (extent >= 500) openWorld = true;
    if (summary.bodies >= 200) manyBodies = true;
    findings.push(...analyzeWorld(flat, summary, map, project));
    sceneReports.push({ scene: s, summary, costmap: { cellSize: map.cellSize, columns: map.columns, rows: map.rows, totals: map.totals, hotspots: map.hotspots.map((h) => ({ center: h.center, viewTriangles: h.viewTriangles, viewDraws: h.viewDraws, objects: h.objects })) } });
  }
  if (!is3d) is3d = project.ext(".glb", ".gltf", ".obj").length > 0 || project.ext(".gd").some((f) => /Node3D|MeshInstance3D|Camera3D/.test(project.text(f) ?? ""));
  const tex = analyzeTextures(project);
  findings.push(...tex.findings);
  const noLods = modelsWithoutLods(project);
  if (noLods.length) {
    noLods.sort((a, b) => b.triangles - a.triangles);
    findings.push({ id: "models/lods-disabled", severity: noLods.some((m) => m.triangles >= 50000) ? "medium" : "low", category: "geometry", title: `${noLods.length} models are imported without mesh LODs`, detail: "Godot generates LODs on import and switches between them by size on screen, for free at run time. These models have generate_lods off, so they are drawn at full detail at any distance.", evidence: noLods.slice(0, 8), fix: { fix: "lods" }, gain: "fewer triangles for distant models", risk: "reimport" });
  }
  const scripts = analyzeScripts(project);
  findings.push(...scripts.findings);
  if (!openWorld && scripts.findings.some((f) => f.id === "script/mesh-node-per-object" || f.id === "script/mesh-built-on-main-thread")) openWorld = true; // a world built from code
  const hasQualityKit = project.exists("addons/gameoptimizer/go_quality.gd");
  findings.push(...analyzeSettings(project, { is3d, openWorld, manyBodies, hasQualityKit }));
  findings.push(...analyzeShaders(project));
  if (is3d && !hasQualityKit) {
    findings.push({ id: "runtime/no-quality-tiers", severity: "medium", category: "settings", title: "No scalable quality settings", detail: "One fixed set of render settings fits one class of GPU. The runtime kit adds quality tiers (low to cinematic) that change resolution scale, upscaler, shadows, GI and effects at run time, an adaptive governor that holds the frame rate, a streaming node, a time-sliced spawn queue and a shader prewarmer.", fix: { fix: "install" }, risk: "safe" });
  }
  findings.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
  findings.forEach((f, i) => (f.n = i + 1));
  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return {
    project: { root: project.root, name: project.name, renderer: project.renderer, engine: project.engineVersion, main_scene: project.mainScene, files: project.files.length, scripts: scripts.scripts },
    scenes: sceneReports,
    textures: { count: tex.inventory.length, vram_mb: Math.round(tex.vramBytes / 1048576) },
    counts,
    score: score(counts),
    findings,
    plan: plan(findings),
    ms: Date.now() - started,
  };
}

function score(c) {
  return Math.max(0, 100 - c.high * 12 - c.medium * 5 - c.low * 2);
}

const ORDER = ["install", "settings", "textures", "lods", "lights", "ranges", "instancing", "partition"];
const STEP = {
  install: { title: "Install the runtime kit (quality tiers, governor, streamer, spawn queue, prewarm, probe)", risk: "safe" },
  settings: { title: "Write the recommended project settings", risk: "safe" },
  textures: { title: "VRAM-compress and mipmap the textures used in 3D, then re-import", risk: "reimport" },
  lods: { title: "Turn on mesh LODs and shadow meshes for imported models, then re-import", risk: "reimport" },
  lights: { title: "Give omni and spot lights a distance fade", risk: "visual-safe" },
  ranges: { title: "Give small objects a visibility range sized from their own box; stop tiny ones casting shadows", risk: "visual-safe" },
  instancing: { title: "Merge repeated meshes into one MultiMesh per world cell (a trade: far fewer nodes, coarser culling; keep it only if the benchmark agrees)", risk: "structural, measure" },
  partition: { title: "Partition the world scene into streamed chunks", risk: "structural" },
};

/** The fixes in the order to apply them, each with the findings it settles and how to verify it. */
export function plan(findings) {
  const steps = new Map();
  for (const f of findings) {
    if (!f.fix) continue;
    const key = f.fix.fix + (f.fix.scene ? `|${f.fix.scene}` : "");
    if (!steps.has(key)) steps.set(key, { fix: f.fix.fix, scene: f.fix.scene, findings: [], args: {} });
    const st = steps.get(key);
    st.findings.push(f.id);
    for (const [k, v] of Object.entries(f.fix)) if (k !== "fix") st.args[k] = v;
  }
  const list = [...steps.values()].sort((a, b) => ORDER.indexOf(a.fix) - ORDER.indexOf(b.fix));
  const out = list.map((s, i) => ({
    step: i + 1,
    title: STEP[s.fix].title + (s.scene ? ` (${s.scene})` : ""),
    tool: "optimizer_fix",
    args: { fix: s.fix, ...s.args },
    cli: `gameoptimizer fix ${s.fix}${s.scene ? ` --scene ${s.scene}` : ""}`,
    settles: s.findings,
    risk: STEP[s.fix].risk,
    ...(s.fix === "instancing" && !findings.some((f) => f.id === "world/repeated-mesh-nodes" && f.severity === "high") ? { optional: true, when: "Skip it unless node count or load time is the problem: Forward+ already batches identical meshes, and partition streams them as they are." } : {}),
  }));
  const manual = findings.filter((f) => !f.fix && f.severity !== "info").map((f) => f.id);
  return { steps: out, manual, verify: "After each step: optimizer_bench with the same route, then optimizer_compare against the baseline. Undo a step that made it worse with optimizer_undo." };
}
