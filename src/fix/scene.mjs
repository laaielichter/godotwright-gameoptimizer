// Fixes that rewrite scenes: light distance fade, visibility ranges, shadow casters and instancing.
import { ResourceFile, makeSection } from "../godot/tscn.mjs";
import { num, aabbRadius, toTransform, writeTransform } from "../godot/variant.mjs";
import { distanceForPixels, instancingGroups } from "../analyze/world.mjs";
import { World } from "../world.mjs";
import { autoCellSize, validateCellSize } from "../costmap.mjs";

/** Opens scene files for editing once each and writes the changed ones into the transaction. */
class SceneEdits {
  constructor(project, tx) {
    this.project = project;
    this.tx = tx;
    this.files = new Map();
  }
  open(path) {
    if (!this.files.has(path)) {
      const text = this.tx.writes.get(path) ?? this.project.text(path);
      const file = new ResourceFile(text);
      const byPath = new Map();
      for (const s of file.nodes) byPath.set(s.attrs.parent === undefined ? "." : ResourceFile.nodePath(s), s);
      this.files.set(path, { file, byPath, dirty: false });
    }
    return this.files.get(path);
  }
  node(scene, local) {
    return this.open(scene).byPath.get(local) ?? null;
  }
  touch(scene) {
    this.open(scene).dirty = true;
  }
  flush() {
    for (const [path, f] of this.files) if (f.dirty) this.tx.write(path, f.file.toString());
  }
}

function flatOf(project, scene) {
  const world = new World(project);
  return { world, flat: world.flatten(scene) };
}

