// A Godot project on disk: its files, settings and import files.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, relative, dirname, extname, isAbsolute } from "node:path";
import { parseSections, writeSections, makeSection } from "./godot/tscn.mjs";
import { parseVariant } from "./godot/variant.mjs";

export class OptimizerError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

export function findProjectRoot(start = ".") {
  let dir = resolve(start);
  if (existsSync(dir) && statSync(dir).isFile()) dir = dirname(dir);
  for (;;) {
    if (existsSync(join(dir, "project.godot"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new OptimizerError(`No project.godot found in ${resolve(start)} or above it.`, "Pass the folder that holds project.godot as `project`.");
}

const SKIP_DIRS = new Set([".godot", ".git", ".import", "node_modules", ".gameoptimizer"]);

export class Project {
  constructor(root) {
    this.root = findProjectRoot(root);
    this.files = []; // res-relative paths with forward slashes
    this.byExt = new Map();
    this._text = new Map();
    this._import = new Map();
    this.walk(this.root, "");
    this.settingsText = readFileSync(join(this.root, "project.godot"), "utf8");
    this.settingsSections = parseSections(this.settingsText, { ini: true });
  }
  walk(abs, rel) {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    if (rel && entries.some((e) => e.name === ".gdignore")) return;
    if (rel && entries.some((e) => e.name === "project.godot")) return; // a nested project is another project
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) this.walk(join(abs, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile()) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        this.files.push(p);
        const ext = extname(e.name).toLowerCase();
        if (!this.byExt.has(ext)) this.byExt.set(ext, []);
        this.byExt.get(ext).push(p);
      }
    }
  }
  ext(...exts) {
    return exts.flatMap((e) => this.byExt.get(e) ?? []);
  }
  abs(resPath) {
    return join(this.root, resPath.replace(/^res:\/\//, ""));
  }
  rel(absOrRes) {
    if (absOrRes.startsWith("res://")) return absOrRes.slice(6);
    if (isAbsolute(absOrRes)) return relative(this.root, absOrRes).replace(/\\/g, "/");
    return absOrRes.replace(/\\/g, "/").replace(/^\.\//, "");
  }
  exists(resPath) {
    return existsSync(this.abs(resPath));
  }
  text(resPath) {
    const k = this.rel(resPath);
    if (!this._text.has(k)) {
      let t = null;
      try {
        t = readFileSync(this.abs(k), "utf8");
      } catch {
        /* missing */
      }
      this._text.set(k, t);
    }
    return this._text.get(k);
  }
  invalidate(resPath) {
    this._text.delete(this.rel(resPath));
    this._import.delete(this.rel(resPath));
  }
  /** A project setting by its full path, e.g. "rendering/scaling_3d/mode". Undefined when not set (engine default). */
  setting(path) {
    const slash = path.indexOf("/");
    const sec = this.settingsSections.find((s) => s.tag === path.slice(0, slash));
    return sec ? sec.get(path.slice(slash + 1)) : undefined;
  }
  /** The parsed .import file next to an asset: {importer, type, params: Map-like getter}. */
  importOf(resPath) {
    const k = this.rel(resPath);
    if (this._import.has(k)) return this._import.get(k);
    const t = this.text(k + ".import");
    let out = null;
    if (t !== null) {
      const sections = parseSections(t, { ini: true });
      const remap = sections.find((s) => s.tag === "remap");
      const params = sections.find((s) => s.tag === "params");
      out = { sections, importer: remap?.get("importer"), type: remap?.get("type"), param: (key) => params?.get(key), params };
    }
    this._import.set(k, out);
    return out;
  }
  get name() {
    return this.setting("application/config/name") ?? "";
  }
  get mainScene() {
    const m = this.setting("application/run/main_scene");
    if (typeof m !== "string") return null;
    if (m.startsWith("uid://")) return this.uidPath(m);
    return this.rel(m);
  }
  get renderer() {
    const m = this.setting("rendering/renderer/rendering_method");
    return typeof m === "string" ? m : "forward_plus";
  }
  get features() {
    const f = this.setting("application/config/features");
    return f && f.$ ? f.args.map(String) : [];
  }
  get engineVersion() {
    return this.features.find((f) => /^\d+\.\d+/.test(f)) ?? null;
  }
  /** uid:// → res path, from .uid files, .import files and resource headers (built lazily). */
  uidPath(uid) {
    if (!this._uids) {
      this._uids = new Map();
      for (const f of this.ext(".uid")) {
        const t = this.text(f);
        if (t) this._uids.set(t.trim(), f.slice(0, -4));
      }
      for (const f of this.ext(".import")) {
        const m = /^uid="(uid:\/\/[^"]+)"/m.exec(this.text(f) ?? "");
        if (m) this._uids.set(m[1], f.slice(0, -7));
      }
      for (const f of this.ext(".tscn", ".tres")) {
        const t = this.text(f);
        const m = t && /^\[gd_(?:scene|resource)[^\]]*uid="(uid:\/\/[^"]+)"/.exec(t);
        if (m) this._uids.set(m[1], f);
      }
    }
    return this._uids.get(uid) ?? null;
  }
  /** Resolves the path of an [ext_resource] header to a res-relative path that exists, or null. */
  resolveExt(attrs) {
    if (typeof attrs.path === "string") {
      const p = this.rel(attrs.path);
      if (this.exists(p)) return p;
    }
    if (typeof attrs.uid === "string") return this.uidPath(attrs.uid);
    return typeof attrs.path === "string" ? this.rel(attrs.path) : null;
  }
}

export { parseSections, writeSections, makeSection, parseVariant };
