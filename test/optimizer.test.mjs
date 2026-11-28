import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { demo, call, read, snapshot, exrHeader } from "./helpers.mjs";
import { ResourceFile } from "../src/godot/tscn.mjs";
import { Project } from "../src/project.mjs";
import { World, summarize } from "../src/world.mjs";
import { handle } from "../src/mcp.mjs";
import { TOOLS } from "../src/tools.mjs";
import { diffShots } from "../src/bench.mjs";
import { encodePng } from "../src/png.mjs";
import { writeFileSync } from "node:fs";

const SCENE = "world/world.tscn";
const flat = (dir, scene = SCENE) => summarize(new World(new Project(dir)).flatten(scene));

test("audit: world model, findings and a plan in the right order", () => {
  const d = demo();
  try {
    const r = call("optimizer_audit", { project: d.dir, detail: "full" });
    const s = r.scenes[0].summary;
    assert.equal(r.scenes[0].scene, SCENE);
    // 300 trees (trunk + crown), 200 rocks, fences, the ground, 40 houses of 3 meshes, 20 lamps of 2.
    assert.equal(s.meshInstances, 600 + 200 + r.scenes[0].summary.meshInstances - 600 - 200);
    assert.ok(s.meshInstances > 1000);
    assert.equal(s.lights, 21);
    assert.equal(s.shadowLights, 21);
    assert.equal(s.bodies, 41);
    assert.equal(s.instances, 60);
    assert.ok(s.triangles > 100000);
    const ids = r.findings.map((f) => f.id);
    for (const id of ["world/repeated-mesh-nodes", "world/no-visibility-range", "world/lights-without-distance-fade", "world/monolithic-scene", "textures/uncompressed-3d", "textures/no-mipmaps-3d", "settings/recommended", "runtime/no-quality-tiers", "script/lookup-every-frame"]) assert.ok(ids.includes(id), `missing finding ${id}`);
    assert.deepEqual(r.plan.steps.map((x) => x.args.fix), ["install", "settings", "textures", "lights", "ranges", "instancing", "partition"]);
    for (const f of r.findings) assert.ok(f.title && f.detail && f.severity && f.category, f.id);
    assert.ok(r.score < 50);
  } finally {
    d.cleanup();
  }
});

test("cost map: hotspots sit where the content is, the route goes through them", () => {
  const d = demo();
  try {
    const r = call("optimizer_costmap", { project: d.dir, cells: true });
    assert.ok(r.hotspots.length >= 3);
    const maxLoad = Math.max(...r.cells.map((c) => c.load));
    assert.equal(r.hotspots[0].load, maxLoad);
    assert.equal(r.route.stations.length, r.hotspots.length);
    for (const st of r.route.stations) assert.equal(st.pos.length, 3);
    assert.ok(r.picture.map.split("\n").length >= 4);
    // A visibility range lowers what a far cell sees.
    const before = r.totals.viewTrianglesMax;
    call("optimizer_fix", { project: d.dir, fix: "ranges", pixels: 40 });
    const after = call("optimizer_costmap", { project: d.dir }).totals.viewTrianglesMax;
    assert.ok(after < before, `${after} < ${before}`);
  } finally {
    d.cleanup();
  }
});

test("dry run writes nothing; undo restores every byte", () => {
  const d = demo();
  try {
    const before = snapshot(d.dir);
    for (const fix of ["settings", "textures", "lights", "ranges", "instancing"]) {
      const r = call("optimizer_fix", { project: d.dir, fix, dry_run: true });
      assert.equal(r.dry_run, true);
    }
    assert.deepEqual(snapshot(d.dir), before);
    for (const fix of ["install", "settings", "textures", "lights", "ranges", "instancing", "partition"]) {
      const r = call("optimizer_fix", { project: d.dir, fix });
      assert.ok(r.journal, `${fix} made a journal entry`);
    }
    assert.notDeepEqual(snapshot(d.dir), before);
    const list = call("optimizer_undo", { project: d.dir, list: true }).journal;
    assert.equal(list.length, 7);
    // Undoing an early entry while later ones changed the same files is refused.
    assert.equal(call("optimizer_undo", { project: d.dir, id: list.find((e) => e.fix === "ranges").id }).undone, null);
    for (let i = 0; i < 7; i++) assert.ok(call("optimizer_undo", { project: d.dir }).undone);
    assert.deepEqual(snapshot(d.dir), before);
    assert.equal(call("optimizer_undo", { project: d.dir }).undone, null);
  } finally {
    d.cleanup();
  }
});

