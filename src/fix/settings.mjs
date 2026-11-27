// Fixes that edit project.godot and .import files.
import { parseSections, writeSections, makeSection } from "../godot/tscn.mjs";
import { writeVariant } from "../godot/variant.mjs";
import { recommendedSettings } from "../analyze/settings.mjs";
import { textureInventory } from "../analyze/textures.mjs";
import { readModel } from "../godot/glb.mjs";

/** Sets project settings in the text of project.godot. `values` maps full paths to JS values or raw strings ({raw}). */
export function editProjectSettings(text, values) {
  const sections = parseSections(text, { ini: true });
  for (const [path, value] of Object.entries(values)) {
    const slash = path.indexOf("/");
    const tag = path.slice(0, slash);
    const key = path.slice(slash + 1);
    let sec = sections.find((s) => s.tag === tag);
    if (!sec) {
      sec = makeSection(tag, {});
      sec.ini = true;
      sec.headerRaw = `[${tag}]`;
      sec.headerDirty = false;
      // Godot keeps the sections in alphabetical order.
      let at = sections.findIndex((s) => s.tag !== "" && s.tag > tag);
      if (at < 0) at = sections.length;
      sections.splice(at, 0, sec);
    }
    if (value === undefined) sec.remove(key);
    else sec.set(key, value && typeof value === "object" && "raw" in value ? value.raw : writeVariant(value));
  }
  let out = writeSections(sections);
  return out.replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
}

export function fixSettings(project, tx, ctx) {
  const rec = recommendedSettings(project, ctx);
  if (rec.length === 0) return { settings: [] };
  const values = Object.fromEntries(rec.map((r) => [r.path, r.value]));
  tx.write("project.godot", editProjectSettings(project.text("project.godot"), values));
  return { settings: rec.map((r) => ({ setting: r.path, from: r.current, to: r.value, why: r.why })) };
}

function setImportParams(project, tx, resPath, params) {
  const file = resPath + ".import";
  const text = tx.writes.get(file) ?? project.text(file);
  if (text === null) return false;
  const sections = parseSections(text, { ini: true });
  let sec = sections.find((s) => s.tag === "params");
  if (!sec) return false;
  let changed = false;
  for (const [k, v] of Object.entries(params)) {
    const raw = writeVariant(v);
    if (sec.rawOf(k) !== raw) {
      sec.set(k, raw);
      changed = true;
    }
  }
  if (!changed) return false;
  tx.write(file, writeSections(sections).replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n"));
  // Godot re-imports a file when its .md5 stamp is missing.
  const remap = sections.find((s) => s.tag === "remap");
  const dest = remap?.get("path") ?? remap?.get("path.s3tc") ?? remap?.get("path.bptc");
  if (typeof dest === "string") {
    const md5 = project.rel(dest).replace(/\.[^.\/]+$/, ".md5");
    if (project.exists(md5)) tx.delete(md5);
  }
  return true;
}

export function fixTextures(project, tx, { sizeLimit = 0 } = {}) {
  const list = textureInventory(project);
  const done = [];
  let before = 0;
  let after = 0;
  for (const t of list) {
    if (!t.imported || !t.in3d || t.importer !== "texture") continue;
    const params = {};
    if (!t.compressed && t.width * t.height >= 128 * 128) {
      params["compress/mode"] = 2;
      params["detect_3d/compress_to"] = 0;
    }
    if (!t.mipmaps && t.width >= 64) params["mipmaps/generate"] = true;
    if (sizeLimit > 0 && Math.max(t.width, t.height) > sizeLimit) params["process/size_limit"] = sizeLimit;
    if (Object.keys(params).length === 0) continue;
    if (setImportParams(project, tx, t.path, params)) {
      done.push({ file: t.path, size: `${t.width}x${t.height}`, set: params });
      before += t.vram;
      after += t.vramIfFixed ?? t.vram;
    }
  }
  const settings = {};
  if (done.length && project.setting("rendering/textures/vram_compression/import_s3tc_bptc") !== true) settings["rendering/textures/vram_compression/import_s3tc_bptc"] = true;
  if (Object.keys(settings).length) tx.write("project.godot", editProjectSettings(tx.writes.get("project.godot") ?? project.text("project.godot"), settings));
  return { textures: done.length, vram_mb_before: Math.round(before / 104857.6) / 10, vram_mb_after: Math.round(after / 104857.6) / 10, files: done.slice(0, 40), next: done.length ? "Re-import: `godot --headless --path <project> --import` (optimizer_bench does it for you)." : undefined };
}

export function fixLods(project, tx) {
  const done = [];
  for (const f of project.ext(".glb", ".gltf")) {
    const imp = project.importOf(f);
    if (!imp || imp.importer !== "scene") continue;
    const params = {};
    if (imp.param("meshes/generate_lods") === false) params["meshes/generate_lods"] = true;
    if (imp.param("meshes/create_shadow_meshes") === false) params["meshes/create_shadow_meshes"] = true;
    if (Object.keys(params).length === 0) continue;
    const model = readModel(project.abs(f));
    if (model.skins > 0 && model.triangles < 20000) continue;
    if (setImportParams(project, tx, f, params)) done.push({ file: f, triangles: model.triangles, set: params });
  }
  return { models: done.length, files: done.slice(0, 40), next: done.length ? "Re-import: `godot --headless --path <project> --import`." : undefined };
}

/** Models imported with LODs off: for the audit. */
export function modelsWithoutLods(project) {
  const out = [];
  for (const f of project.ext(".glb", ".gltf")) {
    const imp = project.importOf(f);
    if (!imp || imp.importer !== "scene" || imp.param("meshes/generate_lods") !== false) continue;
    const model = readModel(project.abs(f));
    if (model.triangles >= 3000) out.push({ file: f, triangles: model.triangles });
  }
  return out;
}
