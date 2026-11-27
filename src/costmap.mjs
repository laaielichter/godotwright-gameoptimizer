// The world cost map: what the renderer has to draw from every place in the world, predicted from the files.
// The world is cut into square cells on the XZ plane. Each cell gets what lies in it (content cost) and what a camera
// standing in it would have in range (view cost), honouring visibility ranges. The worst cells are the hotspots: that
// is where the frame rate will be lowest, and where a benchmark route should go.
import { aabbCenter, aabbRadius } from "./godot/variant.mjs";

export function autoCellSize(bounds) {
  if (!bounds) return 64;
  const extent = Math.max(bounds[3] - bounds[0], bounds[5] - bounds[2]);
  const raw = extent / 24;
  let size = 16;
  while (size < raw && size < 512) size *= 2;
  return size;
}

/**
 * @param objects flattened objects (see world.mjs)
 * @param options {cellSize, viewDistance}
 */
export function buildCostMap(objects, { cellSize, viewDistance = 1000, maxCells = 250_000 } = {}) {
  const drawn = objects.filter((o) => (o.kind === "mesh" || o.kind === "multimesh" || o.kind === "csg" || o.kind === "particles") && o.aabb && o.visible !== false);
  const lights = objects.filter((o) => o.kind === "light" && o.type !== "DirectionalLight3D");
  let bounds = null;
  for (const o of drawn) {
    const c = aabbCenter(o.aabb);
    if (!bounds) bounds = [c[0], c[2], c[0], c[2]];
    else {
      bounds[0] = Math.min(bounds[0], c[0]);
      bounds[1] = Math.min(bounds[1], c[2]);
      bounds[2] = Math.max(bounds[2], c[0]);
      bounds[3] = Math.max(bounds[3], c[2]);
    }
  }
  if (!bounds) return { cellSize: cellSize ?? 64, cells: [], hotspots: [], bounds: null, columns: 0, rows: 0, viewDistance };
  let size = cellSize ?? autoCellSize([bounds[0], 0, bounds[1], bounds[2], 0, bounds[3]]);
  let cols;
  let rows;
  for (;;) {
    cols = Math.floor((bounds[2] - bounds[0]) / size) + 1;
    rows = Math.floor((bounds[3] - bounds[1]) / size) + 1;
    if (cols * rows <= maxCells) break;
    size *= 2;
  }
  const ox = bounds[0];
  const oz = bounds[1];
  const N = cols * rows;
  const content = { objects: new Uint32Array(N), triangles: new Float64Array(N), draws: new Uint32Array(N), lights: new Uint32Array(N), shadowLights: new Uint32Array(N), maxY: new Float32Array(N).fill(-Infinity) };
  const view = { triangles: new Float64Array(N), draws: new Float64Array(N), objects: new Float64Array(N) };
  const cellOf = (x, z) => Math.min(cols - 1, Math.max(0, Math.floor((x - ox) / size))) + cols * Math.min(rows - 1, Math.max(0, Math.floor((z - oz) / size)));

  // Objects without a visibility range are seen up to viewDistance. Summing those per cell first and spreading the
  // cell totals keeps this linear in the number of objects.
  const far = { triangles: new Float64Array(N), draws: new Float64Array(N), objects: new Float64Array(N) };
  for (const o of drawn) {
    const c = aabbCenter(o.aabb);
    const i = cellOf(c[0], c[2]);
    const tris = o.triangles ?? 0;
    content.objects[i]++;
    content.triangles[i] += tris;
    content.draws[i] += o.surfaces ?? 1;
    if (o.aabb[4] > content.maxY[i]) content.maxY[i] = o.aabb[4];
    const range = o.visEnd > 0 ? o.visEnd + aabbRadius(o.aabb) : 0;
    if (range > 0 && range < viewDistance) {
      const r = Math.ceil(range / size);
      const cx = Math.floor((c[0] - ox) / size);
      const cz = Math.floor((c[2] - oz) / size);
      for (let dz = -r; dz <= r; dz++) {
        const z = cz + dz;
        if (z < 0 || z >= rows) continue;
        for (let dx = -r; dx <= r; dx++) {
          const x = cx + dx;
          if (x < 0 || x >= cols || dx * dx + dz * dz > r * r) continue;
          const j = x + cols * z;
          view.triangles[j] += tris;
          view.draws[j] += o.surfaces ?? 1;
          view.objects[j]++;
        }
      }
    } else {
      far.triangles[i] += tris;
      far.draws[i] += o.surfaces ?? 1;
      far.objects[i]++;
    }
  }
  for (const l of lights) {
    const i = cellOf(l.transform[9], l.transform[11]);
    content.lights[i]++;
    if (l.shadow) content.shadowLights[i]++;
  }
  // Spread the far totals over the view disk with a summed-area table (a square of the same area as the disk).
  const half = Math.max(0, Math.round((viewDistance * Math.sqrt(Math.PI)) / 2 / size));
  for (const key of ["triangles", "draws", "objects"]) {
    const sat = new Float64Array((cols + 1) * (rows + 1));
    for (let z = 0; z < rows; z++) {
      let run = 0;
      for (let x = 0; x < cols; x++) {
        run += far[key][x + cols * z];
        sat[x + 1 + (cols + 1) * (z + 1)] = sat[x + 1 + (cols + 1) * z] + run;
      }
    }
    for (let z = 0; z < rows; z++) {
      const z0 = Math.max(0, z - half);
      const z1 = Math.min(rows, z + half + 1);
      for (let x = 0; x < cols; x++) {
        const x0 = Math.max(0, x - half);
        const x1 = Math.min(cols, x + half + 1);
        view[key][x + cols * z] += sat[x1 + (cols + 1) * z1] - sat[x0 + (cols + 1) * z1] - sat[x1 + (cols + 1) * z0] + sat[x0 + (cols + 1) * z0];
      }
    }
  }
  // Near load: what is close weighs more (it fills more pixels, uses higher LODs and casts the shadows the camera
  // sees). Each cell's content is spread over its neighbours with a weight that falls off with distance.
  const near = new Float64Array(N);
  const nearRange = Math.min(viewDistance, 400);
  const kr = Math.ceil(nearRange / size);
  const falloff = 120;
  for (let i = 0; i < N; i++) {
    const load = content.triangles[i] + content.draws[i] * 1500 + content.shadowLights[i] * 60000;
    if (load === 0) continue;
    const cx = i % cols;
    const cz = Math.floor(i / cols);
    for (let dz = -kr; dz <= kr; dz++) {
      const z = cz + dz;
      if (z < 0 || z >= rows) continue;
      for (let dx = -kr; dx <= kr; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= cols) continue;
        const d = Math.hypot(dx, dz) * size;
        if (d > nearRange) continue;
        near[x + cols * z] += load / (1 + (d / falloff) * (d / falloff));
      }
    }
  }
  const cells = [];
  for (let i = 0; i < N; i++) {
    if (content.objects[i] === 0 && content.lights[i] === 0) continue;
    const x = i % cols;
    const z = Math.floor(i / cols);
    cells.push({
      x,
      z,
      center: [ox + (x + 0.5) * size, oz + (z + 0.5) * size],
      objects: content.objects[i],
      triangles: Math.round(content.triangles[i]),
      draws: content.draws[i],
      lights: content.lights[i],
      shadowLights: content.shadowLights[i],
      top: Number.isFinite(content.maxY[i]) ? Math.round(content.maxY[i] * 10) / 10 : 0,
      viewTriangles: Math.round(view.triangles[i]),
      viewDraws: Math.round(view.draws[i]),
      viewObjects: Math.round(view.objects[i]),
      load: Math.round(near[i] + (view.draws[i] * 1500 + view.triangles[i]) * 0.1),
    });
  }
  // One draw call costs about what 1500 triangles do. `load` is the near-weighted cost plus a tenth of the far view.
  const score = (c) => c.load;
  const sorted = [...cells].sort((a, b) => score(b) - score(a));
  // Hotspots: the worst cells, kept apart so a route covers the map and not one block four times.
  const hotspots = [];
  const minGap = Math.max(size * 2, viewDistance / 4);
  for (const c of sorted) {
    if (hotspots.length >= 8) break;
    if (hotspots.every((h) => Math.hypot(h.center[0] - c.center[0], h.center[1] - c.center[1]) >= minGap)) hotspots.push(c);
  }
  const totals = { viewTrianglesMax: sorted[0]?.viewTriangles ?? 0, viewDrawsMax: sorted[0]?.viewDraws ?? 0, viewTrianglesMedian: median(cells.map((c) => c.viewTriangles)), viewDrawsMedian: median(cells.map((c) => c.viewDraws)) };
  return { cellSize: size, columns: cols, rows, origin: [ox, oz], viewDistance, cells, hotspots, totals };
}