test("instancing: every merged node becomes one instance at the same place", () => {
  const d = demo();
  try {
    const p = new Project(d.dir);
    const world0 = new World(p).flatten(SCENE);
    const trunks = world0.objects.filter((o) => o.kind === "mesh" && o.meshKey === `${SCENE}::trunk`);
    const s0 = summarize(world0);
    const r = call("optimizer_fix", { project: d.dir, fix: "instancing", cell_size: 64 });
    assert.ok(r.result.merged > 600);
    const s1 = flat(d.dir);
    assert.equal(s1.meshInstances + s1.multimeshInstances, s0.meshInstances, "no object lost or added");
    assert.equal(s1.meshInstances, s0.meshInstances - r.result.merged);
    assert.equal(s1.multimeshes, r.result.multimeshes);
    assert.equal(s1.triangles, s0.triangles);
    // Positions: collect instance origins of all trunk MultiMeshes and compare with the original nodes.
    const file = new ResourceFile(read(d.dir, SCENE));
    const origins = [];
    for (const n of file.nodes) {
      if (n.attrs.type !== "MultiMeshInstance3D") continue;
      const mm = file.sub.get(n.get("multimesh").args[0]);
      if (mm.get("mesh").args[0] !== "trunk") continue;
      const t = n.get("transform").args;
      const buf = mm.get("buffer").args;
      assert.equal(buf.length, mm.get("instance_count") * 12);
      for (let i = 0; i < buf.length; i += 12) origins.push([buf[i + 3] + t[9], buf[i + 7] + t[10], buf[i + 11] + t[11]]);
      assert.ok(n.get("visibility_range_end") > 0);
    }
    const key = (v) => v.map((x) => x.toFixed(2)).join(",");
    const want = new Set(trunks.map((o) => key([o.transform[9], o.transform[10], o.transform[11]])));
    const leftAsNodes = new World(new Project(d.dir)).flatten(SCENE).objects.filter((o) => o.kind === "mesh" && o.meshKey === `${SCENE}::trunk`);
    assert.equal(origins.length + leftAsNodes.length, trunks.length);
    for (const o of origins) assert.ok(want.has(key(o)), `instance at ${key(o)} was a node before`);
    // Sibling names are unique.
    const names = file.nodes.map((n) => `${n.attrs.parent}/${n.attrs.name}`);
    assert.equal(new Set(names).size, names.length);
    // The scene still parses and has no dangling resource ids.
    for (const n of file.nodes) for (const prop of n.props) for (const m of prop.raw.matchAll(/SubResource\("([^"]+)"\)/g)) assert.ok(file.sub.has(m[1]));
  } finally {
    d.cleanup();
  }
});

test("instancing leaves nodes alone that something refers to", () => {
  const d = demo();
  try {
    let text = read(d.dir, SCENE);
    text = text.replace('[node name="Trunk00000" type="MeshInstance3D" parent="Forest"]', '[node name="Trunk00000" type="MeshInstance3D" parent="Forest" groups=["special"]]');
    text = text.replace('[node name="Trunk00001" type="MeshInstance3D" parent="Forest"]\n', '[node name="Trunk00001" type="MeshInstance3D" parent="Forest"]\nscript = ExtResource("day")\n');
    text += '\n[connection signal="visibility_changed" from="Forest/Trunk00002" to="." method="_on"]\n';
    writeFileSync(join(d.dir, SCENE), text);
    call("optimizer_fix", { project: d.dir, fix: "instancing" });
    const after = read(d.dir, SCENE);
    for (const name of ["Trunk00000", "Trunk00001", "Trunk00002"]) assert.ok(after.includes(`[node name="${name}"`), `${name} kept`);
    assert.ok((after.match(/\[node name="Trunk\d+"/g) ?? []).length < 40, "the other trunks were merged");
  } finally {
    d.cleanup();
  }
});

test("ranges and lights: properties land in the scene that owns the node", () => {
  const d = demo();
  try {
    const r = call("optimizer_fix", { project: d.dir, fix: "ranges" });
    assert.ok(r.result.ranges_set > 500);
    assert.ok(r.result.shadows_off > 10);
    assert.match(read(d.dir, "world/house.tscn"), /\[node name="Chimney"[^\[]*visibility_range_end = \d+/);
    const world = new World(new Project(d.dir)).flatten(SCENE);
    const pebble = world.objects.find((o) => o.path.startsWith("Rocks/Pebble"));
    const crown = world.objects.find((o) => o.path.startsWith("Forest/Crown"));
    assert.ok(pebble.visEnd > 0 && crown.visEnd > pebble.visEnd * 5, "big things are seen from further");
    assert.equal(pebble.castShadow, false);
    assert.equal(crown.castShadow, true);
    const l = call("optimizer_fix", { project: d.dir, fix: "lights", paraboloid: true });
    assert.equal(l.result.lights_faded, 1); // one light node, in lamp.tscn, placed 20 times
    assert.match(read(d.dir, "world/lamp.tscn"), /distance_fade_enabled = true\ndistance_fade_begin = 576\ndistance_fade_shadow = 144/);
    assert.match(read(d.dir, "world/lamp.tscn"), /omni_shadow_mode = 0/);
    // Running a fix twice changes nothing more.
    assert.equal(call("optimizer_fix", { project: d.dir, fix: "lights", paraboloid: true }).files_changed.length, 0);
    assert.equal(call("optimizer_fix", { project: d.dir, fix: "ranges" }).files_changed.length, 0);
  } finally {
    d.cleanup();
  }
});

test("textures and settings fixes", () => {
  const d = demo();
  try {
    const t = call("optimizer_fix", { project: d.dir, fix: "textures" });
    assert.equal(t.result.textures, 7);
    assert.ok(t.result.vram_mb_after < t.result.vram_mb_before);
    const imp = read(d.dir, "textures/bark.png.import");
    assert.match(imp, /compress\/mode=2/);
    assert.match(imp, /mipmaps\/generate=true/);
    assert.match(imp, /detect_3d\/compress_to=0/);
    assert.match(imp, /^\[remap\]\n\nimporter="texture"/);
    assert.match(read(d.dir, "project.godot"), /textures\/vram_compression\/import_s3tc_bptc=true/);
    const s = call("optimizer_fix", { project: d.dir, fix: "settings" });
    assert.ok(s.result.settings.some((x) => x.setting === "rendering/occlusion_culling/use_occlusion_culling"));
    const again = call("optimizer_audit", { project: d.dir }).findings.map((f) => f.id);
    for (const id of ["textures/uncompressed-3d", "textures/no-mipmaps-3d", "settings/recommended"]) assert.ok(!again.includes(id), `${id} is settled`);
  } finally {
    d.cleanup();
  }
});

test("partition: every object ends up in exactly one chunk, chunks are valid scenes", () => {
  const d = demo();
  try {
    assert.match(call("optimizer_fix", { project: d.dir, fix: "partition" }).result.error, /install/);
    call("optimizer_fix", { project: d.dir, fix: "install" });
    const s0 = flat(d.dir);
    const names0 = new ResourceFile(read(d.dir, SCENE)).nodes.filter((n) => ["Forest", "Rocks", "Town", "Fences"].includes(n.attrs.parent)).map((n) => `${n.attrs.parent}/${n.attrs.name}`);
    const r = call("optimizer_fix", { project: d.dir, fix: "partition", cell_size: 128 });
    assert.equal(r.result.partitioned, 4);
    assert.equal(r.result.nodes_moved, names0.length);
    const world = new ResourceFile(read(d.dir, SCENE));
    for (const c of ["Forest", "Rocks", "Town", "Fences"]) {
      const node = world.nodes.find((n) => n.attrs.name === c);
      assert.equal(node.attrs.type, "Node3D");
      assert.ok(world.ext.get(node.get("script").args[0]).attrs.path.endsWith("go_streamer.gd"));
      assert.equal(world.nodes.filter((n) => n.attrs.parent === c).length, 0);
    }
    for (const kept of ["Environment", "Sun", "Camera", "Ground", "DayCycle"]) assert.ok(world.nodes.some((n) => n.attrs.name === kept), `${kept} stays in the world scene`);
    assert.ok(!world.sub.has("trunk"), "resources only the chunks use left the world scene");
    // Chunks: count nodes, check every resource reference resolves, sum the model.
    const seen = new Map();
    let meshes = 0;
    let lights = 0;
    const p = new Project(d.dir);
    for (const c of r.result.containers) {
      const manifest = JSON.parse(read(d.dir, c.manifest));
      assert.equal(manifest.version, 1);
      assert.ok(manifest.unload_radius > manifest.load_radius);
      for (const ch of manifest.chunks) {
        const path = ch.scene.slice(6);
        assert.ok(existsSync(join(d.dir, path)), path);
        const f = new ResourceFile(read(d.dir, path));
        assert.equal(f.nodes[0].attrs.parent, undefined);
        for (const s of f.sections) for (const prop of s.props) {
          for (const m of prop.raw.matchAll(/ExtResource\("([^"]+)"\)/g)) assert.ok(f.ext.has(m[1]), `${path}: ext ${m[1]}`);
          for (const m of prop.raw.matchAll(/SubResource\("([^"]+)"\)/g)) assert.ok(f.sub.has(m[1]), `${path}: sub ${m[1]}`);
        }
        for (const e of f.ext.values()) assert.ok(p.exists(e.attrs.path), `${path}: ${e.attrs.path} exists`);
        for (const n of f.nodes.slice(1)) {
          if (n.attrs.parent !== ".") continue;
          const key = `${c.container}/${n.attrs.name}`;
          assert.ok(!seen.has(key), `${key} is in one chunk only`);
          seen.set(key, path);
        }
        const sum = flat(d.dir, path);
        meshes += sum.meshInstances;
        lights += sum.lights;
        assert.equal(ch.aabb.length, 6);
        if (ch.layer === "far") assert.ok(ch.load_radius > manifest.load_radius);
      }
    }
    assert.deepEqual([...seen.keys()].sort(), [...names0].sort());
    const s1 = flat(d.dir);
    assert.equal(meshes + s1.meshInstances, s0.meshInstances, "all meshes are in the chunks or still in the world");
    assert.equal(lights + s1.lights, s0.lights);
    // Shared resources are written once.
    const shared = readdirSync(join(d.dir, "world/world_chunks/shared"));
    for (const f of ["crown.tres", "fencemesh.tres", "pebble.tres", "rockmesh.tres", "trunk.tres", "house__walls.tres", "house__roof.tres"]) assert.ok(shared.includes(f), f);
    assert.ok(shared.length <= 10, `few shared files: ${shared}`);
    // Stand-ins: meshes only, every reference resolves, and they stand for the large parts of their chunk.
    let standIns = 0;
    let standInInstances = 0;
    for (const c of r.result.containers) {
      for (const ch of JSON.parse(read(d.dir, c.manifest)).chunks) {
        if (!ch.lod_scene) continue;
        standIns++;
        assert.ok(ch.lod_radius > 0);
        const f = new ResourceFile(read(d.dir, ch.lod_scene.slice(6)));
        for (const e of f.ext.values()) assert.ok(p.exists(e.attrs.path), `${ch.lod_scene}: ${e.attrs.path}`);
        for (const n of f.nodes.slice(1)) {
          assert.equal(n.attrs.type, "MultiMeshInstance3D");
          const mm = f.sub.get(n.get("multimesh").args[0]);
          assert.equal(mm.get("buffer").args.length, mm.get("instance_count") * 12);
          standInInstances += mm.get("instance_count");
        }
      }
    }
    assert.equal(standIns, r.result.stand_ins);
    assert.ok(standIns > 10);
    // Trees (trunk and crown) and houses (walls and roof) are seen from far; pebbles and chimneys are not.
    assert.ok(standInInstances >= 600 + 80, `${standInInstances} stand-in instances`);
    // Houses stream as detail with a stand-in; lamps keep shining from far, so they are real far chunks.
    const town = JSON.parse(read(d.dir, "world/world_chunks/Town.gostream.json")).chunks;
    assert.ok(town.some((c) => c.layer === "far"), "lamps are in far chunks");
    assert.ok(town.some((c) => c.lod_scene), "houses have stand-ins");
    // Without stand-ins the large objects are real nodes in far chunks.
    call("optimizer_undo", { project: d.dir });
    const plain = call("optimizer_fix", { project: d.dir, fix: "partition", cell_size: 128, stand_ins: false });
    assert.equal(plain.result.stand_ins, 0);
    assert.ok(plain.result.containers.find((c) => c.container === "Forest").far_chunks > 5);
    assert.match(read(d.dir, "world/world_chunks/shared/trunk.tres"), /^\[gd_resource type="CylinderMesh"/);
  } finally {
    d.cleanup();
  }
});

test("partition after instancing: MultiMeshes go into chunks, the meshes they share stay shared", () => {
  const d = demo();
  try {
    for (const fix of ["install", "ranges", "instancing"]) call("optimizer_fix", { project: d.dir, fix });
    const s0 = flat(d.dir);
    const mmNames = new ResourceFile(read(d.dir, SCENE)).nodes.map((n) => `${n.attrs.parent}/${n.attrs.name}`);
    assert.equal(new Set(mmNames).size, mmNames.length, "instancing after ranges makes unique names");
    const r = call("optimizer_fix", { project: d.dir, fix: "partition" });
    let instances = 0;
    for (const c of r.result.containers) {
      for (const ch of JSON.parse(read(d.dir, c.manifest)).chunks) instances += flat(d.dir, ch.scene.slice(6)).multimeshInstances;
    }
    assert.equal(instances + flat(d.dir).multimeshInstances, s0.multimeshInstances);
    const shared = readdirSync(join(d.dir, "world/world_chunks/shared"));
    assert.ok(shared.includes("trunk.tres") && shared.length <= 10, `only meshes are shared: ${shared}`);
  } finally {
    d.cleanup();
  }
});

test("install: files, autoloads, and a tuned tier file is kept", () => {
  const d = demo();
  try {
    const r = call("optimizer_fix", { project: d.dir, fix: "install" });
    assert.deepEqual(r.result.autoloads_added, ["GOQuality", "GOGovernor", "GOSpawnQueue", "GOProbe"]);
    for (const f of ["go_quality.gd", "go_governor.gd", "go_streamer.gd", "go_spawn_queue.gd", "go_prewarm.gd", "go_probe.gd", "go_lod.gd", "quality_tiers.json", "plugin.cfg"]) assert.ok(existsSync(join(d.dir, "addons/gameoptimizer", f)), f);
    assert.match(read(d.dir, "project.godot"), /\[autoload\]\n\nGOQuality="\*res:\/\/addons\/gameoptimizer\/go_quality.gd"/);
    const tiers = JSON.parse(read(d.dir, "addons/gameoptimizer/quality_tiers.json"));
    writeFileSync(join(d.dir, "addons/gameoptimizer/quality_tiers.json"), JSON.stringify({ ...tiers, mine: true }));
    const again = call("optimizer_fix", { project: d.dir, fix: "install" });
    assert.equal(again.result.files_written, 0);
    assert.equal(JSON.parse(read(d.dir, "addons/gameoptimizer/quality_tiers.json")).mine, true);
  } finally {
    d.cleanup();
  }
});

test("screenshot comparison", () => {
  const d = demo();
  try {
    const px = (r, g, b) => {
      const a = new Uint8Array(32 * 32 * 4);
      for (let i = 0; i < a.length; i += 4) a.set([r, g, b, 255], i);
      return a;
    };
    const a = px(100, 100, 100);
    const b = px(104, 100, 100);
    const c = px(100, 100, 100);
    for (let i = 0; i < 32 * 8 * 4; i += 4) c.set([255, 0, 0, 255], i);
    for (const [n, data] of [["a", a], ["b", b], ["c", c]]) writeFileSync(join(d.dir, `${n}.png`), encodePng(32, 32, data));
    assert.equal(diffShots(join(d.dir, "a.png"), join(d.dir, "b.png")).changed_percent, 0);
    assert.equal(diffShots(join(d.dir, "a.png"), join(d.dir, "c.png")).changed_percent, 25);
  } finally {
    d.cleanup();
  }
});

test("MCP: initialize, list, call, errors", async () => {
  const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.serverInfo.name, "godotwright-gameoptimizer");
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(list.result.tools.length, TOOLS.length);
  for (const t of list.result.tools) {
    assert.match(t.name, /^optimizer_[a-z]+$/);
    assert.ok(t.description.length > 60, t.name);
    assert.equal(t.inputSchema.type, "object");
    for (const [k, v] of Object.entries(t.inputSchema.properties)) assert.ok(v.type, `${t.name}.${k} has a type`);
  }
  const d = demo();
  try {
    const res = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "optimizer_audit", arguments: { project: d.dir } } });
    assert.ok(res.result.structuredContent.findings.length > 5);
    assert.equal(JSON.parse(res.result.content[0].text).project.name, "Open World Demo");
  } finally {
    d.cleanup();
  }
  const bad = await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "optimizer_audit", arguments: { project: "/nonexistent/place" } } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /project\.godot/);
  assert.equal((await handle({ jsonrpc: "2.0", id: 5, method: "nope" })).error.code, -32601);
  const explain = await handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "optimizer_explain", arguments: { topic: "world/repeated-mesh-nodes" } } });
  assert.match(explain.result.structuredContent.title, /Instancing/);
});

