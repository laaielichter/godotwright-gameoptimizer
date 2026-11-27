// World partition: cuts a world scene into chunk scenes on a grid and puts a GOStreamer where each container was.
// Small things go into detail chunks with a short load radius; things large enough to be seen from far go into far
// chunks with a long one, so the skyline stays while the detail streams.
import { ResourceFile, makeSection } from "../godot/tscn.mjs";
import { aabbRadius, unionAabb, xformAabb, invertTransform, mulTransform, num } from "../godot/variant.mjs";
import { World } from "../world.mjs";
import { autoCellSize } from "../costmap.mjs";
import { distanceForPixels } from "../analyze/world.mjs";

const REF = /\b(ExtResource|SubResource)\("([^"]+)"\)/g;

function refsIn(section) {
  const ext = new Set();
  const sub = new Set();
  const scan = (text) => {
    for (const m of text.matchAll(REF)) (m[1] === "ExtResource" ? ext : sub).add(m[2]);
  };
  scan(section.header());
  for (const p of section.props) scan(p.raw);
  return { ext, sub };
}

/** Containers: plain Node3D nodes of the scene itself with many children. */
function findContainers(file, minChildren, only) {
  const children = new Map();
  const byPath = new Map();
  for (const s of file.nodes) {
    const path = s.attrs.parent === undefined ? "." : ResourceFile.nodePath(s);
    byPath.set(path, s);
    if (s.attrs.parent !== undefined) {
      const parent = String(s.attrs.parent);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push({ path, section: s });
    }
  }
  const out = [];
  for (const [path, list] of children) {
    const s = byPath.get(path);
    if (!s || path === "." || list.length < minChildren) continue;
    if (only && !only.includes(path)) continue;
    if (s.attrs.type !== "Node3D" || s.has("script") || s.attrs.instance) continue;
    out.push({ path, section: s, children: list });
  }
  return { containers: out, children, byPath };
}

