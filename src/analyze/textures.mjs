// Texture rules: GPU memory per texture, compression, mipmaps and sizes, from the image headers and .import files.
import { imageInfo, vramBytes } from "../godot/image.mjs";
import { readModel } from "../godot/glb.mjs";

const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp", ".tga", ".bmp", ".dds", ".ktx2", ".exr", ".hdr"];
const mb = (b) => Math.round((b / 1048576) * 10) / 10;

/** Which textures are used by 3D content: by a material resource, a model next to them, or a scene's material. */
function texturesUsedIn3D(project) {
  const used = new Set();
  const re = /path="(res:\/\/[^"]+\.(?:png|jpe?g|webp|tga|bmp|exr|hdr|dds|ktx2))"/gi;
  for (const f of project.ext(".tscn", ".tres")) {
    const t = project.text(f);
    // A file counts when it holds 3D materials, sky, decals or 3D nodes; pure UI and 2D scenes do not.
    if (!t || !/(Material3D|ShaderMaterial|PanoramaSkyMaterial|Decal|Sprite3D|MeshInstance3D|GPUParticles3D|Light3D|Terrain)/.test(t)) continue;
    if (/^shader_type canvas_item/m.test(t)) continue;
    for (const m of t.matchAll(re)) used.add(project.rel(m[1]));
  }
  for (const f of project.ext(".gltf")) {
    const model = readModel(project.abs(f));
    const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : "";
    for (const im of model.images) if (!im.embedded && im.name) used.add(dir + decodeURIComponent(im.name));
  }
  return used;
}

export function textureInventory(project) {
  const used3d = texturesUsedIn3D(project);
  const list = [];
  for (const f of project.ext(...IMAGE_EXT)) {
    const info = imageInfo(project.abs(f));
    if (!info || !info.width) continue;
    const imp = project.importOf(f);
    const importer = imp?.importer ?? null;
    if (importer && importer !== "texture" && !/texture|image|cubemap|3d|layered/.test(String(importer))) continue;
    const mode = imp ? imp.param("compress/mode") : undefined;
    const compressed = info.compressed === true || mode === 2 || mode === 4;
    const mipmaps = imp ? imp.param("mipmaps/generate") === true : false;
    const detect = imp ? imp.param("detect_3d/compress_to") : undefined;
    const in3d = used3d.has(f);
    const hdr = info.format === "exr" || info.format === "hdr";
    list.push({ path: f, width: info.width, height: info.height, alpha: info.alpha, bytes: info.bytes, imported: !!imp, importer, mode, compressed, mipmaps, detect3d: detect, in3d, vram: vramBytes(info, { compressed, mipmaps, hdr }), vramIfFixed: in3d ? vramBytes(info, { compressed: true, mipmaps: true, hdr }) : null });
  }
  return list;
}

export function analyzeTextures(project) {
  const out = [];
  const list = textureInventory(project);
  if (list.length === 0) return { findings: out, inventory: list, vramBytes: 0 };
  const total = list.reduce((a, t) => a + t.vram, 0);
  const uncompressed3d = list.filter((t) => t.in3d && !t.compressed && t.width * t.height >= 128 * 128);
  if (uncompressed3d.length) {
    const now = uncompressed3d.reduce((a, t) => a + t.vram, 0);
    const then = uncompressed3d.reduce((a, t) => a + t.vramIfFixed, 0);
    uncompressed3d.sort((a, b) => b.vram - a.vram);
    out.push({
      id: "textures/uncompressed-3d",
      severity: now - then > 256 * 1048576 ? "high" : now - then > 32 * 1048576 ? "medium" : "low",
      category: "memory",
      title: `${uncompressed3d.length} textures on 3D materials are not VRAM-compressed (${mb(now)} MB on the GPU)`,
      detail:
        "Lossless and lossy textures are stored small on disk but are uploaded uncompressed: 4 bytes per pixel. VRAM compression (S3TC/BPTC on desktop) is 4 to 8 times smaller on the GPU and samples faster. Godot switches a texture over the first time the editor sees it on a 3D material; a project built from the command line or by an agent never gets that pass. Godot has no texture streaming, so every texture of a loaded scene stays in VRAM.",
      evidence: uncompressed3d.slice(0, 8).map((t) => ({ file: t.path, size: `${t.width}x${t.height}`, vram_mb: mb(t.vram), after_mb: mb(t.vramIfFixed) })),
      metric: { textures: uncompressed3d.length, vram_mb: mb(now), after_mb: mb(then), saved_mb: mb(now - then) },
      fix: { fix: "textures" },
      gain: `${mb(now - then)} MB of VRAM`,
      risk: "reimport",
    });
  }
  const noMips = list.filter((t) => t.in3d && t.imported && !t.mipmaps && t.width >= 64);
  if (noMips.length) {
    out.push({
      id: "textures/no-mipmaps-3d",
      severity: noMips.length >= 20 ? "medium" : "low",
      category: "quality",
      title: `${noMips.length} textures on 3D materials have no mipmaps`,
      detail: "Without mipmaps a distant surface samples the full-size texture: it shimmers as the camera moves and misses the texture cache on every pixel. Mipmaps cost a third more memory and fix both.",
      evidence: noMips.slice(0, 8).map((t) => ({ file: t.path, size: `${t.width}x${t.height}` })),
      fix: { fix: "textures" },
      gain: "stable distant surfaces, faster sampling",
      risk: "reimport",
    });
  }
  const huge = list.filter((t) => Math.max(t.width, t.height) > 4096);
  if (huge.length) out.push({ id: "textures/oversized", severity: "medium", category: "memory", title: `${huge.length} textures are larger than 4096 pixels`, detail: "An 8192x8192 texture is 85 MB compressed with mipmaps and 341 MB without compression. Set process/size_limit in its import settings, or split it.", evidence: huge.slice(0, 8).map((t) => ({ file: t.path, size: `${t.width}x${t.height}`, vram_mb: mb(t.vram) })), fix: { fix: "textures", sizeLimit: 4096 }, risk: "visual" });
  const notImported = list.filter((t) => !t.imported).length;
  if (notImported > 0 && notImported === list.length) out.push({ id: "textures/not-imported", severity: "info", category: "memory", title: "The project has not been imported yet", detail: "No .import files: run `godot --headless --import` once, then audit again so the import settings can be checked.", fix: null, risk: "none" });
  // Models with embedded textures.
  let embedded = 0;
  let embeddedBytes = 0;
  const worst = [];
  for (const f of project.ext(".glb")) {
    const m = readModel(project.abs(f));
    const big = m.images.filter((im) => im.embedded && im.width);
    if (!big.length) continue;
    const v = big.reduce((a, im) => a + vramBytes(im, { compressed: false, mipmaps: true }), 0);
    embedded += big.length;
    embeddedBytes += v;
    worst.push({ file: f, textures: big.length, largest: `${Math.max(...big.map((i) => i.width))}px`, vram_mb_if_uncompressed: mb(v) });
  }
  if (embedded >= 8 && embeddedBytes > 64 * 1048576) {
    worst.sort((a, b) => b.vram_mb_if_uncompressed - a.vram_mb_if_uncompressed);
    out.push({ id: "textures/embedded-in-models", severity: "low", category: "memory", title: `${embedded} textures are embedded in .glb files`, detail: "Godot extracts them on import and compresses them for 3D, but models that share a texture each carry their own copy: the same pixels are in VRAM several times. Export shared textures as files next to the models.", evidence: worst.slice(0, 6), fix: null, risk: "none" });
  }
  return { findings: out, inventory: list, vramBytes: total };
}