test("a MultiMesh has the box of its instances, so a forest cell is streamed as a large object", () => {
  const d = demo();
  try {
    for (const fix of ["install", "ranges", "instancing"]) call("optimizer_fix", { project: d.dir, fix });
    const objects = new World(new Project(d.dir)).flatten(SCENE).objects.filter((o) => o.kind === "multimesh");
    assert.ok(objects.length > 5);
    for (const o of objects) assert.ok(o.aabb[3] - o.aabb[0] > 1 && o.aabb[4] - o.aabb[1] > 0.1, "box has a size");
    const r = call("optimizer_fix", { project: d.dir, fix: "partition" });
    const forest = JSON.parse(read(d.dir, r.result.containers.find((c) => c.container === "Forest").manifest));
    const far = forest.chunks.filter((c) => c.layer === "far");
    assert.ok(far.length >= forest.chunks.length * 0.6, `${far.length} of ${forest.chunks.length} forest chunks are far chunks`);
    for (const c of far) assert.ok(c.load_radius > 400, `far radius ${c.load_radius}`);
  } finally {
    d.cleanup();
  }
});

test("census findings: a world built from code", async () => {
  const { analyzeCensus } = await import("../src/census.mjs");
  const quiet = analyzeCensus({ nodes: 800, processing: 12, physics_processing: 3, camera_far: 4000, geometry: { mesh_instances: 300, unique_meshes: 40, meshes_used_once: 20, unique_materials: 12, materials_used_once: 4, small_without_range: 10, tiny_shadow_casters: 0, groups: [{ mesh: "res://a.tres", count: 30, triangles_each: 100, made_by: "" }] }, lights: { positional_without_fade: 2, shadowed: 1 }, textures: { mb: 200, uncompressed_large: 1, uncompressed_large_mb: 8, made_at_run_time_mb: 0, largest: [] }, viewports: [], canvas_items: 500, extent: { farthest_from_origin: 900 }, physics: { trimesh_faces: 1000, shapes: {} }, scripts: [], made_by: [] });
  assert.deepEqual(quiet, [], "a small, tidy game has no findings");
  const loud = analyzeCensus({
    nodes: 91000, processing: 5200, physics_processing: 4100, camera_far: 12000,
    geometry: { mesh_instances: 60000, unique_meshes: 9000, meshes_used_once: 7000, unique_materials: 6200, materials_used_once: 5800, small_without_range: 41000, small_without_range_triangles: 9_000_000, tiny_shadow_casters: 12000, groups: [{ mesh: "<BoxMesh made at run time>", count: 21000, triangles_each: 12, made_by: "res://world/chunk_world.gd", example: "/root/W/a" }, { mesh: "<ArrayMesh made at run time>", count: 1, triangles_each: 5000, made_by: "res://world/terrain.gd", example: "/root/W/t" }] },
    lights: { positional_without_fade: 300, shadowed: 120, examples: [{ path: "/root/W/L", distance_fade: false }] },
    textures: { mb: 7000, uncompressed_large: 700, uncompressed_large_mb: 5100, made_at_run_time: 200, made_at_run_time_mb: 1900, largest: [{ path: "<made at run time>", size: [4096, 4096], compressed: false, mb: 64 }] },
    viewports: [{ path: "/root/A", size: [2048, 2048], update_mode: 4 }, { path: "/root/B", size: [1024, 1024], update_mode: 3 }],
    canvas_items: 524000, controls: 900, extent: { farthest_from_origin: 28000 }, physics: { trimesh_faces: 2_000_000, shapes: {} },
    scripts: [{ script: "res://train.gd", count: 50, processing: 50, physics_processing: 50 }], made_by: [{ name: "res://world/chunk_world.gd", count: 70000 }],
  });
  const ids = loud.map((f) => f.id);
  for (const id of ["live/repeated-mesh-nodes", "live/mesh-per-object", "live/material-per-object", "live/no-visibility-range", "live/tiny-shadow-casters", "live/lights-without-distance-fade", "live/uncompressed-textures", "live/many-processing-nodes", "live/large-tree", "live/subviewports-always-updating", "live/many-canvas-items", "live/far-from-origin", "live/trimesh-colliders"]) assert.ok(ids.includes(id), id);
  assert.equal(loud.find((f) => f.id === "live/no-visibility-range").fix.fix, "policy");
  assert.match(loud.find((f) => f.id === "live/uncompressed-textures").detail, /made at run time/);
  assert.equal(loud.find((f) => f.id === "live/repeated-mesh-nodes").metric.scripts[0], "res://world/chunk_world.gd");
  assert.equal(loud[0].severity, "high");
});

