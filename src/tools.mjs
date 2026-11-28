// The tools: one definition each, used by both the MCP server and the CLI. Every tool takes a JSON object and
// returns a JSON object; nothing prints.
import { Project, OptimizerError } from "./project.mjs";
import { audit, worldScenes } from "./audit.mjs";
import { World, summarize } from "./world.mjs";
import { buildCostMap, routeFromCostMap, renderCostMap, validateCellSize } from "./costmap.mjs";
import { Transaction, undo, journalEntries } from "./journal.mjs";
import { fixSettings, fixTextures, fixLods } from "./fix/settings.mjs";
import { fixLights, fixRanges, fixInstancing } from "./fix/scene.mjs";
import { fixPartition } from "./fix/partition.mjs";
import { fixInstall, fixPolicy } from "./fix/install.mjs";
import { census } from "./census.mjs";
import { bench, compare, importProject, findGodot } from "./bench.mjs";
import { textureInventory } from "./analyze/textures.mjs";
import { writeDemoWorld } from "./demo.mjs";
import { EXPLAIN } from "./explain.mjs";

const projectProp = { type: "string", description: "Folder of the Godot project (the one with project.godot), or any path inside it. Default: the current folder." };
const sceneProp = { type: "string", description: "Scene to work on, as a res:// or project-relative path. Default: the main scene, or the largest world scene." };

function pickScene(project, scene) {
  if (scene) {
    const rel = project.rel(scene);
    if (!project.exists(rel)) throw new OptimizerError(`Scene not found: ${rel}`, "Pass a .tscn path relative to the project folder.");
    return rel;
  }
  const world = new World(project);
  const list = worldScenes(project, world, {});
  let best = null;
  for (const s of list) {
    const sum = summarize(world.flatten(s));
    const weight = sum.meshInstances + sum.multimeshInstances + sum.instances;
    if (!best || weight > best.weight) best = { s, weight };
  }
  if (!best || best.weight === 0) throw new OptimizerError("No 3D scene found in the project.", "Pass `scene`.");
  return best.s;
}

const FIXES = {
  install: { run: (p, tx) => fixInstall(p, tx), needsScene: false, summary: "Installs addons/gameoptimizer (quality tiers, governor, streamer, spawn queue, prewarm, probe) and its autoloads." },
  policy: { run: (p, tx, a) => fixPolicy(p, tx, { pixels: a.pixels ?? 6 }), needsScene: false, summary: "Culling rules for nodes that scripts create at run time (GOWorldPolicy)." },
  settings: {
    run: (p, tx) => {
      const a = audit(p, {});
      const ctx = { is3d: true, openWorld: a.scenes.some((s) => s.summary.extent && Math.max(s.summary.extent[0], s.summary.extent[2]) >= 500), manyBodies: a.scenes.some((s) => s.summary.bodies >= 200) };
      return fixSettings(p, tx, ctx);
    },
    needsScene: false,
    summary: "Writes the recommended project settings.",
  },
  textures: { run: (p, tx, a) => fixTextures(p, tx, { sizeLimit: a.size_limit ?? 0 }), needsScene: false, summary: "VRAM compression and mipmaps for textures used in 3D (edits .import files; re-import after)." },
  lods: { run: (p, tx) => fixLods(p, tx), needsScene: false, summary: "Turns on LOD and shadow-mesh generation for imported models." },
  lights: { run: (p, tx, a) => fixLights(p, tx, { scene: a.scene, paraboloid: !!a.paraboloid }), needsScene: true, summary: "Distance fade for omni and spot lights." },
  ranges: { run: (p, tx, a) => fixRanges(p, tx, { scene: a.scene, pixels: a.pixels ?? 6, shadows: a.shadows !== false, fade: !!a.fade }), needsScene: true, summary: "Visibility ranges from each object's size; tiny objects stop casting shadows." },
  instancing: { run: (p, tx, a) => fixInstancing(p, tx, { scene: a.scene, cellSize: a.cell_size, minCount: a.min_count ?? 12, pixels: a.pixels ?? 6 }), needsScene: true, summary: "Repeated meshes become one MultiMesh per world cell." },
  partition: { run: (p, tx, a) => fixPartition(p, tx, { scene: a.scene, cellSize: a.cell_size, loadRadius: a.load_radius, farRadius: a.far_radius, nodes: a.nodes, minChildren: a.min_children ?? 24, pixels: a.pixels ?? 6, far: a.far !== false, proxies: a.stand_ins !== false }), needsScene: true, summary: "Cuts the world scene into streamed chunk scenes with GOStreamer nodes." },
};

