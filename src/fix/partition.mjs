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

export function fixPartition(project, tx, { scene, cellSize, loadRadius, farRadius, minChildren = 24, nodes, pixels = 6, far = true } = {}) {
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

  // What each container child is seen from: its visibility range when all its meshes have one, else its size.
  const seenOf = new Map();
  for (const o of flat.objects) {
    if (o.kind !== "mesh" && o.kind !== "multimesh") continue;
    for (const c of containers) {
      if (!o.path.startsWith(c.path + "/")) continue;
      const child = c.path + "/" + o.path.slice(c.path.length + 1).split("/")[0];
      const e = seenOf.get(child) ?? { ranged: true, range: 0 };
      if (o.visEnd > 0) e.range = Math.max(e.range, o.visEnd);
      else e.ranged = false;
      seenOf.set(child, e);
    }
  }
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
      const r = aabbRadius(lb);
      const seen = seenOf.get(ch.path);
      const bySize = distanceForPixels(r, pixels);
      const seenFrom = seen && seen.ranged && seen.range > 0 ? Math.min(bySize, seen.range + r) : bySize;
      const layer = far && seenFrom > nearRadius ? "far" : "near";
      const key = `${cx},${cz},${layer}`;
      if (!cells.has(key)) cells.set(key, { cx, cz, layer, items: [], aabb: null, maxSeen: 0 });
      const e = cells.get(key);
      e.items.push(ch);
      e.aabb = unionAabb(e.aabb, lb);
      e.maxSeen = Math.max(e.maxSeen, seenFrom);
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
    nodes_moved: totalMoved,
    cell_size: cell,
    load_radius: round(nearRadius),
    containers: report,
    chunk_folder: chunkRoot,
    note: "Each container is now a GOStreamer that loads its chunks around the active camera. Code that looked up moved nodes by path must wait for GOStreamer.chunk_loaded or use groups. Tune load_radius, frame_budget_ms and predictive on the streamer nodes.",
  };
}

const round = (v) => Math.round(v * 100) / 100;
export { mulTransform, num };