test("policy fix: file, settings, autoload; undo takes it back", () => {
  const d = demo({ procedural: true });
  try {
    const before = snapshot(d.dir);
    const r = call("optimizer_fix", { project: d.dir, fix: "policy", pixels: 8 });
    assert.equal(r.result.autoload_added, true);
    assert.equal(JSON.parse(read(d.dir, "addons/gameoptimizer/world_policy.json")).pixels, 8);
    assert.match(read(d.dir, "project.godot"), /GOWorldPolicy="\*res:\/\/addons\/gameoptimizer\/go_world_policy.gd"/);
    assert.equal(call("optimizer_fix", { project: d.dir, fix: "policy", pixels: 8 }).files_changed.length, 0);
    call("optimizer_undo", { project: d.dir });
    assert.deepEqual(snapshot(d.dir), before);
  } finally {
    d.cleanup();
  }
});

test("script rules from large code-built games", async () => {
  const d = demo({ procedural: true });
  try {
    writeFileSync(join(d.dir, "world/bad.gd"), `extends Node\nvar t := 0.0\nvar label: Label\n\nfunc _process(delta: float) -> void:\n\tt += delta\n\tlabel.text = str(t)\n\tif int(t * 2.0) % 4 == 0:\n\t\tvar sun := get_tree().root.find_child("Sun", true, false)\n\tif Engine.get_frames_drawn() % 30 == 0:\n\t\tpass\n\nfunc a() -> void:\n\tvar w := get_tree().root.find_children("*", "Light3D")\n\tvar e := get_tree().current_scene.find_child("Weather")\n`);
    const ids = new Map(call("optimizer_audit", { project: d.dir, detail: "full" }).findings.map((f) => [f.id, f]));
    assert.equal(ids.get("script/time-window-modulo").metric.places, 1, "a frame counter modulo is fine, a time window is not");
    assert.ok(ids.has("script/text-set-every-frame"));
    assert.equal(ids.get("script/whole-tree-search").severity, "high");
    assert.equal(ids.get("script/whole-tree-search").metric.places, 3);
    assert.ok(ids.has("script/mesh-node-per-object") && ids.has("script/material-per-object"), "the builder script is found");
  } finally {
    d.cleanup();
  }
});

test("textures: a Radiance .hdr and an OpenEXR .exr file are listed with their real size and HDR memory (#6)", () => {
  const d = demo();
  try {
    writeFileSync(join(d.dir, "textures/sky.hdr"), "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 512 +X 1024\n");
    writeFileSync(join(d.dir, "textures/light.exr"), exrHeader(512, 256));
    const list = call("optimizer_textures", { project: d.dir, limit: 100 }).largest;
    const byFile = new Map(list.map((t) => [t.file, t]));
    assert.equal(byFile.get("textures/sky.hdr")?.size, "1024x512");
    assert.equal(byFile.get("textures/light.exr")?.size, "512x256");
    // 8 bytes per pixel uncompressed, as vramBytes() already did for hdr: true.
    assert.equal(byFile.get("textures/sky.hdr").vram_mb, 4);
    assert.equal(byFile.get("textures/light.exr").vram_mb, 1);
  } finally {
    d.cleanup();
  }
});
