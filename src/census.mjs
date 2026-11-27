// The live census: runs a scene of the game (a project folder or a .pck), lets it build its world, and counts what
// is really in the tree. This is how worlds that are built from code, and games that only exist as a pack, get the
// same findings as a scene file does.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { OptimizerError, findProjectRoot } from "./project.mjs";
import { findGodot, runProcess, wrapDisplay, importProject } from "./bench.mjs";
import { Project } from "./project.mjs";

export const CENSUS_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "tools", "go_census.gd");
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : String(Math.round(n)));

export async function census(options = {}) {
  const godot = findGodot(options.godot);
  const args = [];
  let stateDir;
  if (options.pack) {
    const pack = resolve(options.pack);
    if (!existsSync(pack)) throw new OptimizerError(`Pack not found: ${pack}`, "Pass the .pck of the exported game as `pack`.");
    args.push("--main-pack", pack);
    stateDir = join(tmpdir(), "gameoptimizer-census");
  } else {
    const root = findProjectRoot(options.project ?? ".");
    args.push("--path", root);
    stateDir = join(root, ".gameoptimizer");
    // A project that was never opened has no imported assets: its scenes cannot load yet.
    if (options.reimport || !existsSync(join(root, ".godot", "imported"))) await importProject(new Project(root), godot);
  }
  mkdirSync(join(stateDir, "census"), { recursive: true });
  if (!options.pack && !existsSync(join(stateDir, ".gdignore"))) writeFileSync(join(stateDir, ".gdignore"), "");
  const label = String(options.label ?? "census").replace(/[^A-Za-z0-9_.-]/g, "_");
  const out = join(stateDir, "census", `${label}.json`);
  rmSync(out, { force: true });
  if (options.renderer) args.push("--rendering-method", options.renderer);
  if (options.resolution) args.push("--resolution", options.resolution);
  args.push("-s", CENSUS_SCRIPT, "--", `--go-census=${out}`, `--go-seconds=${options.seconds ?? 20}`, `--go-frames=${options.frames ?? 120}`);
  if (options.scene) args.push(`--go-scene=${options.scene.startsWith("res://") ? options.scene : "res://" + options.scene}`);
  const [cmd, full] = wrapDisplay(godot, args, options.headless);
  const r = await runProcess(cmd, full, { timeoutMs: options.timeoutMs ?? Math.max(300_000, (options.seconds ?? 20) * 4000) });
  if (!existsSync(out)) {
    const lines = r.out.split("\n").filter((l) => l.trim() && !/ALSA|snd_|audio/i.test(l));
    throw new OptimizerError(`The census wrote no report${r.timedOut ? " (timed out)" : ` (exit code ${r.code})`}.`, [...lines.filter((l) => /^(SCRIPT ERROR|ERROR)/.test(l)).slice(0, 10), ...lines.slice(-12)].join("\n"));
  }
  const report = JSON.parse(readFileSync(out, "utf8"));
  if (report.error) throw new OptimizerError(`Census: ${report.error}`);
  const errors = [...new Set(r.out.split("\n").filter((l) => /^(SCRIPT ERROR|ERROR)/.test(l) && !/alsa|audio|pulse|status < 0|at exit|never freed|leaked at exit|still in use/i.test(l)))].slice(0, 15);
  return { file: out, report, errors, findings: analyzeCensus(report) };
}

