// A light GDScript reader for performance patterns: which lines are in which function and inside which loops, with
// strings and comments blanked out. Not a parser; indentation is enough for what the rules need.

export function scanScript(text) {
  const raw = text.replace(/\r\n/g, "\n").split("\n");
  const lines = [];
  let inTriple = null;
  for (let i = 0; i < raw.length; i++) {
    let src = raw[i];
    let code = "";
    let j = 0;
    if (inTriple) {
      const end = src.indexOf(inTriple);
      if (end < 0) {
        lines.push({ n: i + 1, indent: -1, code: "", raw: src });
        continue;
      }
      j = end + 3;
      code = " ".repeat(j);
      inTriple = null;
    }
    while (j < src.length) {
      const c = src[j];
      if (c === "#") break;
      if (c === '"' || c === "'") {
        if (src.startsWith(c.repeat(3), j)) {
          const end = src.indexOf(c.repeat(3), j + 3);
          if (end < 0) {
            inTriple = c.repeat(3);
            code += '""';
            j = src.length;
            break;
          }
          code += '""' + " ".repeat(end + 3 - j - 2);
          j = end + 3;
          continue;
        }
        let k = j + 1;
        while (k < src.length && src[k] !== c) k += src[k] === "\\" ? 2 : 1;
        code += c + " ".repeat(Math.max(0, k - j - 1)) + c;
        j = k + 1;
        continue;
      }
      code += c;
      j++;
    }
    const m = /^[\t ]*/.exec(src)[0];
    const indent = code.trim() === "" ? -1 : m.replace(/\t/g, "    ").length;
    lines.push({ n: i + 1, indent, code, raw: src });
  }
  // Function and loop ranges by indentation.
  const funcs = [];
  let fn = null;
  const loops = []; // stack of {indent}
  for (const l of lines) {
    if (l.indent < 0) continue;
    while (loops.length && l.indent <= loops[loops.length - 1].indent) loops.pop();
    if (fn && l.indent <= fn.indent) fn = null;
    const f = /^\s*(?:static\s+)?func\s+([A-Za-z_]\w*)\s*\(/.exec(l.code);
    if (f) {
      fn = { name: f[1], indent: l.indent, line: l.n, lines: [] };
      funcs.push(fn);
      loops.length = 0;
      continue;
    }
    l.func = fn?.name ?? null;
    l.loopDepth = loops.length;
    if (fn) fn.lines.push(l);
    if (/^\s*(for|while)\b/.test(l.code)) {
      const range = /\brange\(\s*(\d+)\s*\)/.exec(l.code);
      loops.push({ indent: l.indent, small: range ? Number(range[1]) <= 4 : false });
      l.loopDepth = loops.length - 1;
    }
    l.smallLoop = loops.length > 0 && loops.every((x) => x.small);
  }
  const ext = /^\s*extends\s+([A-Za-z_][\w.]*|"[^"]*")/m.exec(lines.map((l) => l.code).join("\n"));
  return { lines, funcs, extends: ext ? ext[1] : null, toolScript: /^@tool\b/m.test(text) };
}

export const HOT_FUNCS = new Set(["_process", "_physics_process", "_integrate_forces", "_draw", "_input", "_unhandled_input"]);

/** Names of functions reachable from the per-frame callbacks inside this script (one file deep). */
export function hotFunctions(scan) {
  const names = new Set(scan.funcs.map((f) => f.name));
  const hot = new Set(scan.funcs.filter((f) => HOT_FUNCS.has(f.name) && f.name !== "_input" && f.name !== "_unhandled_input").map((f) => f.name));
  let grew = true;
  let rounds = 0;
  while (grew && rounds++ < 6) {
    grew = false;
    for (const f of scan.funcs) {
      if (!hot.has(f.name)) continue;
      for (const l of f.lines) {
        for (const m of l.code.matchAll(/(?<![.\w])([A-Za-z_]\w*)\s*\(/g)) {
          if (names.has(m[1]) && !hot.has(m[1])) {
            hot.add(m[1]);
            grew = true;
          }
        }
      }
    }
  }
  return hot;
}