export function fixPartition(project, tx, { scene, cellSize, loadRadius, farRadius, minChildren = 24, nodes, pixels = 6, far = true, proxies = true } = {}) {
  if (!project.exists("addons/gameoptimizer/go_streamer.gd") && !tx.writes.has("addons/gameoptimizer/go_streamer.gd")) {
    return { partitioned: 0, error: "The runtime kit is not installed. Run fix `install` first: the chunks are loaded by addons/gameoptimizer/go_streamer.gd." };
  }
  const world = new World(project);
  const flat = world.flatten(scene);
  const text = tx.writes.get(scene) ?? project.text(scene);
  const file = new ResourceFile(text);
  const { containers, children } = findContainers(file, minChildren, nodes);
  if (containers.length === 0) return { partitioned: 0, message: `No container to partition: no plain Node3D with ${minChildren} or more children in ${scene}.` };
  // What refers to nodes by path: those nodes stay.
  const pinned = new Set();
  for (const c of file.connections) for (const k of ["from", "to"]) pinned.add(String(c.attrs[k] ?? ""));
  const nodePaths = [...text.matchAll(/NodePath\("([^"]*)"\)/g)].map((m) => m[1].split(":")[0]);
  const isPinned = (path) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    for (const p of pinned) if (p === path || p.startsWith(path + "/")) return true;
    for (const p of nodePaths) if (p === path || p.endsWith("/" + name) || p === name || p.includes("/" + name + "/")) return true;
    return false;
  };
  // Objects by the node path they belong to.
  const boundsOf = new Map(); // top-scene path of a container child → world box
  const containerSet = new Map(containers.map((c) => [c.path, c]));
  const worldT = new Map();
  for (const o of flat.objects) {
    if (o.depth === 0 && containerSet.has(o.local)) worldT.set(o.local, o.transform);
  }
  for (const o of flat.objects) {
    if (!o.aabb) continue;
    if (o.kind !== "mesh" && o.kind !== "multimesh" && o.kind !== "light" && o.kind !== "particles" && o.kind !== "csg") continue;
    for (const c of containers) {
      if (!o.path.startsWith(c.path + "/")) continue;
      const rest = o.path.slice(c.path.length + 1);
      const child = c.path + "/" + rest.split("/")[0];
      boundsOf.set(child, unionAabb(boundsOf.get(child), o.aabb));
    }
  }
  let all = null;
  for (const b of boundsOf.values()) all = unionAabb(all, b);
  const cell = cellSize ?? autoCellSize(all);
  const nearRadius = loadRadius ?? cell * 2.5;
  const streamerScript = "res://addons/gameoptimizer/go_streamer.gd";
  const sceneDir = scene.includes("/") ? scene.slice(0, scene.lastIndexOf("/")) : "";
  const base = scene.slice(scene.lastIndexOf("/") + 1).replace(/\.tscn$/, "");
  const chunkRoot = `${sceneDir ? sceneDir + "/" : ""}${base}_chunks`;
  const removeSections = new Set();
  const report = [];
  const sharedWritten = new Map(); // sub id → res path of the extracted .tres
  let totalChunks = 0;
  let totalMoved = 0;

  // A sub-resource that more than one chunk uses becomes a file of its own, so the chunks share one copy (and the
  // renderer can still batch across chunks). One that a single chunk uses is written into that chunk.
  const useCount = new Map();
  const closure = (ids) => {
    const out = new Set();
    const visit = (id) => {
      if (out.has(id)) return;
      const sub = file.sub.get(id);
      if (!sub) return;
      out.add(id);
      for (const d of refsIn(sub).sub) visit(d);
    };
    for (const id of ids) visit(id);
    return out;
  };
  const isShared = (id) => (useCount.get(id) ?? 0) > 1;
  const subOrder = new Map([...file.sub.keys()].map((id, i) => [id, i]));
  const extractShared = (id) => {
    if (sharedWritten.has(id)) return sharedWritten.get(id);
    const sub = file.sub.get(id);
    const path = `${chunkRoot}/shared/${id.replace(/[^A-Za-z0-9_]/g, "_")}.tres`;
    sharedWritten.set(id, path);
    const deps = [...closure(refsIn(sub).sub)].sort((x, y) => subOrder.get(x) - subOrder.get(y));
    const extLines = [];
    const exts = new Set(refsIn(sub).ext);
    const swapId = new Map();
    const inline = [];
    for (const d of deps) {
      if (isShared(d)) {
        const nid = `sh_${swapId.size + 1}`;
        swapId.set(d, nid);
        extLines.push(`[ext_resource type="${file.sub.get(d).attrs.type}" path="res://${extractShared(d)}" id="${nid}"]`);
      } else {
        inline.push(file.sub.get(d));
        for (const e of refsIn(file.sub.get(d)).ext) exts.add(e);
      }
    }
    for (const e of exts) if (file.ext.get(e)) extLines.push(file.ext.get(e).header());
    const swap = (t) => t.replace(/SubResource\("([^"]+)"\)/g, (m, sid) => (swapId.has(sid) ? `ExtResource("${swapId.get(sid)}")` : m));
    const lines = [`[gd_resource type="${sub.attrs.type}" load_steps=${inline.length + extLines.length + 1} format=3]`, ""];
    if (extLines.length) lines.push(...extLines, "");
    for (const x of inline) lines.push(x.header(), ...x.props.map((p) => swap(`${p.key} = ${p.raw}`)), "");
    lines.push("[resource]", ...sub.props.map((p) => swap(`${p.key} = ${p.raw}`)), "");
    tx.write(path, lines.join("\n"));
    return path;
  };
  const plans = []; // per container: cells with their sections, built first so use counts are known
  // A resource of another scene file (a mesh inside house.tscn) is copied to the shared folder for the stand-ins.
  const foreign = new Map();
  const foreignFiles = new Map();
  const extractForeign = (scenePath, id) => {
    const key = `${scenePath}::${id}`;
    if (foreign.has(key)) return foreign.get(key);
    if (!foreignFiles.has(scenePath)) foreignFiles.set(scenePath, world.scene(scenePath)?.file ?? null);
    const f = foreignFiles.get(scenePath);
    const sub = f?.sub.get(id);
    if (!sub) return null;
    const out = { path: `${chunkRoot}/shared/${scenePath.slice(scenePath.lastIndexOf("/") + 1).replace(/\.tscn$/, "")}__${id.replace(/[^A-Za-z0-9_]/g, "_")}.tres`, type: String(sub.attrs.type) };
    foreign.set(key, out);
    const deps = [];
    const seen = new Set([id]);
    const exts = new Set(refsIn(sub).ext);
    const visit = (x) => {
      for (const d of refsIn(x).sub) {
        if (seen.has(d) || !f.sub.get(d)) continue;
        seen.add(d);
        visit(f.sub.get(d));
        deps.push(f.sub.get(d));
        for (const e of refsIn(f.sub.get(d)).ext) exts.add(e);
      }
    };
    visit(sub);
    const lines = [`[gd_resource type="${sub.attrs.type}" load_steps=${deps.length + exts.size + 1} format=3]`, ""];
    for (const e of exts) if (f.ext.get(e)) lines.push(f.ext.get(e).header());
    if (exts.size) lines.push("");
    for (const x of deps) lines.push(x.header(), ...x.props.map((p) => `${p.key} = ${p.raw}`), "");
    lines.push("[resource]", ...sub.props.map((p) => `${p.key} = ${p.raw}`), "");
    tx.write(out.path, lines.join("\n"));
    return out;
  };
  const proxyRefs = new Set(); // sub-resource ids of the world scene that stand-ins use: always shared
  /** Where a stand-in finds a mesh or material: {path, type}, or null when it cannot be referenced from outside. */
  const resourceRef = (key, fallbackType) => {
    if (!key) return null;
    const at = key.indexOf("::");
    if (at < 0) return key.includes("#") ? null : { path: key, type: fallbackType };
    const scenePath = key.slice(0, at);
    const id = key.slice(at + 2);
    if (scenePath === scene) {
      if (!file.sub.get(id)) return null;
      proxyRefs.add(id);
      return { world: id, type: String(file.sub.get(id).attrs.type) };
    }
    return extractForeign(scenePath, id);
  };

  // The drawn objects of every container child.
  const drawnOf = new Map();
  const lightReach = new Map();
  for (const o of flat.objects) {
    if (o.kind !== "mesh" && o.kind !== "multimesh" && o.kind !== "light") continue;
    for (const c of containers) {
      if (!o.path.startsWith(c.path + "/")) continue;
      const child = c.path + "/" + o.path.slice(c.path.length + 1).split("/")[0];
      if (o.kind === "light") {
        // A light is seen as far as it shines: to the end of its distance fade, or for ever without one.
        const reach = o.distanceFade ? o.fadeEnd : 4000;
        lightReach.set(child, Math.max(lightReach.get(child) ?? 0, reach));
        continue;
      }
      if (!drawnOf.has(child)) drawnOf.set(child, []);
      drawnOf.get(child).push(o);
    }
  }
  /** From how far an object is seen: where it is smaller than `pixels`, or its visibility range if that is nearer. */
  const seenFromOf = (o) => {
    const r = o.aabb ? aabbRadius(o.aabb) : 0;
    const bySize = distanceForPixels(r, pixels);
    return o.visEnd > 0 ? Math.min(bySize, o.visEnd + r) : bySize;
  };
  // Pass 1: assign every movable child to a cell and a layer.
  for (const c of containers) {
    const inv = invertTransform(worldT.get(c.path) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    const cells = new Map();
    let moved = 0;
    let kept = 0;
    for (const ch of c.children) {
      const s = ch.section;
      const wb = boundsOf.get(ch.path);
      if (!wb || isPinned(ch.path) || containerSet.has(ch.path) || s.attrs.owner !== undefined || (!s.attrs.type && !s.attrs.instance)) {
        kept++;
        continue;
      }
      const lb = xformAabb(inv, wb);
      const cx = Math.floor((lb[0] + lb[3]) / 2 / cell);
      const cz = Math.floor((lb[2] + lb[5]) / 2 / cell);
      const drawn = drawnOf.get(ch.path) ?? [];
      const lit = lightReach.get(ch.path) ?? 0;
      const seenFrom = Math.max(lit, ...drawn.map(seenFromOf));
      // What of this child is still seen beyond the load radius. If all of that can be drawn by a stand-in (plain
      // meshes with a mesh and material that can be referenced), the child streams with the detail and the
      // stand-in shows its large parts while it is not loaded. Otherwise it goes to a far chunk as it is.
      const farParts = drawn.filter((o) => seenFromOf(o) > nearRadius);
      let standIn = null;
      // A stand-in has no lights: a child whose light still shines beyond the load radius stays a real far chunk.
      if (proxies && far && farParts.length > 0 && lit <= nearRadius) {
        standIn = [];
        for (const o of farParts) {
          const mesh = o.kind === "mesh" && !o.skinned && !o.modelPath ? resourceRef(o.meshKey, "Mesh") : null;
          const material = o.materialKey && mesh ? resourceRef(o.materialKey, "Material") : null;
          // A material that comes from the mesh itself needs no override.
          const meshOwnsMaterial = o.materialKey && o.primitive && !s.has("material_override");
          if (!mesh || (o.materialKey && !material && !meshOwnsMaterial)) {
            standIn = null;
            break;
          }
          standIn.push({ o, mesh, material: meshOwnsMaterial ? null : material });
        }
      }
      const layer = far && seenFrom > nearRadius && !standIn ? "far" : "near";
      const key = `${cx},${cz},${layer}`;
      if (!cells.has(key)) cells.set(key, { cx, cz, layer, items: [], aabb: null, maxSeen: 0, standIns: new Map(), standInSeen: 0 });
      const e = cells.get(key);
      e.items.push(ch);
      e.aabb = unionAabb(e.aabb, lb);
      e.maxSeen = Math.max(e.maxSeen, seenFrom);
      for (const part of standIn ?? []) {
        const gk = `${JSON.stringify(part.mesh)}|${JSON.stringify(part.material)}|${part.o.castShadow ? 1 : 0}`;
        if (!e.standIns.has(gk)) e.standIns.set(gk, { mesh: part.mesh, material: part.material, castShadow: part.o.castShadow, items: [], seen: 0, radius: 0 });
        const g = e.standIns.get(gk);
        g.items.push(mulTransform(inv, part.o.transform));
        g.seen = Math.max(g.seen, seenFromOf(part.o));
        e.standInSeen = Math.max(e.standInSeen, seenFromOf(part.o));
      }
      moved++;
    }
    if (moved < minChildren) continue;
    for (const e of cells.values()) {
      e.nodes = [];
      e.ext = new Set();
      const direct = new Set();
      for (const ch of e.items) {
        const stack = [ch];
        while (stack.length) {
          const n = stack.shift();
          e.nodes.push(n);
          const r = refsIn(n.section);
          for (const x of r.ext) e.ext.add(x);
          for (const x of r.sub) direct.add(x);
          stack.unshift(...(children.get(n.path) ?? []));
        }
      }
      e.subs = closure(direct);
      for (const id of e.subs) useCount.set(id, (useCount.get(id) ?? 0) + 1);
    }
    plans.push({ c, cells, moved, kept });
  }
  for (const id of closure(proxyRefs)) useCount.set(id, (useCount.get(id) ?? 0) + 2);
  let standInScenes = 0;
  // Pass 2: write the chunk scenes and the manifests.
  for (const { c, cells, moved, kept } of plans) {
    const safe = c.path.replace(/[^A-Za-z0-9_]/g, "_");
    const chunks = [];
    const prefix = c.path + "/";
    for (const e of cells.values()) {
      const id = `c_${e.cx}_${e.cz}${e.layer === "far" ? "_far" : ""}`.replace(/-/g, "m");
      const path = `${chunkRoot}/${safe}/${id}.tscn`;
      const extLines = [];
      const swapId = new Map();
      const inline = [];
      const exts = new Set(e.ext);
      for (const sid of [...e.subs].sort((x, y) => subOrder.get(x) - subOrder.get(y))) {
        if (isShared(sid)) {
          const nid = `sh_${swapId.size + 1}`;
          swapId.set(sid, nid);
          extLines.push(`[ext_resource type="${file.sub.get(sid).attrs.type}" path="res://${extractShared(sid)}" id="${nid}"]`);
        } else {
          inline.push(file.sub.get(sid));
          for (const x of refsIn(file.sub.get(sid)).ext) exts.add(x);
        }
      }
      // A shared resource's own dependencies live in its file, not here.
      const inlineIds = new Set(inline.map((x) => String(x.attrs.id)));
      for (const x of exts) if (file.ext.get(x)) extLines.push(file.ext.get(x).header());
      const swap = (t) => t.replace(/SubResource\("([^"]+)"\)/g, (m, sid) => (swapId.has(sid) ? `ExtResource("${swapId.get(sid)}")` : m));
      const lines = [`[gd_scene load_steps=${extLines.length + inline.length + 1} format=3]`, ""];
      if (extLines.length) lines.push(...extLines, "");
      for (const x of inline) {
        // Only keep an inlined dependency if something in this chunk still points at it.
        if (!inlineIds.has(String(x.attrs.id))) continue;
        lines.push(x.header(), ...x.props.map((p) => swap(`${p.key} = ${p.raw}`)), "");
      }
      lines.push(`[node name="${id}" type="Node3D"]`, "");
      for (const n of e.nodes) {
        const s = n.section;
        removeSections.add(s);
        const parent = String(s.attrs.parent);
        const newParent = parent === c.path ? "." : parent.slice(prefix.length);
        lines.push(swap(s.header().replace(/ parent="[^"]*"/, ` parent="${newParent}"`)));
        if (s.props.length) lines.push(swap(s.props.map((p) => `${p.key} = ${p.raw}`).join("\n")));
        lines.push("");
      }
      tx.write(path, lines.join("\n"));
      const entry = { id: `${safe}/${id}`, scene: `res://${path}`, center: [(e.aabb[0] + e.aabb[3]) / 2, (e.aabb[1] + e.aabb[4]) / 2, (e.aabb[2] + e.aabb[5]) / 2].map(round), aabb: e.aabb.map(round), cost: e.nodes.length };
      if (e.layer === "far") {
        const fr = farRadius ?? Math.min(4000, Math.max(nearRadius * 1.5, Math.round(e.maxSeen)));
        entry.load_radius = round(fr);
        entry.unload_radius = round(fr + cell * 0.75);
        entry.layer = "far";
      }
      if (e.standIns.size) {
        // The stand-in: one MultiMesh per mesh and material, nothing else. Shown while the chunk is not loaded.
        const ext = new Map(); // res path → id
        const extLines2 = [];
        const refOf = (r) => {
          const path = r.world ? extractShared(r.world) : r.path;
          if (!ext.has(path)) {
            ext.set(path, `r_${ext.size + 1}`);
            extLines2.push(`[ext_resource type="${r.type}" path="res://${path}" id="${ext.get(path)}"]`);
          }
          return `ExtResource("${ext.get(path)}")`;
        };
        const subs = [];
        const nodes2 = [];
        let k = 0;
        for (const g of e.standIns.values()) {
          k++;
          const o0 = g.items[0];
          const origin = [o0[9], o0[10], o0[11]];
          const buf = [];
          let reach = 0;
          for (const t of g.items) {
            buf.push(t[0], t[1], t[2], t[9] - origin[0], t[3], t[4], t[5], t[10] - origin[1], t[6], t[7], t[8], t[11] - origin[2]);
            reach = Math.max(reach, Math.hypot(t[9] - origin[0], t[11] - origin[2]));
          }
          subs.push(`[sub_resource type="MultiMesh" id="mm_${k}"]`, "transform_format = 1", `instance_count = ${g.items.length}`, `mesh = ${refOf(g.mesh)}`, `buffer = PackedFloat32Array(${buf.map(num).join(", ")})`, "");
          nodes2.push(`[node name="StandIn${k}" type="MultiMeshInstance3D" parent="."]`, `transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, ${origin.map(num).join(", ")})`, `multimesh = SubResource("mm_${k}")`);
          if (g.material) nodes2.push(`material_override = ${refOf(g.material)}`);
          if (!g.castShadow) nodes2.push("cast_shadow = 0");
          if (g.seen < 3600) nodes2.push(`visibility_range_end = ${num(Math.round(g.seen + reach))}`, `visibility_range_end_margin = ${num(Math.max(2, Math.round(g.seen * 0.08)))}`);
          nodes2.push("");
        }
        const proxyPath = `${chunkRoot}/${safe}/${id}_standin.tscn`;
        tx.write(proxyPath, [`[gd_scene load_steps=${extLines2.length + k + 1} format=3]`, "", ...extLines2, "", ...subs, `[node name="${id}_standin" type="Node3D"]`, "", ...nodes2].join("\n"));
        entry.lod_scene = `res://${proxyPath}`;
        entry.lod_radius = round(Math.min(4000, e.standInSeen + cell));
        standInScenes++;
      }
      chunks.push(entry);
    }
    const manifestPath = `${chunkRoot}/${safe}.gostream.json`;
    tx.write(manifestPath, JSON.stringify({ version: 1, cell_size: cell, load_radius: round(nearRadius), unload_radius: round(nearRadius + cell * 0.75), source_scene: `res://${scene}`, container: c.path, chunks }, null, 1) + "\n");
    // The container becomes the streamer, in place: same name, same transform, same remaining children.
    let extId = [...file.ext.entries()].find(([, s]) => s.attrs.path === streamerScript)?.[0];
    if (!extId) {
      extId = file.newExtId("go");
      file.addResourceSection(makeSection("ext_resource", { type: "Script", path: streamerScript, id: extId }));
    }
    c.section.set("script", `ExtResource("${extId}")`);
    c.section.set("manifest_path", `"res://${manifestPath}"`);
    totalChunks += chunks.length;
    totalMoved += moved;
    report.push({ container: c.path, moved, kept, chunks: chunks.length, far_chunks: chunks.filter((x) => x.layer === "far").length, far_radius_max: Math.max(0, ...chunks.map((x) => x.load_radius ?? 0)), manifest: manifestPath });
  }
  if (totalMoved === 0) return { partitioned: 0, message: "Nothing could be moved: the container children are referenced by connections or NodePaths." };
  // Drop the moved nodes, then resources nothing refers to any more.
  file.sections = file.sections.filter((s) => !removeSections.has(s));
  for (let pass = 0; pass < 6; pass++) {
    const used = { ext: new Set(), sub: new Set() };
    for (const s of file.sections) {
      const r = refsIn(s);
      for (const x of r.ext) used.ext.add(x);
      for (const x of r.sub) used.sub.add(x);
    }
    const before = file.sections.length;
    file.sections = file.sections.filter((s) => !((s.tag === "ext_resource" && !used.ext.has(String(s.attrs.id))) || (s.tag === "sub_resource" && !used.sub.has(String(s.attrs.id)))));
    if (file.sections.length === before) break;
  }
  file.reindex();
  file.bumpLoadSteps();
  tx.write(scene, file.toString());
  return {
    partitioned: report.length,
    chunks: totalChunks,
    stand_ins: standInScenes,
    nodes_moved: totalMoved,
    cell_size: cell,
    load_radius: round(nearRadius),
    containers: report,
    chunk_folder: chunkRoot,
    note: "Each container is now a GOStreamer that loads its chunks around the active camera. While a chunk is not loaded, its stand-in draws the parts that are large enough to be seen from there (meshes only: no physics, lights or scripts). Code that looked up moved nodes by path must wait for GOStreamer.chunk_loaded or use groups. Tune load_radius, frame_budget_ms and predictive on the streamer nodes.",
  };
}

const round = (v) => Math.round(v * 100) / 100;
export { mulTransform, num };
