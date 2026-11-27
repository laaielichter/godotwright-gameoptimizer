// Lossless reader and writer for Godot text resources (.tscn, .tres) and for the ini-like files that share the
// layout (project.godot, .import, export_presets.cfg). A file is a list of sections; a section is a header line and
// properties. Untouched sections are written back byte for byte.
import { parseVariant } from "./variant.mjs";

export class Section {
  constructor(tag, attrs, headerRaw) {
    this.tag = tag; // "gd_scene", "ext_resource", "sub_resource", "node", "connection", "resource", "" (preamble)
    this.attrs = attrs; // parsed header attributes
    this.headerRaw = headerRaw;
    this.props = []; // {key, raw} in order; raw is the text after "= "
    this.lead = []; // comment / blank lines inside the section, kept in place: {at: index in props, text}
    this.dirty = false;
    this.raw = null; // original text of the whole section
    this._cache = new Map();
  }
  has(key) {
    return this.props.some((p) => p.key === key);
  }
  rawOf(key) {
    const p = this.props.find((x) => x.key === key);
    return p ? p.raw : undefined;
  }
  get(key) {
    if (this._cache.has(key)) return this._cache.get(key);
    const raw = this.rawOf(key);
    const v = raw === undefined ? undefined : parseVariant(raw);
    this._cache.set(key, v);
    return v;
  }
  set(key, raw) {
    this._cache.delete(key);
    this.dirty = true;
    const p = this.props.find((x) => x.key === key);
    if (p) p.raw = raw;
    else this.props.push({ key, raw });
  }
  remove(key) {
    const before = this.props.length;
    this.props = this.props.filter((p) => p.key !== key);
    if (this.props.length !== before) {
      this.dirty = true;
      this._cache.delete(key);
    }
  }
  setAttr(name, value) {
    this.attrs[name] = value;
    this.dirty = true;
    this.headerDirty = true;
  }
  header() {
    if (!this.headerDirty && this.headerRaw !== null) return this.headerRaw;
    if (this.tag === "") return "";
    const parts = [this.tag];
    for (const [k, v] of Object.entries(this.attrs)) parts.push(`${k}=${attrText(v)}`);
    return "[" + parts.join(" ") + "]";
  }
  toString() {
    if (!this.dirty && this.raw !== null) return this.raw;
    const lines = [];
    const h = this.header();
    if (h) lines.push(h);
    if (this.tag === "" && this.preamble) return this.preamble + "\n" + this.props.map((p) => `${p.key}=${p.raw}`).join("\n") + "\n\n";
    if (this.ini) {
      // project.godot and .import files: a blank line after the header, key=value, a blank line at the end.
      if (h) lines.push("");
      for (const p of this.props) lines.push(`${p.key}=${p.raw}`);
      return lines.join("\n") + "\n\n";
    }
    for (const p of this.props) lines.push(`${p.key} = ${p.raw}`);
    return lines.join("\n") + "\n";
  }
}

function attrText(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (v && v.$) return `${v.$}(${v.args.map((a) => JSON.stringify(a)).join(", ")})`;
  if (Array.isArray(v)) return "[" + v.map((a) => JSON.stringify(a)).join(", ") + "]";
  return String(v);
}

/** How many characters of `text` from `start` belong to one value (balanced brackets and strings). */
function valueEnd(text, start) {
  let depth = 0;
  let i = start;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (i < n && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "\n" && depth <= 0) return i;
    i++;
  }
  return n;
}

function parseHeader(line) {
  // [tag key=value key2="str" key3=ExtResource("1") key4=["a", "b"]]
  const inner = line.slice(1, line.lastIndexOf("]"));
  const m = /^([A-Za-z_][\w./-]*)\s*/.exec(inner);
  if (!m) return { tag: inner.trim(), attrs: {} };
  const attrs = {};
  let i = m[0].length;
  while (i < inner.length) {
    const km = /^\s*([A-Za-z_][\w]*)=/.exec(inner.slice(i));
    if (!km) break;
    i += km[0].length;
    let j = i;
    let depth = 0;
    while (j < inner.length) {
      const c = inner[j];
      if (c === '"') {
        j++;
        while (j < inner.length && inner[j] !== '"') j += inner[j] === "\\" ? 2 : 1;
      } else if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === " " && depth === 0) break;
      j++;
    }
    attrs[km[1]] = parseVariant(inner.slice(i, j));
    i = j;
  }
  return { tag: m[1], attrs };
}