/** Findings from a census report. Same shape as the audit's findings; ids start with "live/". */
export function analyzeCensus(c) {
  const out = [];
  const g = c.geometry ?? {};
  const add = (f) => out.push(f);
  const groups = g.groups ?? [];
  const where = (list) => [...new Set(list.map((x) => x.made_by).filter(Boolean))].slice(0, 4);

  const repeated = groups.filter((x) => x.count >= 200);
  if (repeated.length) {
    const nodes = repeated.reduce((a, x) => a + x.count, 0);
    add({
      id: "live/repeated-mesh-nodes",
      severity: nodes >= 20000 ? "high" : nodes >= 3000 ? "medium" : "low",
      category: "scene-tree",
      title: `${fmt(nodes)} nodes draw ${repeated.length} meshes over and over`,
      detail: "Each is a node in the tree, an instance to cull every frame and memory. The renderer batches their draw calls, so this is about tree size, culling and the time it takes to build them. Where the code creates them in a loop, fill one MultiMesh per world cell in that loop (MultiMesh.set_instance_transform), or draw without nodes through RenderingServer.instance_create. Keep cells small enough to cull and large enough not to multiply draw calls.",
      evidence: repeated.slice(0, 8).map((x) => ({ mesh: x.mesh, count: x.count, triangles_each: x.triangles_each, made_by: x.made_by || undefined, example: x.example })),
      metric: { nodes, kinds: repeated.length, scripts: where(repeated) },
      fix: null,
      risk: "code",
    });
  }
  if ((g.meshes_used_once ?? 0) >= 300 && g.meshes_used_once >= (g.unique_meshes ?? 0) * 0.5) {
    add({
      id: "live/mesh-per-object",
      severity: g.meshes_used_once >= 3000 ? "high" : "medium",
      category: "memory",
      title: `${fmt(g.meshes_used_once)} meshes are used by one object each`,
      detail: "Objects with their own mesh can never be batched or instanced, and each mesh is its own vertex buffer on the GPU. If the code builds the same shape again for every object (a new BoxMesh or ArrayMesh in a loop), build it once and share it; vary the look with the transform, instance uniforms or MultiMesh colours. If the shapes really differ (terrain tiles), this is expected.",
      evidence: groups.filter((x) => x.count === 1).slice(0, 6).map((x) => ({ mesh: x.mesh, triangles: x.triangles_each, made_by: x.made_by || undefined, example: x.example })),
      metric: { meshes_used_once: g.meshes_used_once, unique_meshes: g.unique_meshes },
      fix: null,
      risk: "code",
    });
  }
  if ((g.materials_used_once ?? 0) >= 200) {
    add({
      id: "live/material-per-object",
      severity: g.materials_used_once >= 2000 ? "high" : "medium",
      category: "draw-calls",
      title: `${fmt(g.materials_used_once)} materials are used by one object each`,
      detail: "Two objects only share a draw call when they share the material. A material made per object (StandardMaterial3D.new() or duplicate() in a loop) puts every object in its own draw call and its own uniform set. Make the material once and share it; per-object colour belongs in an instance uniform (set_instance_shader_parameter) or MultiMesh colours.",
      metric: { materials_used_once: g.materials_used_once, unique_materials: g.unique_materials, mesh_instances: g.mesh_instances },
      fix: null,
      risk: "code",
    });
  }
  if ((g.small_without_range ?? 0) >= 200) {
    add({
      id: "live/no-visibility-range",
      severity: g.small_without_range >= 5000 ? "high" : "medium",
      category: "culling",
      title: `${fmt(g.small_without_range)} small objects are drawn at any distance`,
      detail: `They have no visibility range and are culled only by the far plane (${c.camera_far} m), although they are smaller than 6 pixels long before that. For nodes that scripts create, GOWorldPolicy sets a range sized from each object's own box as the node enters the tree, within a time budget.`,
      metric: { objects: g.small_without_range, triangles: g.small_without_range_triangles, mesh_instances: g.mesh_instances },
      fix: { fix: "policy" },
      gain: `up to ${fmt(g.small_without_range)} culled instances and ${fmt(g.small_without_range_triangles ?? 0)} triangles less in wide views`,
      risk: "visual-safe",
    });
  }
  if ((g.tiny_shadow_casters ?? 0) >= 200) {
    add({ id: "live/tiny-shadow-casters", severity: "medium", category: "shadows", title: `${fmt(g.tiny_shadow_casters)} objects smaller than 70 cm cast shadows`, detail: "Each is drawn again in every shadow cascade and shadowed light that reaches it, for a shadow a few texels wide. GOWorldPolicy turns their shadows off as they enter the tree.", metric: { objects: g.tiny_shadow_casters }, fix: { fix: "policy" }, risk: "visual-safe" });
  }
  const L = c.lights ?? {};
  if ((L.positional_without_fade ?? 0) >= 16) {
    add({ id: "live/lights-without-distance-fade", severity: (L.shadowed ?? 0) >= 16 ? "high" : "medium", category: "lights", title: `${L.positional_without_fade} omni and spot lights never fade out (${L.shadowed ?? 0} lights cast shadows)`, detail: "Every light in view is clustered and shaded however far away, and its shadow map is drawn. GOWorldPolicy gives lights a distance fade from their range as they enter the tree: the shadow goes first, the light much later.", evidence: (L.examples ?? []).filter((x) => !x.distance_fade).slice(0, 5), metric: { lights: L.positional_without_fade, shadowed: L.shadowed }, fix: { fix: "policy" }, risk: "visual-safe" });
  }
  const T = c.textures ?? {};
  if ((T.uncompressed_large_mb ?? 0) >= 64) {
    const runtime = T.made_at_run_time_mb ?? 0;
    add({
      id: "live/uncompressed-textures",
      severity: T.uncompressed_large_mb >= 1024 ? "high" : "medium",
      category: "memory",
      title: `${Math.round(T.uncompressed_large_mb)} MB of textures in use are not GPU-compressed (${T.uncompressed_large} textures)`,
      detail: `Uncompressed textures take 4 bytes per pixel in VRAM; block compression takes 0.5 to 1. ${runtime >= 16 ? `${Math.round(runtime)} MB of that is made at run time (ImageTexture.create_from_image): those are never compressed, and Image.compress does not exist in an exported game. Bake them: write the image once, compress it with the editor binary and load the compressed file, or ship them as imported textures. ` : ""}Imported textures: set VRAM compression and mipmaps (fix textures). When VRAM runs out the driver starts paging and single frames take a second.`,
      evidence: (T.largest ?? []).filter((x) => !x.compressed).slice(0, 8).map((x) => ({ texture: x.path, size: x.size.join("x"), mb: x.mb })),
      metric: { uncompressed_mb: T.uncompressed_large_mb, made_at_run_time_mb: runtime, textures_mb: T.mb },
      fix: runtime < T.uncompressed_large_mb * 0.7 ? { fix: "textures" } : null,
      risk: "reimport",
    });
  }
  if ((c.processing ?? 0) + (c.physics_processing ?? 0) >= 1500) {
    const top = (c.scripts ?? []).filter((x) => x.processing + x.physics_processing > 0).slice(0, 8);
    add({ id: "live/many-processing-nodes", severity: c.processing + c.physics_processing >= 8000 ? "high" : "medium", category: "scripts", title: `${fmt(c.processing)} nodes run _process and ${fmt(c.physics_processing)} run _physics_process every frame`, detail: "Each is a call into the script every frame, visible or not. Turn processing off for objects that are far or hidden (set_process(false) on a distance check done once a second, or process_mode on a parent), or move the loop into one manager that updates many objects from an array.", evidence: top.map((x) => ({ script: x.script, instances: x.count, processing: x.processing, physics_processing: x.physics_processing })), metric: { processing: c.processing, physics_processing: c.physics_processing }, fix: null, risk: "code" });
  }
  if ((c.nodes ?? 0) >= 30000) {
    add({ id: "live/large-tree", severity: c.nodes >= 80000 ? "high" : "medium", category: "scene-tree", title: `${fmt(c.nodes)} nodes in the tree`, detail: "Every search over the tree (find_child, find_children, get_nodes_in_group over large groups) and every propagated notification walks all of it; a whole-tree search costs tens of milliseconds here. Never search from the root while the game plays: keep references, and build far content only when it comes near (GOStreamer for scenes, a distance check for generated chunks).", evidence: (c.made_by ?? []).slice(0, 8).map((x) => ({ script: x.name, nodes_below: x.count })), metric: { nodes: c.nodes }, fix: null, risk: "code" });
  }
  const big = (c.viewports ?? []).filter((v) => v.size[0] * v.size[1] >= 1024 * 1024 && v.update_mode >= 3);
  if (big.length >= 2) add({ id: "live/subviewports-always-updating", severity: "medium", category: "viewports", title: `${big.length} large SubViewports render every frame`, detail: "Each one is another render of its scene. Set render_target_update_mode to UPDATE_ONCE or UPDATE_WHEN_VISIBLE, lower the size, or update them at a lower rate.", evidence: big.slice(0, 6).map((v) => ({ path: v.path, size: v.size.join("x"), made_by: v.made_by || undefined })), fix: null, risk: "code" });
  if ((c.canvas_items ?? 0) >= 50000) add({ id: "live/many-canvas-items", severity: c.canvas_items >= 200000 ? "high" : "medium", category: "ui", title: `${fmt(c.canvas_items)} canvas items`, detail: "A map or list drawn as one node per element costs CPU render time every frame it is visible and a long frame whenever it redraws. Draw it in one _draw() with batched calls, or render it once to a texture and redraw only when it changes.", metric: { canvas_items: c.canvas_items, controls: c.controls }, fix: null, risk: "code" });
  if (c.extent && c.extent.farthest_from_origin > 8000) add({ id: "live/far-from-origin", severity: c.extent.farthest_from_origin > 20000 ? "high" : "medium", category: "precision", title: `Content up to ${fmt(c.extent.farthest_from_origin)} m from the origin`, detail: "32-bit floats lose accuracy with distance: from about 8 km positions, physics and turn rates start to round (a slow turn can round to exactly zero). Shift the origin with the player, or compute slow motions in doubles and write the result.", fix: null, risk: "code" });
  if ((c.physics?.trimesh_faces ?? 0) >= 500000) add({ id: "live/trimesh-colliders", severity: "medium", category: "physics", title: `${fmt(c.physics.trimesh_faces)} faces in trimesh colliders`, detail: "Concave shapes are the slowest to test. Keep them for terrain near the player; give far tiles no collider and props a box or a convex hull.", metric: c.physics.shapes, fix: null, risk: "code" });
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  out.sort((a, b) => order[a.severity] - order[b.severity]);
  return out;
}