/**
 * Reject a value outside an inputSchema enum, naming the option and its
 * allowed values. Called from the CLI and the MCP server before the handler
 * runs, so one check covers every tool, including ones added later.
 * `fix` is left to optimizer_fix's own `Unknown fix` error (tools.mjs:152).
 */
export function validateEnumArgs(tool, args) {
  for (const [name, def] of Object.entries(tool.inputSchema.properties ?? {})) {
    if (name === "fix" || !def?.enum) continue;
    const value = args[name];
    if (value !== undefined && !def.enum.includes(value)) {
      throw new OptimizerError(
        `--${name.replace(/_/g, "-")} must be one of ${def.enum.join(", ")}, got ${JSON.stringify(value)}.`,
      );
    }
  }
}

export const TOOLS = [
  {
    name: "optimizer_audit",
    title: "Audit a Godot project for performance",
    description:
      "Start here. Reads the project's files (no Godot needed, seconds even on a large project) and returns what holds its frame rate, memory and load times back: a world model of each scene (nodes, meshes, triangles, draw surfaces, lights, bodies, extent), ranked findings with evidence, and a plan: the fixes to apply in order, each as a ready optimizer_fix call. Findings without a fix say what to change by hand.",
    inputSchema: {
      type: "object",
      properties: {
        project: projectProp,
        scene: { ...sceneProp, description: "Audit only this scene's world. Default: the main scene and the largest scenes." },
        cell_size: { type: "number", description: "Cell size in metres. Default: chosen from the size of the world." },
        detail: { type: "string", enum: ["brief", "full"], description: "brief (default): findings with up to 3 pieces of evidence each. full: all evidence." },
        min_severity: { type: "string", enum: ["high", "medium", "low", "info"], description: "Leave out findings below this severity." },
      },
    },
    annotations: { readOnlyHint: true },
    handler(a) {
      validateCellSize(a.cell_size);
      const r = audit(a.project ?? ".", { scene: a.scene, cellSize: a.cell_size });
      const order = ["high", "medium", "low", "info"];
      const min = order.indexOf(a.min_severity ?? "info");
      r.findings = r.findings.filter((f) => order.indexOf(f.severity) <= min);
      if (a.detail !== "full") for (const f of r.findings) if (Array.isArray(f.evidence) && f.evidence.length > 3) f.evidence = [...f.evidence.slice(0, 3), { more: f.evidence.length - 3 }];
      return r;
    },
  },
  {
    name: "optimizer_costmap",
    title: "Predict rendering cost across the world",
    description:
      "The world cost map of a scene: the map cut into cells, with what lies in each cell and what a camera standing there has in range (triangles, surfaces, objects), honouring visibility ranges. Surfaces are the ceiling of draw calls per pass: Forward+ batches identical mesh and material pairs. Returns the hotspots (where the frame rate will be lowest), a text picture of the map, and a benchmark route through the hotspots. Use it to see where a world is too dense before running it, and to choose a chunk size.",
    inputSchema: {
      type: "object",
      properties: {
        project: projectProp,
        scene: sceneProp,
        cell_size: { type: "number", description: "Cell size in metres. Default: chosen from the size of the world." },
        view_distance: { type: "number", description: "How far the camera sees objects that have no visibility range, in metres (default 1000)." },
        cells: { type: "boolean", description: "Also return every cell (can be thousands). Default false." },
      },
    },
    annotations: { readOnlyHint: true },
    handler(a) {
      validateCellSize(a.cell_size);
      const project = new Project(a.project ?? ".");
      const scene = pickScene(project, a.scene);
      const flat = new World(project).flatten(scene);
      const map = buildCostMap(flat.objects, { cellSize: a.cell_size, viewDistance: a.view_distance });
      return {
        scene,
        summary: summarize(flat),
        cell_size: map.cellSize,
        columns: map.columns,
        rows: map.rows,
        view_distance: map.viewDistance,
        totals: map.totals,
        hotspots: map.hotspots,
        route: routeFromCostMap(map),
        picture: { legend: "load per cell (near-weighted triangles, draws and shadowed lights), ' .:-=+*#%@' from none to the heaviest", map: renderCostMap(map) },
        ...(a.cells ? { cells: map.cells } : {}),
      };
    },
  },
  {
    name: "optimizer_fix",
    title: "Apply one optimization",
    description:
      "Applies one fix and records it in a journal so optimizer_undo can take it back. Fixes: install (runtime kit: quality tiers, adaptive governor, streamer, spawn queue, shader prewarm), policy (for worlds built from code: every mesh and light that enters the tree at run time gets a visibility range from its size, no shadow when tiny, a distance fade), settings (project settings), textures (VRAM compression and mipmaps for 3D textures), lods (mesh LODs for imported models), lights (distance fade), ranges (visibility ranges sized from each object, tiny shadow casters off), instancing (repeated meshes into one MultiMesh per world cell), partition (world scene into streamed chunks; needs install). Use dry_run first to see what would change. Order: as optimizer_audit's plan lists them; measure with optimizer_bench before and after.",
    inputSchema: {
      type: "object",
      required: ["fix"],
      properties: {
        project: projectProp,
        fix: { type: "string", enum: Object.keys(FIXES), description: "Which fix." },
        scene: sceneProp,
        dry_run: { type: "boolean", description: "Report what would change and write nothing." },
        pixels: { type: "number", description: "ranges, instancing, partition: an object is dropped where it is smaller than this many pixels at 1080p (default 6; higher is more aggressive)." },
        cell_size: { type: "number", description: "instancing, partition: cell size in metres (default: from the size of the world)." },
        load_radius: { type: "number", description: "partition: distance at which detail chunks load (default 2.5 cells)." },
        far_radius: { type: "number", description: "partition: distance at which chunks of large objects load (default: as far as each is visible)." },
        far: { type: "boolean", description: "partition: keep large objects visible beyond the load radius (default true). false: everything loads at load_radius." },
        stand_ins: { type: "boolean", description: "partition: draw the large parts of unloaded chunks with a light stand-in scene, one MultiMesh per mesh (default true). false: large objects go into far chunks as real nodes." },
        nodes: { type: "array", items: { type: "string" }, description: "partition: only these container node paths (default: every plain Node3D with many children)." },
        min_children: { type: "number", description: "partition: a container needs this many children (default 24)." },
        min_count: { type: "number", description: "instancing: merge a mesh that is placed at least this many times (default 12)." },
        shadows: { type: "boolean", description: "ranges: also stop objects smaller than 70 cm casting shadows (default true)." },
        fade: { type: "boolean", description: "ranges: fade objects out over the margin instead of a hysteresis switch (costs a transparent pass while fading)." },
        paraboloid: { type: "boolean", description: "lights: switch small shadowed omni lights to dual-paraboloid shadows (2 passes instead of 6; slightly softer)." },
        size_limit: { type: "number", description: "textures: also cap texture size at this many pixels." },
      },
    },
    handler(a) {
      const def = FIXES[a.fix];
      if (!def) throw new OptimizerError(`Unknown fix "${a.fix}".`, `Fixes: ${Object.keys(FIXES).join(", ")}.`);
      if (a.fix === "instancing" || a.fix === "partition") validateCellSize(a.cell_size);
      const project = new Project(a.project ?? ".");
      const args = { ...a };
      if (def.needsScene) args.scene = pickScene(project, a.scene);
      const tx = new Transaction(project, a.fix, { dryRun: !!a.dry_run });
      const result = def.run(project, tx, args);
      const commit = tx.commit();
      const files = (list) => (list.length > 12 ? [...list.slice(0, 12), `... ${list.length - 12} more`] : list);
      return { fix: a.fix, ...(def.needsScene ? { scene: args.scene } : {}), dry_run: !!a.dry_run, result, files_changed: files(commit.changed), files_created: commit.created.length > 12 ? commit.created.length : commit.created, files_deleted: files(commit.deleted), ...(commit.journal ? { journal: commit.journal, undo: { tool: "optimizer_undo", args: { id: commit.journal } } } : {}), next: a.dry_run ? "Run again without dry_run to apply." : "Measure: optimizer_bench, then optimizer_compare with your baseline." };
    },
  },
  {
    name: "optimizer_undo",
    title: "Undo a fix",
    description: "Restores the files a fix changed and removes the files it created. Without id: the last fix. With list: shows the journal and changes nothing.",
    inputSchema: { type: "object", properties: { project: projectProp, id: { type: "number", description: "Journal entry to undo (default: the last)." }, list: { type: "boolean", description: "Only list the journal." } } },
    handler(a) {
      const project = new Project(a.project ?? ".");
      if (a.list) return { journal: journalEntries(project).map((e) => ({ id: e.id, fix: e.fix, time: e.time, changed: e.changed.length, created: e.created.length })) };
      return undo(project, a.id);
    },
  },
  {
    name: "optimizer_bench",
    title: "Measure the game",
    description:
      "Runs the game in Godot with the probe and returns measured numbers: frame time percentiles, hitches (with position and what was loading), draw calls, primitives, video and texture memory, node count, and a screenshot per station. The camera follows a route through the predicted hotspots; the route is made once and reused, so runs before and after a fix see the same views. Give the first run label \"baseline\". Needs Godot 4 (pass godot or set GODOT); imports the project first when needed. Without a display on Linux it uses xvfb; headless measures CPU-side cost only.",
    inputSchema: {
      type: "object",
      properties: {
        project: projectProp,
        scene: sceneProp,
        label: { type: "string", description: 'Name of this run, e.g. "baseline" or "after-instancing". Default: run-N.' },
        frames: { type: "number", description: "Frames to measure in total (default 300)." },
        warmup: { type: "number", description: "Frames before measuring (default 30)." },
        mode: { type: "string", enum: ["stations", "fly"], description: "stations (default): stand at each hotspot, measure, take a screenshot. fly: move along the route, which exercises streaming and shows hitches." },
        tier: { type: "string", description: "Quality tier to apply first (needs the runtime kit): low, medium, high, ultra, cinematic." },
        resolution: { type: "string", description: 'Window size, e.g. "1920x1080".' },
        renderer: { type: "string", enum: ["forward_plus", "mobile", "gl_compatibility"], description: "Rendering method for this run (default: the project's)." },
        headless: { type: "boolean", description: "No rendering: script, physics and scene cost only." },
        route: { type: "string", description: "Route file to use instead of the generated one: {mode, stations:[{pos:[x,y,z], look_at:[x,y,z]}]}." },
        reimport: { type: "boolean", description: "Import the project before the run (needed after the textures or lods fix)." },
        fixed_fps: { type: "number", description: "Game time per frame as a frame rate (default 60): every run then sees the same animation and sun state at the same frame. 0: real time." },
        godot: { type: "string", description: "Path of the Godot 4 binary (default: $GODOT, then PATH)." },
      },
    },
    async handler(a) {
      const r = await bench(a.project ?? ".", { scene: a.scene, label: a.label, frames: a.frames, warmup: a.warmup, mode: a.mode, tier: a.tier, resolution: a.resolution, renderer: a.renderer, headless: a.headless, route: a.route, reimport: a.reimport, godot: a.godot, fixedFps: a.fixed_fps });
      const rep = r.report;
      return {
        label: r.label,
        scene: r.scene,
        seconds: r.seconds,
        engine: rep.engine,
        renderer: rep.renderer,
        adapter: rep.adapter,
        resolution: rep.resolution,
        frames: rep.frames,
        frame_ms: rep.frame_ms,
        fps_p50: rep.frame_ms?.p50 ? Math.round(1000 / rep.frame_ms.p50) : null,
        hitch_count: rep.hitch_count,
        hitches: (rep.hitches ?? []).slice(0, 5),
        pipeline_compiles: rep.pipeline_compiles,
        monitors: rep.monitors,
        stations: (rep.stations ?? []).map((s) => ({ index: s.index, pos: s.pos, frame_ms_p50: s.frame_ms?.p50, draw_calls: s.draw_calls, primitives: s.primitives, shot: s.shot })),
        streamers: rep.streamers,
        errors: r.errors,
        warnings: rep.warnings,
        report_file: r.file,
        shots: r.shots,
        next: r.label === "baseline" ? "Apply a fix, run optimizer_bench with another label, then optimizer_compare." : `optimizer_compare {"baseline": "baseline", "run": "${r.label}"}`,
      };
    },
  },
  {
    name: "optimizer_compare",
    title: "Compare two measurements",
    description: "Compares a run with a baseline: every metric before and after with a verdict (better, same, worse; changes within the noise margin count as same), each station's frame time and draw calls, and the station screenshots compared pixel by pixel so an optimization that changed the picture is caught. The verdict says whether to keep the last fix.",
    inputSchema: {
      type: "object",
      required: ["run"],
      properties: {
        project: projectProp,
        baseline: { type: "string", description: 'Label of the baseline run (default "baseline").' },
        run: { type: "string", description: "Label of the run to judge." },
        noise: { type: "number", description: "Changes within this many percent count as the same (default 5)." },
        visual_limit: { type: "number", description: "A picture counts as changed when more than this percent of its pixels differ (default 2)." },
      },
    },
    annotations: { readOnlyHint: true },
    handler(a) {
      return compare(new Project(a.project ?? "."), a.baseline ?? "baseline", a.run, { noise: a.noise ?? 5, visualLimit: a.visual_limit ?? 2 });
    },
  },
  {
    name: "optimizer_census",
    title: "Count what a running game really holds",
    description:
      "For worlds that are built from code and for games that only exist as a .pck: starts a scene in Godot, gives it time to build, then walks the live tree. Returns nodes by class, by script and by the script that created them, which nodes process every frame, mesh instances grouped by mesh and material (repeats, a mesh or a material per object), objects without a visibility range, tiny shadow casters, lights, physics shapes, SubViewports, canvas items, textures in use with their GPU format (uncompressed, made at run time), and findings from all of that. optimizer_audit reads files; this reads the game. Needs Godot 4 (the editor binary also runs a .pck).",
    inputSchema: {
      type: "object",
      properties: {
        project: projectProp,
        pack: { type: "string", description: "Path of an exported game's .pck, instead of a project folder." },
        scene: { type: "string", description: "Scene to start (default: the main scene)." },
        seconds: { type: "number", description: "How long the world gets to build before it is counted (default 20; a large streamed world needs more)." },
        frames: { type: "number", description: "And at least this many frames (default 120)." },
        headless: { type: "boolean", description: "No rendering: counts are the same, draw-call monitors are 0. Use it on machines without a GPU." },
        label: { type: "string", description: "Name of the report (default census)." },
        detail: { type: "string", enum: ["brief", "full"], description: "brief (default): findings and totals. full: also every table of the report." },
        godot: { type: "string", description: "Path of the Godot 4 binary (default: $GODOT, then PATH)." },
      },
    },
    annotations: { readOnlyHint: true },
    async handler(a) {
      const r = await census({ project: a.project, pack: a.pack, scene: a.scene, seconds: a.seconds, frames: a.frames, headless: a.headless, label: a.label, godot: a.godot });
      const c = r.report;
      const g = c.geometry;
      const brief = {
        scene: c.scene,
        engine: c.engine,
        renderer: c.renderer,
        headless: c.headless,
        seconds: c.seconds,
        totals: { nodes: c.nodes, processing: c.processing, physics_processing: c.physics_processing, mesh_instances: g.mesh_instances, triangles: g.triangles, unique_meshes: g.unique_meshes, unique_materials: g.unique_materials, multimesh_instances: g.multimesh_instances, lights: c.lights.types, textures_mb: c.textures.mb, canvas_items: c.canvas_items },
        monitors: c.monitors,
        findings: r.findings,
        built_by: (c.made_by ?? []).slice(0, 10),
        errors: r.errors,
        report_file: r.file,
        next: r.findings.some((f) => f.fix?.fix === "policy") ? 'optimizer_fix {"fix": "policy"}, then optimizer_census again: the counts without a range should drop.' : "optimizer_explain with a finding id says what to change in the code.",
      };
      return a.detail === "full" ? { ...brief, report: c } : brief;
    },
  },
  {
    name: "optimizer_textures",
    title: "Texture memory report",
    description: "Every texture with its size, import mode and estimated GPU memory, largest first, and the total. Use it to find what fills the VRAM budget.",
    inputSchema: { type: "object", properties: { project: projectProp, limit: { type: "number", description: "How many textures to list (default 30)." } } },
    annotations: { readOnlyHint: true },
    handler(a) {
      const project = new Project(a.project ?? ".");
      const list = textureInventory(project).sort((x, y) => y.vram - x.vram);
      const mb = (b) => Math.round((b / 1048576) * 10) / 10;
      return {
        textures: list.length,
        vram_mb: mb(list.reduce((s, t) => s + t.vram, 0)),
        vram_mb_if_fixed: mb(list.reduce((s, t) => s + (t.vramIfFixed ?? t.vram), 0)),
        largest: list.slice(0, a.limit ?? 30).map((t) => ({ file: t.path, size: `${t.width}x${t.height}`, used_in_3d: t.in3d, vram_compressed: t.compressed, mipmaps: t.mipmaps, vram_mb: mb(t.vram) })),
      };
    },
  },
  {
    name: "optimizer_import",
    title: "Import the project's assets",
    description: "Runs Godot's import (what the editor does when it opens the project). Needed after the textures or lods fix and for a project that was never opened. Uses the CPU texture compressor, so it also finishes on machines without a GPU.",
    inputSchema: { type: "object", properties: { project: projectProp, godot: { type: "string", description: "Path of the Godot 4 binary." } } },
    async handler(a) {
      const project = new Project(a.project ?? ".");
      return importProject(project, findGodot(a.godot));
    },
  },
  {
    name: "optimizer_explain",
    title: "Explain a finding or a technique",
    description: "What a finding means, why it costs performance in Godot, how the fix works and what to check afterwards. Pass a finding id from optimizer_audit (e.g. world/monolithic-scene) or a topic: streaming, instancing, visibility-ranges, quality-tiers, governor, shader-stutter, textures, shadows, occlusion, precision, physics, workflow.",
    inputSchema: { type: "object", required: ["topic"], properties: { topic: { type: "string", description: "Finding id or topic." } } },
    annotations: { readOnlyHint: true },
    handler(a) {
      const key = String(a.topic).toLowerCase();
      const hit = EXPLAIN[key] ?? Object.entries(EXPLAIN).find(([k, v]) => v.findings?.some((f) => key.startsWith(f) || f === key) || key.includes(k))?.[1];
      if (!hit) return { topic: a.topic, found: false, topics: Object.keys(EXPLAIN) };
      return { topic: a.topic, ...hit };
    },
  },
  {
    name: "optimizer_demo",
    title: "Write the demo open world",
    description: "Writes a heavy open-world Godot project to a folder: a 2 km map with forests, villages and street lights, built the unoptimized way. A safe place to try the tools; the numbers in the README come from it.",
    inputSchema: { type: "object", required: ["dir"], properties: { dir: { type: "string", description: "Folder to write the project to." }, trees: { type: "number" }, rocks: { type: "number" }, houses: { type: "number" }, lamps: { type: "number" }, fences: { type: "number" }, seed: { type: "number" }, extent: { type: "number", description: "Size of the map in metres (default 2000)." }, texture_size: { type: "number" }, procedural: { type: "boolean", description: "Build the world from a script at run time instead of a scene file (try optimizer_census on it)." }, force: { type: "boolean", description: "Overwrite an existing project there." } } },
    handler(a) {
      return writeDemoWorld(a.dir, { trees: a.trees, rocks: a.rocks, houses: a.houses, lamps: a.lamps, fences: a.fences, seed: a.seed, extent: a.extent, textureSize: a.texture_size, force: a.force, procedural: a.procedural });
    },
  },
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
export { FIXES };
