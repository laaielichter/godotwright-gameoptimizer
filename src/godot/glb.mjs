// glTF 2.0 reader (.glb and .gltf): what a model costs to draw, without loading it in Godot.
import { readFileSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { imageInfoFromBuffer, imageInfo } from "./image.mjs";
import { xformAabb, unionAabb, mulTransform, IDENTITY } from "./variant.mjs";

function readGlbJson(path) {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(20);
    readSync(fd, head, 0, 20, 0);
    if (head.readUInt32LE(0) !== 0x46546c67) return null;
    const jsonLen = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonLen);
    readSync(fd, json, 0, jsonLen, 20);
    const binStart = 20 + jsonLen + 8;
    return {
      doc: JSON.parse(json.toString("utf8")),
      readBin(offset, length) {
        const fd2 = openSync(path, "r");
        try {
          const b = Buffer.alloc(length);
          readSync(fd2, b, 0, length, binStart + offset);
          return b;
        } finally {
          closeSync(fd2);
        }
      },
    };
  } finally {
    closeSync(fd);
  }
}

function nodeMatrix(n) {
  if (n.matrix) {
    const m = n.matrix; // column-major 4x4
    return [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10], m[12], m[13], m[14]];
  }
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y - z * w) * sy, 2 * (x * z + y * w) * sz,
    2 * (x * y + z * w) * sx, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z - x * w) * sz,
    2 * (x * z - y * w) * sx, 2 * (y * z + x * w) * sy, (1 - 2 * (x * x + y * y)) * sz,
    tx, ty, tz,
  ];
}

const cache = new Map();

/** Summary of a glTF model: meshes, instances with boxes in model space, triangles, surfaces, materials, images. */
export function readModel(path) {
  if (cache.has(path)) return cache.get(path);
  let out = null;
  try {
    out = readModelUncached(path);
  } catch (e) {
    out = { error: String(e.message ?? e), instances: [], meshes: [], triangles: 0, surfaces: 0, materials: 0, images: [], aabb: null };
  }
  cache.set(path, out);
  return out;
}

function readModelUncached(path) {
  let doc;
  let readBin = null;
  if (/\.glb$/i.test(path)) {
    const g = readGlbJson(path);
    if (!g) throw new Error("not a GLB file");
    doc = g.doc;
    readBin = g.readBin;
  } else doc = JSON.parse(readFileSync(path, "utf8"));
  const acc = doc.accessors ?? [];
  const meshes = (doc.meshes ?? []).map((m, index) => {
    let triangles = 0;
    let vertices = 0;
    let aabb = null;
    const materials = [];
    for (const p of m.primitives ?? []) {
      const pos = acc[p.attributes?.POSITION];
      const count = p.indices !== undefined ? (acc[p.indices]?.count ?? 0) : (pos?.count ?? 0);
      const mode = p.mode ?? 4;
      triangles += mode === 4 ? Math.floor(count / 3) : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0;
      vertices += pos?.count ?? 0;
      if (pos?.min && pos?.max) aabb = unionAabb(aabb, [...pos.min, ...pos.max]);
      materials.push(p.material ?? -1);
    }
    return { index, name: m.name ?? `mesh_${index}`, surfaces: (m.primitives ?? []).length, triangles, vertices, aabb, materials, skinned: false };
  });
  const instances = [];
  const nodes = doc.nodes ?? [];
  const sceneDef = (doc.scenes ?? [])[doc.scene ?? 0];
  const visit = (i, parentT, path2) => {
    const n = nodes[i];
    if (!n) return;
    const t = mulTransform(parentT, nodeMatrix(n));
    const name = n.name ?? `node_${i}`;
    const p = path2 ? `${path2}/${name}` : name;
    if (n.mesh !== undefined && meshes[n.mesh]) {
      const m = meshes[n.mesh];
      if (n.skin !== undefined) m.skinned = true;
      instances.push({ node: p, mesh: n.mesh, transform: t, aabb: m.aabb ? xformAabb(t, m.aabb) : null, triangles: m.triangles, surfaces: m.surfaces, materials: m.materials, skinned: n.skin !== undefined });
    }
    for (const c of n.children ?? []) visit(c, t, p);
  };
  for (const r of sceneDef?.nodes ?? []) visit(r, IDENTITY, "");
  const images = (doc.images ?? []).map((im, index) => {
    let info = null;
    try {
      if (im.bufferView !== undefined && readBin) {
        const bv = doc.bufferViews[im.bufferView];
        info = imageInfoFromBuffer(readBin(bv.byteOffset ?? 0, Math.min(bv.byteLength, 1 << 16)));
        if (info) info.bytes = bv.byteLength;
      } else if (im.uri && !im.uri.startsWith("data:")) {
        const f = join(dirname(path), decodeURIComponent(im.uri));
        if (existsSync(f)) info = imageInfo(f);
      }
    } catch {
      /* unreadable image: leave it out */
    }
    return { index, name: im.name ?? im.uri ?? `image_${index}`, embedded: im.bufferView !== undefined, ...(info ?? {}) };
  });
  let aabb = null;
  for (const it of instances) aabb = unionAabb(aabb, it.aabb);
  return {
    meshes,
    instances,
    aabb,
    triangles: instances.reduce((a, b) => a + b.triangles, 0),
    surfaces: instances.reduce((a, b) => a + b.surfaces, 0),
    materials: (doc.materials ?? []).length,
    materialInfo: (doc.materials ?? []).map((m) => ({ name: m.name, alphaMode: m.alphaMode ?? "OPAQUE", doubleSided: !!m.doubleSided })),
    images,
    skins: (doc.skins ?? []).length,
    animations: (doc.animations ?? []).length,
    lights: doc.extensions?.KHR_lights_punctual?.lights?.length ?? 0,
  };
}