export function fixLights(project, tx, { scene, paraboloid = false, fadeFactor = 8 } = {}) {
  const { flat } = flatOf(project, scene);
  const edits = new SceneEdits(project, tx);
  const seen = new Set();
  let faded = 0;
  let modes = 0;
  for (const o of flat.objects) {
    if (o.kind !== "light" || o.type === "DirectionalLight3D") continue;
    const key = `${o.scene}|${o.local}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const s = edits.node(o.scene, o.local);
    if (!s) continue;
    if (!o.distanceFade) {
      // The shadow goes first: beyond a few times the light's range its detail is a handful of pixels, and the
      // shadow map is what costs (six scene passes for a cube). The light itself stays on much longer, because
      // a lit patch is seen from far at night.
      const shadowEnd = Math.max(40, Math.round(o.range * fadeFactor));
      const begin = Math.min(1500, Math.max(120, Math.round(o.range * fadeFactor * 4)));
      s.set("distance_fade_enabled", "true");
      s.set("distance_fade_begin", num(begin));
      s.set("distance_fade_shadow", num(shadowEnd));
      s.set("distance_fade_length", num(Math.max(10, Math.round(begin * 0.2))));
      edits.touch(o.scene);
      faded++;
    }
    if (paraboloid && o.type === "OmniLight3D" && o.shadow && o.shadowMode === 1 && o.range <= 25) {
      s.set("omni_shadow_mode", "0");
      edits.touch(o.scene);
      modes++;
    }
  }
  edits.flush();
  return { lights_faded: faded, omni_dual_paraboloid: modes };
}

export function fixRanges(project, tx, { scene, pixels = 6, shadows = true, maxRange, fade = false, minRange = 30 } = {}) {
  const { flat } = flatOf(project, scene);
  const edits = new SceneEdits(project, tx);
  const cams = flat.objects.filter((o) => o.kind === "camera");
  const far = maxRange ?? (cams.length ? Math.max(...cams.map((c) => c.far)) : 4000) * 0.9;
  // One node section can be many objects (a scene placed many times): size the range for the largest of them.
  const radius = new Map();
  for (const o of flat.objects) {
    if (o.kind !== "mesh" || !o.aabb || o.modelPath || o.skinned) continue;
    const key = `${o.scene}|${o.local}`;
    const r = aabbRadius(o.aabb);
    const e = radius.get(key);
    if (!e) radius.set(key, { o, r, hasRange: o.visEnd > 0 });
    else if (r > e.r) e.r = r;
  }
  let ranged = 0;
  let unshadowed = 0;
  const sample = [];
  for (const { o, r, hasRange } of radius.values()) {
    if (r <= 0) continue;
    const s = edits.node(o.scene, o.local);
    if (!s) continue;
    if (!hasRange) {
      const d = Math.max(minRange, Math.round(distanceForPixels(r, pixels)));
      if (d < far) {
        s.set("visibility_range_end", num(d));
        s.set("visibility_range_end_margin", num(Math.max(2, Math.round(d * 0.08))));
        if (fade) s.set("visibility_range_fade_mode", "1");
        edits.touch(o.scene);
        ranged++;
        if (sample.length < 8) sample.push({ node: o.path, radius_m: Math.round(r * 100) / 100, range_m: d });
      }
    }
    if (shadows && o.castShadow && r < 0.35) {
      s.set("cast_shadow", "0");
      edits.touch(o.scene);
      unshadowed++;
    }
  }
  edits.flush();
  return { ranges_set: ranged, shadows_off: unshadowed, pixels, sample };
}

const INSTANCING_PROPS = new Set(["transform", "mesh", "cast_shadow", "gi_mode", "material_override", "surface_material_override/0", "visibility_range_end", "visibility_range_end_margin", "visibility_range_fade_mode", "layers", "lod_bias"]);

/**
 * Replaces groups of identical MeshInstance3D siblings by one MultiMeshInstance3D per world cell. Nodes with a
 * script, children, groups, a connection or a NodePath pointing at them are left alone.
 */
export function fixInstancing(project, tx, { scene, cellSize, minCount = 12, minPerCell = 4, pixels = 6 } = {}) {
  validateCellSize(cellSize);
  const { flat } = flatOf(project, scene);
  const text = tx.writes.get(scene) ?? project.text(scene);
  const file = new ResourceFile(text);
  const byPath = new Map();
  const childCount = new Map();
  for (const s of file.nodes) {
    const p = s.attrs.parent === undefined ? "." : ResourceFile.nodePath(s);
    byPath.set(p, s);
    if (s.attrs.parent !== undefined) childCount.set(String(s.attrs.parent), (childCount.get(String(s.attrs.parent)) ?? 0) + 1);
  }
  // Names that something refers to: connections and NodePaths anywhere in the file.
  const referenced = new Set();
  for (const c of file.connections) for (const k of ["from", "to"]) for (const seg of String(c.attrs[k] ?? "").split("/")) referenced.add(seg);
  for (const m of text.matchAll(/NodePath\("([^"]*)"\)/g)) for (const seg of m[1].split(/[/:]/)) referenced.add(seg);
  let bounds = null;
  for (const o of flat.objects) if (o.kind === "mesh" && o.aabb) bounds = bounds ? [Math.min(bounds[0], o.aabb[0]), 0, Math.min(bounds[2], o.aabb[2]), Math.max(bounds[3], o.aabb[3]), 0, Math.max(bounds[5], o.aabb[5])] : [o.aabb[0], 0, o.aabb[2], o.aabb[3], 0, o.aabb[5]];
  // Forward+ already batches identical meshes into a few draw calls, and every MultiMesh is a draw of its own:
  // cells must be large enough that merging does not multiply draw calls.
  const cell = cellSize ?? Math.max(64, autoCellSize(bounds));
  const groups = instancingGroups(flat, { minCount });
  const usedNames = new Set(byPath.keys());
  const remove = new Set();
  const added = [];
  let merged = 0;
  let nodesMade = 0;
  const report = [];
  for (const g of groups) {
    // Split by parent: instance transforms are local to the parent.
    const byParent = new Map();
    for (const o of g.items) {
      const s = byPath.get(o.local);
      if (!s || s.attrs.groups || s.attrs.instance || childCount.get(o.local) || referenced.has(String(s.attrs.name))) continue;
      if (s.attrs.owner !== undefined || s.attrs.index !== undefined) continue;
      if (!s.props.every((p) => INSTANCING_PROPS.has(p.key))) continue;
      const parent = String(s.attrs.parent);
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push({ o, s });
    }
    for (const [parent, items] of byParent) {
      if (items.length < minCount) continue;
      // Bin by cell; what is too sparse for a cell is binned again at twice and four times the size.
      for (const it of items) it.t = toTransform(it.s.get("transform"));
      const cells = new Map();
      let left = items;
      for (const scale of [1, 2, 4]) {
        const size = cell * scale;
        const bins = new Map();
        for (const it of left) {
          const key = `${Math.floor(it.t[9] / size)},${Math.floor(it.t[11] / size)},${scale}`;
          if (!bins.has(key)) bins.set(key, []);
          bins.get(key).push(it);
        }
        left = [];
        for (const [key, list] of bins) {
          if (list.length >= minPerCell) cells.set(key, list);
          else left.push(...list);
        }
      }
      const first = items[0].s;
      const meshRaw = first.rawOf("mesh");
      const meshName = (/"([^"]+)"/.exec(meshRaw)?.[1] ?? "mesh").replace(/[^A-Za-z0-9_]/g, "_");
      let groupMerged = 0;
      for (const [key, list] of cells) {
        const [cx, cz, scale] = key.split(",").map(Number);
        const size = cell * scale;
        const ox = (cx + 0.5) * size;
        const oz = (cz + 0.5) * size;
        let oy = 0;
        for (const it of list) oy += it.t[10];
        oy = Math.round((oy / list.length) * 100) / 100;
        const buf = [];
        let maxR = 0;
        for (const it of list) {
          const t = it.t;
          buf.push(t[0], t[1], t[2], t[9] - ox, t[3], t[4], t[5], t[10] - oy, t[6], t[7], t[8], t[11] - oz);
          if (it.o.aabb) maxR = Math.max(maxR, aabbRadius(it.o.aabb));
          remove.add(it.s);
        }
        const id = file.newSubId("MultiMesh");
        const sub = makeSection("sub_resource", { type: "MultiMesh", id }, { transform_format: "1", instance_count: String(list.length), mesh: meshRaw, buffer: `PackedFloat32Array(${buf.map(num).join(", ")})` });
        file.sub.set(id, sub);
        added.push(sub);
        const props = { transform: writeTransform([1, 0, 0, 0, 1, 0, 0, 0, 1, ox, oy, oz]), multimesh: `SubResource("${id}")` };
        for (const k of ["cast_shadow", "gi_mode", "material_override", "layers"]) if (first.has(k)) props[k] = first.rawOf(k);
        if (first.has("surface_material_override/0")) props.material_override = first.rawOf("surface_material_override/0");
        // The cell is culled as one box: its range is the range of its largest instance plus the cell's half diagonal.
        const existing = Math.max(...list.map((it) => it.o.visEnd || 0));
        const allRanged = list.every((it) => it.o.visEnd > 0);
        const range = allRanged ? existing : maxR > 0 ? Math.round(distanceForPixels(maxR, pixels)) : 0;
        if (range > 0 && range < 3600) {
          props.visibility_range_end = num(Math.round(range + size * 0.71));
          props.visibility_range_end_margin = num(Math.max(2, Math.round(range * 0.08)));
        }
        // Sibling names must be unique: two groups can share a mesh (one casts shadows, one does not).
        let name = `MM_${meshName}_${cx}_${cz}${scale > 1 ? `_x${scale}` : ""}`.replace(/-/g, "m");
        for (let k = 2; usedNames.has(`${parent}/${name}`); k++) name = name.replace(/(_v\d+)?$/, `_v${k}`);
        usedNames.add(`${parent}/${name}`);
        const node = makeSection("node", { name, type: "MultiMeshInstance3D", parent }, props);
        node.after = list[0].s;
        added.push(node);
        nodesMade++;
        groupMerged += list.length;
      }
      merged += groupMerged;
      if (groupMerged) report.push({ mesh: g.meshKey, parent, merged: groupMerged, multimeshes: cells.size });
    }
  }
  if (merged === 0) return { merged: 0, multimeshes: 0, cell_size: cell };
  // Rebuild the section list: resources before the first node, each MultiMesh node where its first member was.
  const out = [];
  const nodeAt = new Map();
  for (const a of added) if (a.tag === "node") nodeAt.set(a.after, [...(nodeAt.get(a.after) ?? []), a]);
  let subsDone = false;
  for (const s of file.sections) {
    if (!subsDone && (s.tag === "node" || s.tag === "connection")) {
      for (const a of added) if (a.tag === "sub_resource") out.push(a);
      subsDone = true;
    }
    if (nodeAt.has(s)) out.push(...nodeAt.get(s));
    if (!remove.has(s)) out.push(s);
  }
  file.sections = out;
  file.reindex();
  file.bumpLoadSteps();
  tx.write(scene, file.toString());
  return { merged, multimeshes: nodesMade, nodes_removed: merged, nodes_added: nodesMade, cell_size: cell, groups: report.slice(0, 12), note: "Merged nodes no longer exist by name. Nodes with a script, a group, children, a connection or a NodePath to them were left as they were." };
}
