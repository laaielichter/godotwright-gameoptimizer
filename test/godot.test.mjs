// Tests that run Godot. Off by default: GO_TEST_GODOT=1 npm test (needs GODOT or godot on PATH).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { demo, call } from "./helpers.mjs";
import { findGodot } from "../src/bench.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let godot = null;
if (process.env.GO_TEST_GODOT) {
  try {
    godot = findGodot();
  } catch {
    godot = null;
  }
}
const skip = godot ? false : "set GO_TEST_GODOT=1 and GODOT to run";
const clean = (out) => out.split("\n").filter((l) => /^(SCRIPT ERROR|ERROR|WARNING)/.test(l) && !/alsa|audio|pulse|status < 0|xkb|x11/i.test(l));

test("runtime kit self-test in Godot (headless)", { skip, timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "go-rt-"));
  try {
    cpSync(join(here, "godot", "selftest"), dir, { recursive: true });
    cpSync(join(here, "..", "runtime", "addons"), join(dir, "addons"), { recursive: true });
    spawnSync(godot, ["--headless", "--path", dir, "--import"], { encoding: "utf8", timeout: 120_000 });
    const r = spawnSync(godot, ["--headless", "--path", dir, "--", "--selftest"], { encoding: "utf8", timeout: 240_000 });
    const out = r.stdout + r.stderr;
    assert.match(out, /SELFTEST DONE/, out.slice(-2000));
    const failed = out.split("\n").filter((l) => l.startsWith("FAIL "));
    assert.deepEqual(failed, []);
    assert.ok(out.split("\n").filter((l) => l.startsWith("PASS ")).length >= 20);
    assert.deepEqual(clean(out).filter((l) => /SCRIPT ERROR/.test(l)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fully optimized demo world imports, streams and measures in Godot (headless)", { skip, timeout: 600_000 }, async () => {
  const d = demo({ trees: 160, rocks: 120, houses: 30, lamps: 12, fences: 60, extent: 600, textureSize: 64 });
  try {
    const base = await call("optimizer_bench", { project: d.dir, label: "baseline", frames: 40, warmup: 5, headless: true, godot });
    assert.equal(base.frames, 40);
    assert.ok(base.frame_ms.p50 > 0);
    assert.ok(base.monitors.nodes.max > 500);
    assert.deepEqual(base.errors, []);
    // The probe was only there for the run.
    assert.ok(!/GOProbe/.test(readFileSync(join(d.dir, "project.godot"), "utf8")));
    for (const fix of ["install", "settings", "textures", "lights", "ranges", "instancing", "partition"]) call("optimizer_fix", { project: d.dir, fix });
    const after = await call("optimizer_bench", { project: d.dir, label: "optimized", frames: 40, warmup: 5, headless: true, reimport: true, mode: "fly", godot });
    assert.deepEqual(after.errors, []);
    assert.equal(after.streamers.length, 4);
    assert.ok(after.streamers.some((s) => s.loaded > 0), "chunks were loaded");
    assert.ok(after.monitors.nodes.max < base.monitors.nodes.max / 2, `${after.monitors.nodes.max} nodes after, ${base.monitors.nodes.max} before`);
    const cmp = call("optimizer_compare", { project: d.dir, run: "optimized" });
    assert.equal(cmp.metrics.find((m) => m.metric === "nodes (max)").verdict, "better");
    // Every chunk scene loads in Godot.
    const check = join(d.dir, "check_chunks.gd");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(check, `extends SceneTree\nfunc _init():\n\tvar bad := 0\n\tvar n := 0\n\tvar dirs := ["res://world/world_chunks"]\n\twhile not dirs.is_empty():\n\t\tvar p: String = dirs.pop_back()\n\t\tfor s in DirAccess.get_directories_at(p):\n\t\t\tdirs.push_back(p + "/" + s)\n\t\tfor f in DirAccess.get_files_at(p):\n\t\t\tif f.ends_with(".tscn"):\n\t\t\t\tn += 1\n\t\t\t\tvar ps: PackedScene = load(p + "/" + f)\n\t\t\t\tif ps == null or not ps.can_instantiate():\n\t\t\t\t\tbad += 1\n\t\t\t\telse:\n\t\t\t\t\tps.instantiate().free()\n\tprint("CHUNKS ", n, " BAD ", bad)\n\tquit()\n`);
    const r = spawnSync(godot, ["--headless", "--path", d.dir, "-s", "res://check_chunks.gd"], { encoding: "utf8", timeout: 240_000 });
    const m = /CHUNKS (\d+) BAD (\d+)/.exec(r.stdout + r.stderr);
    assert.ok(m, (r.stdout + r.stderr).slice(-1500));
    assert.ok(Number(m[1]) > 10);
    assert.equal(Number(m[2]), 0);
    assert.deepEqual(clean(r.stdout + r.stderr), []);
  } finally {
    d.cleanup();
  }
});