export function parseSections(text, { ini = false } = {}) {
  text = text.replace(/\r\n/g, "\n");
  const sections = [];
  let cur = new Section("", {}, null);
  cur.ini = ini;
  let curStart = 0;
  let i = 0;
  const n = text.length;
  const close = (end) => {
    cur.raw = text.slice(curStart, end);
    if (cur.tag !== "" || cur.raw.length > 0) sections.push(cur);
  };
  while (i < n) {
    let eol = text.indexOf("\n", i);
    if (eol < 0) eol = n;
    const line = text.slice(i, eol);
    const t = line.trimStart();
    if (t.startsWith("[") && (ini || /^\[[A-Za-z_]/.test(t)) && !/^\[[^\]]*$/.test(t)) {
      close(i);
      const { tag, attrs } = parseHeader(t);
      cur = new Section(tag, attrs, line);
      cur.ini = ini;
      curStart = i;
      i = eol + 1;
      continue;
    }
    const eq = /^([^\s=;#\[][^=]*?)\s*=\s*/.exec(line);
    if (eq) {
      const vs = i + eq[0].length;
      const ve = valueEnd(text, vs);
      cur.props.push({ key: eq[1], raw: text.slice(vs, ve).trimEnd() });
      i = ve + 1;
      continue;
    }
    if (t !== "") {
      cur.hasComments = true;
      if (cur.tag === "") cur.preamble = (cur.preamble ?? "") + line + "\n";
    }
    i = eol + 1;
  }
  close(n);
  return sections;
}

export function writeSections(sections) {
  let out = "";
  let prevDirty = false;
  for (const s of sections) {
    const dirty = s.dirty || s.raw === null;
    // Sections are separated by one blank line; untouched ones carry their own.
    if (out && (dirty || prevDirty) && !out.endsWith("\n\n")) out += out.endsWith("\n") ? "\n" : "\n\n";
    out += s.toString();
    prevDirty = dirty;
  }
  return out.replace(/\n{2,}$/, "\n");
}

/** A parsed scene or resource file with lookups. */
export class ResourceFile {
  constructor(text) {
    this.sections = parseSections(text);
    this.head = this.sections.find((s) => s.tag === "gd_scene" || s.tag === "gd_resource");
    this.isScene = this.head?.tag === "gd_scene";
    this.reindex();
  }
  reindex() {
    this.ext = new Map();
    this.sub = new Map();
    this.nodes = [];
    this.connections = [];
    for (const s of this.sections) {
      if (s.tag === "ext_resource") this.ext.set(String(s.attrs.id), s);
      else if (s.tag === "sub_resource") this.sub.set(String(s.attrs.id), s);
      else if (s.tag === "node") this.nodes.push(s);
      else if (s.tag === "connection") this.connections.push(s);
    }
  }
  toString() {
    return writeSections(this.sections);
  }
  /** Path of a node section as Godot writes it in `parent=`: "." for the root's children. */
  static nodePath(s) {
    if (s.attrs.parent === undefined) return ".";
    return s.attrs.parent === "." ? String(s.attrs.name) : `${s.attrs.parent}/${s.attrs.name}`;
  }
  newExtId(prefix = "go") {
    let k = 1;
    while (this.ext.has(`${prefix}_${k}`)) k++;
    return `${prefix}_${k}`;
  }
  newSubId(type) {
    let k = 1;
    while (this.sub.has(`${type}_go${k}`)) k++;
    return `${type}_go${k}`;
  }
  /** Adds a section before the first node (resources must come before nodes). */
  addResourceSection(section) {
    section.dirty = true;
    let at = this.sections.findIndex((s) => s.tag === "node" || s.tag === "resource");
    if (at < 0) at = this.sections.length;
    if (section.tag === "ext_resource") {
      const firstSub = this.sections.findIndex((s) => s.tag === "sub_resource");
      if (firstSub >= 0) at = firstSub;
    }
    this.sections.splice(at, 0, section);
    this.reindex();
    this.bumpLoadSteps();
  }
  bumpLoadSteps() {
    if (!this.head || this.head.attrs.load_steps === undefined) return;
    this.head.setAttr("load_steps", this.ext.size + this.sub.size + 1);
  }
}

export function makeSection(tag, attrs, props = {}) {
  const s = new Section(tag, attrs, null);
  s.dirty = true;
  s.headerDirty = true;
  for (const [k, v] of Object.entries(props)) s.props.push({ key: k, raw: v });
  return s;
}
