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
