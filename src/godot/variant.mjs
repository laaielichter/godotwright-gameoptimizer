// Reader for Godot's text Variant format (the values in .tscn, .tres, project.godot and .import files).
// Returns plain JS: numbers, strings, booleans, null, arrays, objects, and {$: "Name", args: [...]} for constructors
// such as Vector3(...), Transform3D(...), ExtResource("id"), SubResource("id"), PackedFloat32Array(...).

export function parseVariant(text) {
  const p = { s: text, i: 0 };
  const v = value(p);
  return v;
}

function ws(p) {
  while (p.i < p.s.length && /\s/.test(p.s[p.i])) p.i++;
}

function value(p) {
  ws(p);
  const c = p.s[p.i];
  if (c === undefined) return null;
  if (c === '"') return str(p);
  if (c === "&" || c === "^") {
    p.i++;
    return str(p);
  }
  if (c === "[") {
    p.i++;
    const out = [];
    for (;;) {
      ws(p);
      if (p.s[p.i] === "]") {
        p.i++;
        return out;
      }
      if (p.i >= p.s.length) return out;
      out.push(value(p));
      ws(p);
      if (p.s[p.i] === ",") p.i++;
    }
  }
  if (c === "{") {
    p.i++;
    const out = {};
    for (;;) {
      ws(p);
      if (p.s[p.i] === "}") {
        p.i++;
        return out;
      }
      if (p.i >= p.s.length) return out;
      const k = value(p);
      ws(p);
      if (p.s[p.i] === ":") p.i++;
      out[typeof k === "string" ? k : JSON.stringify(k)] = value(p);
      ws(p);
      if (p.s[p.i] === ",") p.i++;
    }
  }
  const m = /^[A-Za-z_@][A-Za-z0-9_.]*/.exec(p.s.slice(p.i, p.i + 80));
  if (m) {
    p.i += m[0].length;
    const word = m[0];
    ws(p);
    // Typed containers: Array[Type]([...]) and Dictionary[K, V]({...})
    if (p.s[p.i] === "[" && (word === "Array" || word === "Dictionary")) {
      let depth = 0;
      while (p.i < p.s.length) {
        if (p.s[p.i] === "[") depth++;
        else if (p.s[p.i] === "]" && --depth === 0) {
          p.i++;
          break;
        }
        p.i++;
      }
      ws(p);
    }
    if (p.s[p.i] === "(") {
      p.i++;
      const args = [];
      for (;;) {
        ws(p);
        if (p.s[p.i] === ")") {
          p.i++;
          break;
        }
        if (p.i >= p.s.length) break;
        args.push(value(p));
        ws(p);
        if (p.s[p.i] === ",") p.i++;
      }
      if (word === "Array" || word === "Dictionary") return args[0] ?? null;
      return { $: word, args };
    }
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null" || word === "nil") return null;
    if (word === "inf") return Infinity;
    if (word === "nan") return NaN;
    return { $: word, args: [] };
  }
  const n = /^[-+]?(?:inf|nan|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(p.s.slice(p.i, p.i + 64));
  if (n) {
    p.i += n[0].length;
    if (/inf/.test(n[0])) return n[0][0] === "-" ? -Infinity : Infinity;
    return Number(n[0]);
  }
  p.i++; // unknown character: skip, never loop forever
  return null;
}

function str(p) {
  let out = "";
  p.i++;
  while (p.i < p.s.length) {
    const c = p.s[p.i++];
    if (c === '"') break;
    if (c === "\\") {
      const e = p.s[p.i++];
      out += e === "n" ? "\n" : e === "t" ? "\t" : e;
    } else out += c;
  }
  return out;
}

export const isCall = (v, name) => v !== null && typeof v === "object" && v.$ === name;
export const refId = (v) => (v && (v.$ === "ExtResource" || v.$ === "SubResource") ? String(v.args[0]) : null);

// ---- writing -------------------------------------------------------------------------------------------------

export function num(n) {
  if (!Number.isFinite(n)) return n > 0 ? "inf" : n < 0 ? "-inf" : "nan";
  if (Number.isInteger(n)) return String(n);
  const s = Number(n.toPrecision(7)).toString();
  return s;
}

export function writeVariant(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return num(v);
  if (typeof v === "string") return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  if (Array.isArray(v)) return "[" + v.map(writeVariant).join(", ") + "]";
  if (v.$) return v.$ + "(" + v.args.map(writeVariant).join(", ") + ")";
  return "{\n" + Object.entries(v).map(([k, x]) => `${writeVariant(k)}: ${writeVariant(x)}`).join(",\n") + "\n}";
}

// ---- 3D math on Transform3D as 12 numbers: basis rows (xx,xy,xz, yx,yy,yz, zx,zy,zz) then origin ---------------
// Godot writes Transform3D(xx, xy, xz, yx, yy, yz, zx, zy, zz, ox, oy, oz) where the basis is given row by row.

export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export function toTransform(v) {
  if (isCall(v, "Transform3D") && v.args.length === 12 && v.args.every((n) => typeof n === "number")) return v.args;
  return IDENTITY;
}

export function mulTransform(a, b) {
  const r = new Array(12);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      r[row * 3 + col] = a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
    }
    r[9 + row] = a[row * 3] * b[9] + a[row * 3 + 1] * b[10] + a[row * 3 + 2] * b[11] + a[9 + row];
  }
  return r;
}

export function xformPoint(t, p) {
  return [
    t[0] * p[0] + t[1] * p[1] + t[2] * p[2] + t[9],
    t[3] * p[0] + t[4] * p[1] + t[5] * p[2] + t[10],
    t[6] * p[0] + t[7] * p[1] + t[8] * p[2] + t[11],
  ];
}

/** Axis-aligned box [minx,miny,minz,maxx,maxy,maxz] after a transform. */
export function xformAabb(t, b) {
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    const p = xformPoint(t, [b[k & 1 ? 3 : 0], b[k & 2 ? 4 : 1], b[k & 4 ? 5 : 2]]);
    for (let a = 0; a < 3; a++) {
      if (p[a] < out[a]) out[a] = p[a];
      if (p[a] > out[a + 3]) out[a + 3] = p[a];
    }
  }
  return out;
}

export function unionAabb(a, b) {
  if (!a) return b ? b.slice() : null;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5])];
}

export const aabbSize = (b) => [b[3] - b[0], b[4] - b[1], b[5] - b[2]];
export const aabbCenter = (b) => [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
export const aabbRadius = (b) => Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;

export function transformScale(t) {
  return Math.max(Math.hypot(t[0], t[3], t[6]), Math.hypot(t[1], t[4], t[7]), Math.hypot(t[2], t[5], t[8]));
}

export function writeTransform(t) {
  return "Transform3D(" + t.map(num).join(", ") + ")";
}

/** Inverse of an affine transform. */
export function invertTransform(t) {
  const [a, b, c, d, e, f, g, h, i] = t;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return IDENTITY;
  const r = [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
  return [...r, -(r[0] * t[9] + r[1] * t[10] + r[2] * t[11]), -(r[3] * t[9] + r[4] * t[10] + r[5] * t[11]), -(r[6] * t[9] + r[7] * t[10] + r[8] * t[11])];
}