function median(a) {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** A benchmark route through the hotspots: camera stations at eye height, each looking at the next. */
export function routeFromCostMap(map, { height = 1.8, mode = "stations", speed = 30 } = {}) {
  const pts = map.hotspots.length ? map.hotspots : map.cells.slice(0, 4);
  if (pts.length === 0) return null;
  // Order the stations as a short tour (nearest neighbour), so a fly-through does not zigzag.
  const left = [...pts];
  const tour = [left.shift()];
  while (left.length) {
    const last = tour[tour.length - 1];
    let best = 0;
    for (let i = 1; i < left.length; i++) {
      if (Math.hypot(left[i].center[0] - last.center[0], left[i].center[1] - last.center[1]) < Math.hypot(left[best].center[0] - last.center[0], left[best].center[1] - last.center[1])) best = i;
    }
    tour.push(left.splice(best, 1)[0]);
  }
  const heavy = (c) => {
    // Look toward the heaviest neighbour cell, or along the tour.
    let best = null;
    for (const o of map.cells) {
      const d = Math.hypot(o.center[0] - c.center[0], o.center[1] - c.center[1]);
      if (d < map.cellSize * 0.5 || d > map.cellSize * 3) continue;
      if (!best || o.triangles + o.draws * 1500 > best.triangles + best.draws * 1500) best = o;
    }
    return best;
  };
  const stations = tour.map((c, i) => {
    const y = Math.max(0, c.top) * 0 + height + groundGuess(map, c);
    const target = heavy(c) ?? tour[(i + 1) % tour.length];
    const look = target === c ? [c.center[0] + 10, y, c.center[1]] : [target.center[0], y - height * 0.2, target.center[1]];
    return { pos: [round(c.center[0]), round(y), round(c.center[1])], look_at: look.map(round), cell: [c.x, c.z], view_triangles: c.viewTriangles, view_draws: c.viewDraws };
  });
  return { mode, speed, stations };
}

function groundGuess() {
  return 0;
}
const round = (v) => Math.round(v * 100) / 100;

/** A small text picture of the map: one character per cell, darker is heavier. */
export function renderCostMap(map, key = "load") {
  if (!map.cells.length) return "(empty world)";
  const ramp = " .:-=+*#%@";
  const max = Math.max(...map.cells.map((c) => c[key])) || 1;
  const stepX = Math.max(1, Math.ceil(map.columns / 96));
  const stepZ = Math.max(1, Math.ceil(map.rows / 48));
  const grid = new Map(map.cells.map((c) => [`${c.x},${c.z}`, c]));
  const lines = [];
  for (let z = 0; z < map.rows; z += stepZ) {
    let line = "";
    for (let x = 0; x < map.columns; x += stepX) {
      let v = 0;
      for (let dz = 0; dz < stepZ; dz++) for (let dx = 0; dx < stepX; dx++) v = Math.max(v, grid.get(`${x + dx},${z + dz}`)?.[key] ?? 0);
      line += v === 0 ? " " : ramp[Math.min(ramp.length - 1, 1 + Math.floor((v / max) * (ramp.length - 2)))];
    }
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}
