import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDemoWorld } from "../src/demo.mjs";
import { toolByName } from "../src/tools.mjs";

export function demo(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "go-test-"));
  writeDemoWorld(dir, { trees: 300, rocks: 200, houses: 40, lamps: 20, fences: 120, extent: 800, textureSize: 128, force: true, ...options });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const call = (name, args) => toolByName.get(name).handler(args);
export const read = (dir, file) => readFileSync(join(dir, file), "utf8");

/** A minimal OpenEXR header: magic, version 2, then attributes whose dataWindow is width x height at xMin,yMin. */
export function exrHeader(width, height, { xMin = 0, yMin = 0 } = {}) {
  const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
  const box = Buffer.concat([int32(xMin), int32(yMin), int32(xMin + width - 1), int32(yMin + height - 1)]);
  const attr = (name, type, value) => [Buffer.from(`${name}\0${type}\0`, "latin1"), int32(value.length), value];
  const magic = Buffer.alloc(4);
  magic.writeUInt32LE(0x01312f76);
  return Buffer.concat([magic, int32(2), ...attr("channels", "chlist", Buffer.alloc(0)), ...attr("compression", "compression", Buffer.from([3])), ...attr("dataWindow", "box2i", box), Buffer.from([0])]);
}

export function snapshot(dir) {
  const out = new Map();
  const walk = (abs, rel) => {
    for (const n of readdirSync(abs)) {
      if (n === ".gameoptimizer" || n === ".godot") continue;
      const p = join(abs, n);
      if (statSync(p).isDirectory()) walk(p, rel + n + "/");
      else out.set(rel + n, readFileSync(p).toString("base64"));
    }
  };
  walk(dir, "");
  return out;
}
