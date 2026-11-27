// GDScript rules: per-frame work, main-thread hitches and code that builds the world one node at a time.
import { scanScript, hotFunctions, HOT_FUNCS } from "../godot/gdscript.mjs";

const RULES = [
  // Per-frame lookups.
  { id: "script/lookup-every-frame", scope: "hot", severity: "medium", re: /\b(get_node\(|get_node_or_null\(|find_child\(|find_children\(|get_nodes_in_group\(|get_first_node_in_group\(|find_node\(|get_tree\(\)\.root\.find)|(?<![\w"'])\$[A-Za-z_"%]|(?<![\w"'])%[A-Z]\w+/, title: "Node lookups every frame", detail: "Each lookup walks the scene tree by name. Store the node once in an @onready variable; cache group results and refresh them when the group changes.", category: "scripts" },
  { id: "script/load-in-frame", scope: "hot", severity: "high", re: /(?<![\w.])(load|ResourceLoader\.load)\(/, title: "Blocking load() on a per-frame path", detail: "load() reads and parses the file on the main thread: the frame waits. Preload it, or request it with ResourceLoader.load_threaded_request and fetch it when ready (GOSpawnQueue.instantiate_async does both).", category: "hitches" },
  { id: "script/print-every-frame", scope: "hot-direct", severity: "low", re: /(?<![\w.])(print|prints|print_debug|print_rich)\(/, title: "print() every frame", detail: "Printing is slow (it locks and flushes stdout) and floods the log. Guard it or remove it.", category: "scripts", noLoopNeeded: true, skipIfGuarded: true },
  { id: "script/children-copied-every-frame", scope: "hot", severity: "low", re: /\.get_children\(\)|\.duplicate\(|\.get_overlapping_bodies\(\)|\.get_overlapping_areas\(\)/, title: "Arrays allocated every frame", detail: "These calls build a new array each time. In a per-frame function that is steady garbage and cache misses; keep the list and update it on signals.", category: "scripts" },
  { id: "script/time-window-modulo", scope: "hot", severity: "medium", re: /\bint\([^()]*(?:\([^()]*\)[^()]*)*\)\s*%\s*\d+\s*==\s*0/, title: "A time test that is true for a whole window of frames", detail: "`int(t * k) % n == 0` is not \"once every n/k seconds\": it stays true for 1/k seconds, so the code under it runs on every frame of that window. Keep the time of the next run and compare (if now >= next: next = now + interval), or use a Timer.", category: "scripts" },
  { id: "script/text-set-every-frame", scope: "hot-direct", severity: "low", re: /\.text\s*=(?!=)/, title: "Label text set every frame", detail: "Assigning text reshapes and redraws the label even when the string is the same. Assign only when the value changed (keep the last value, or update a few times per second).", category: "ui", unguardedOnly: true },
  // World building in loops.
  { id: "script/mesh-node-per-object", scope: "loop", severity: "high", re: /\bMeshInstance3D\.new\(\)/, title: "A MeshInstance3D per object, created in a loop", detail: "Thousands of nodes for identical meshes: each one is added to the tree, culled every frame and kept in memory. Fill one MultiMesh per world cell instead (set_instance_transform in the same loop), or draw through RenderingServer.instance_create without nodes.", category: "draw-calls" },
  { id: "script/material-per-object", scope: "loop", severity: "high", re: /\b(StandardMaterial3D|ORMMaterial3D|ShaderMaterial)\.new\(\)/, title: "A new material per object", detail: "Objects with their own material can never be batched or instanced together, and each material is its own pipeline lookup. Create the material once outside the loop and share it; vary per-instance colour with instance uniforms or MultiMesh colours.", category: "draw-calls" },
  { id: "script/instantiate-in-loop", scope: "loop", severity: "medium", re: /\.instantiate\(/, title: "Scenes instantiated in a loop", detail: "instantiate() and add_child() run on the main thread: a loop of them is one long frame. Spread them over frames with a time budget (GOSpawnQueue.add), or move the content into streamed chunks.", category: "hitches" },
  { id: "script/trimesh-in-loop", scope: "loop", severity: "high", re: /\.create_trimesh_collision\(\)|\.create_trimesh_shape\(\)|\.create_multiple_convex_collisions\(/, title: "Collision built from meshes in a loop", detail: "Building trimesh or convex shapes is slow and blocks the frame. Build each shape once and share the Shape3D, bake them into the scene, or build them on a WorkerThreadPool task.", category: "hitches" },
  { id: "script/load-in-loop", scope: "loop", severity: "medium", re: /(?<![\w.])load\(/, title: "load() inside a loop", detail: "Each call hits the resource cache or the disk. Load once before the loop, or preload.", category: "hitches" },
];

export function analyzeScripts(project, { maxFiles = 4000 } = {}) {
  const hits = new Map(); // rule id → [{file, line, func, code, via}]
  const rootSearch = [];
  const runtimeTextures = [];
  let processScripts = 0;
  let meshBuilders = 0;
  const builders = [];
  // Tests, tools and third-party addons are not the game's frame.
  const files = project.ext(".gd").filter((f) => !/(^|\/)(addons|tests?|qa|tools|gut|gdunit4?)\//.test(f)).slice(0, maxFiles);
  for (const f of files) {
    const text = project.text(f);
    if (!text) continue;
    const scan = scanScript(text);
    if (scan.toolScript && /extends\s+Editor/.test(text)) continue;
    const hot = hotFunctions(scan);
    if (scan.funcs.some((x) => x.name === "_process" || x.name === "_physics_process")) processScripts++;
    const threaded = /WorkerThreadPool|Thread\.new\(\)/.test(text);
    for (const fn of scan.funcs) {
      const direct = HOT_FUNCS.has(fn.name) && fn.name !== "_input" && fn.name !== "_unhandled_input";
      const isHot = hot.has(fn.name);
      for (const l of fn.lines) {
        if (/\b(root|get_root\(\)|current_scene)\.find_(child|children)\(/.test(l.code)) rootSearch.push({ file: f, line: l.n, func: fn.name, code: l.raw.trim().slice(0, 140), ...(isHot ? { per_frame: true } : {}) });
        if (/\bImageTexture\.create_from_image\(/.test(l.code)) runtimeTextures.push({ file: f, line: l.n, func: fn.name });
        for (const r of RULES) {
          if (r.scope === "hot" && !isHot) continue;
          if (r.scope === "hot-direct" && !direct) continue;
          if (r.scope === "loop" && (l.loopDepth < 1 || l.smallLoop || /^\s*(for|while)\b/.test(l.code) && l.loopDepth < 1)) continue;
          if (r.scope === "loop" && /^_?(test|debug|bench)/.test(fn.name)) continue;
          if (!r.re.test(l.code)) continue;
          if (r.skipIfGuarded && l.indent > fn.indent + 8) continue; // inside an if: probably a guarded debug print
          if (r.unguardedOnly && l.indent > fn.indent + 4) continue; // only at the top level of the function
          if (r.id === "script/lookup-every-frame" && /@onready|\bvar\s+\w+\s*:?=.*\bif\b/.test(l.code)) continue;
          // A load() in a helper that a per-frame function calls is often a cached lookup: report it apart, lower.
          const id = r.id === "script/load-in-frame" && !direct ? "script/load-reachable-from-frame" : r.id;
          if (!hits.has(id)) hits.set(id, []);
          hits.get(id).push({ file: f, line: l.n, func: fn.name, code: l.raw.trim().slice(0, 140), ...(isHot && !direct && r.scope !== "loop" ? { via: "called from a per-frame function" } : {}) });
        }
      }
      // Mesh generation on the main thread.
      if (!threaded && fn.lines.some((l) => /\b(SurfaceTool\.new\(\)|ArrayMesh\.new\(\)|\.add_surface_from_arrays\(|\.commit\()/.test(l.code)) && fn.lines.some((l) => l.loopDepth >= 1)) {
        meshBuilders++;
        if (builders.length < 12) builders.push({ file: f, line: fn.line, func: fn.name });
      }
    }
  }
  const out = [];
  const reach = hits.get("script/load-reachable-from-frame");
  if (reach?.length) {
    const fileCount = new Set(reach.map((h) => h.file)).size;
    out.push({ id: "script/load-reachable-from-frame", severity: "low", category: "hitches", title: `load() in helpers that per-frame functions call (${reach.length} places in ${fileCount} script${fileCount === 1 ? "" : "s"})`, detail: "If the helper runs once and caches its result this is fine. If it can run while the game plays (a new chunk, a new material), the frame waits for the disk: preload the resource or request it with ResourceLoader.load_threaded_request.", evidence: reach.slice(0, 10), metric: { places: reach.length, files: fileCount }, fix: null, risk: "code" });
  }
  for (const r of RULES) {
    const list = hits.get(r.id);
    if (!list || !list.length) continue;
    const fileCount = new Set(list.map((h) => h.file)).size;
    out.push({ id: r.id, severity: r.severity, category: r.category, title: `${r.title} (${list.length} places in ${fileCount} script${fileCount === 1 ? "" : "s"})`, detail: r.detail, evidence: list.slice(0, 10), metric: { places: list.length, files: fileCount }, fix: null, risk: "code" });
  }
  if (rootSearch.length >= 3) {
    const fileCount = new Set(rootSearch.map((h) => h.file)).size;
    const hot = rootSearch.filter((h) => h.per_frame).length;
    out.push({ id: "script/whole-tree-search", severity: hot > 0 ? "high" : "medium", category: "scripts", title: `The whole tree is searched from the root (${rootSearch.length} places in ${fileCount} scripts${hot ? `, ${hot} on per-frame paths` : ""})`, detail: "find_child and find_children from the root visit every node: tens of milliseconds in a large world. The usual trap is \"look it up again if it is missing\": in a scene where the node does not exist the search repeats for ever. Share one reference (an autoload or a group with one member), and retry a failed search at most once every few seconds.", evidence: [...rootSearch.filter((h) => h.per_frame), ...rootSearch.filter((h) => !h.per_frame)].slice(0, 10), metric: { places: rootSearch.length, files: fileCount, per_frame: hot }, fix: null, risk: "code" });
  }
  if (runtimeTextures.length >= 5) {
    const fileCount = new Set(runtimeTextures.map((h) => h.file)).size;
    out.push({ id: "script/textures-made-at-run-time", severity: "medium", category: "memory", title: `Textures are made from images at run time (${runtimeTextures.length} places in ${fileCount} scripts)`, detail: "ImageTexture.create_from_image uploads the image uncompressed, 4 bytes per pixel and usually without mipmaps; Image.compress is an editor function and does nothing in an exported game. For large or many textures that fills VRAM. Bake them: save the image, compress it once with the editor binary (or import it), and load the compressed file. optimizer_census shows how many megabytes they take in the running game.", evidence: runtimeTextures.slice(0, 10), metric: { places: runtimeTextures.length, files: fileCount }, fix: null, risk: "code" });
  }
  if (meshBuilders >= 3) out.push({ id: "script/mesh-built-on-main-thread", severity: "medium", category: "hitches", title: `${meshBuilders} functions build meshes in loops, with no threads in the script`, detail: "Generating geometry (SurfaceTool, ArrayMesh) on the main thread stalls the frame while the world builds or streams. Build the arrays in a WorkerThreadPool task and only assign the finished mesh on the main thread (call_deferred).", evidence: builders, metric: { functions: meshBuilders }, fix: null, risk: "code" });
  if (processScripts >= 200) out.push({ id: "script/many-process-callbacks", severity: "low", category: "scripts", title: `${processScripts} scripts have per-frame callbacks`, detail: "Every instance of each is called every frame, visible or not. Turn processing off for far or hidden objects (set_process(false) from a VisibleOnScreenNotifier3D, or process_mode on a streamed chunk), or move the loop into one manager that updates many objects.", metric: { scripts: processScripts }, fix: null, risk: "code" });
  return { findings: out, scripts: files.length, processScripts };
}
