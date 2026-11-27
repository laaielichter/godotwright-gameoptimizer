import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVariant, writeVariant, mulTransform, invertTransform, xformPoint, xformAabb, IDENTITY } from "../src/godot/variant.mjs";
import { ResourceFile, parseSections } from "../src/godot/tscn.mjs";
import { editProjectSettings } from "../src/fix/settings.mjs";
import { encodePng, decodePng } from "../src/png.mjs";
import { imageInfoFromBuffer, vramBytes } from "../src/godot/image.mjs";
import { scanScript, hotFunctions } from "../src/godot/gdscript.mjs";
import { distanceForPixels } from "../src/analyze/world.mjs";

test("variant: values Godot writes", () => {
  assert.deepEqual(parseVariant("Vector3(1, -2.5, 3e2)"), { $: "Vector3", args: [1, -2.5, 300] });
  assert.deepEqual(parseVariant('ExtResource("1_abc")'), { $: "ExtResource", args: ["1_abc"] });
  assert.deepEqual(parseVariant('["a", 2, true, null]'), ["a", 2, true, null]);
  assert.deepEqual(parseVariant('{\n"k": [1, 2],\n"s": &"name"\n}'), { k: [1, 2], s: "name" });
  assert.deepEqual(parseVariant('Array[String](["x"])'), ["x"]);
  assert.equal(parseVariant('"a \\"quoted\\" word"'), 'a "quoted" word');
  assert.deepEqual(parseVariant("PackedFloat32Array(1, 2, 3)").args, [1, 2, 3]);
  assert.equal(parseVariant("-inf"), -Infinity);
  assert.equal(writeVariant("Jolt Physics"), '"Jolt Physics"');
  assert.equal(writeVariant(true), "true");
  assert.equal(writeVariant(4), "4");
});

test("transform math: compose, invert, boxes", () => {
  const t = [0, 0, 2, 0, 2, 0, -2, 0, 0, 10, 5, -3]; // rotated 90 degrees about Y, scaled by 2, moved
  const inv = invertTransform(t);
  const id = mulTransform(t, inv);
  for (let i = 0; i < 12; i++) assert.ok(Math.abs(id[i] - IDENTITY[i]) < 1e-9);
  assert.deepEqual(xformPoint(t, [1, 0, 0]), [10, 5, -5]);
  assert.deepEqual(xformAabb(t, [0, 0, 0, 1, 1, 1]), [10, 5, -5, 12, 7, -3]);
});

const SCENE = `[gd_scene load_steps=3 format=3 uid="uid://abc"]

[ext_resource type="Script" path="res://a.gd" id="1_x"]

[sub_resource type="BoxMesh" id="BoxMesh_1"]
size = Vector3(2, 1, 1)

[node name="Root" type="Node3D"]
script = ExtResource("1_x")
metadata/text = "line one
[not a section]
line three"

[node name="Box" type="MeshInstance3D" parent="." groups=["a", "b"]]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 4, 0, 0)
mesh = SubResource("BoxMesh_1")

[connection signal="ready" from="Box" to="." method="_on"]
`;

test("scene files are read without loss and written back byte for byte", () => {
  const f = new ResourceFile(SCENE);
  assert.equal(f.toString(), SCENE);
  assert.equal(f.nodes.length, 2);
  assert.equal(f.nodes[0].get("metadata/text"), "line one\n[not a section]\nline three");
  assert.deepEqual(f.nodes[1].attrs.groups, ["a", "b"]);
  assert.equal(f.connections.length, 1);
  f.nodes[1].set("visibility_range_end", "120");
  const out = f.toString();
  assert.match(out, /mesh = SubResource\("BoxMesh_1"\)\nvisibility_range_end = 120\n\n\[connection/);
  assert.equal(new ResourceFile(out).nodes[1].get("visibility_range_end"), 120);
});

test("project.godot: settings are added in place, sections stay sorted", () => {
  const text = `; Engine configuration file.\n\nconfig_version=5\n\n[application]\n\nconfig/name="X"\n\n[rendering]\n\nanti_aliasing/quality/msaa_3d=2\n`;
  assert.equal(editProjectSettings(text, {}), text);
  const out = editProjectSettings(text, { "physics/3d/physics_engine": "Jolt Physics", "rendering/occlusion_culling/use_occlusion_culling": true, "autoload/GOQuality": "*res://addons/gameoptimizer/go_quality.gd" });
  const tags = parseSections(out, { ini: true }).map((s) => s.tag);
  assert.deepEqual(tags, ["", "application", "autoload", "physics", "rendering"]);
  assert.match(out, /^; Engine configuration file\./);
  assert.match(out, /\[physics\]\n\n3d\/physics_engine="Jolt Physics"\n/);
  assert.match(out, /anti_aliasing\/quality\/msaa_3d=2\nocclusion_culling\/use_occlusion_culling=true\n/);
  assert.equal(editProjectSettings(out, { "physics/3d/physics_engine": "Jolt Physics" }), out);
});

test("png: encode, decode, header, memory estimate", () => {
  const data = new Uint8Array(4 * 4 * 4).map((_, i) => (i * 37) % 256);
  const png = encodePng(4, 4, data);
  assert.deepEqual([...decodePng(png).data], [...data]);
  const info = imageInfoFromBuffer(png);
  assert.equal(info.width, 4);
  assert.equal(info.alpha, true);
  assert.equal(vramBytes({ width: 1024, height: 1024, alpha: false }, { compressed: false, mipmaps: false }), 4194304);
  assert.equal(vramBytes({ width: 1024, height: 1024, alpha: false }, { compressed: true, mipmaps: false }), 524288);
});

test("gdscript scan: functions, loops, strings and comments", () => {
  const scan = scanScript(`extends Node\n\nfunc _process(delta):\n\tupdate()\n\tvar s = "get_node( in a string"  # get_node( in a comment\n\nfunc update():\n\tfor i in 100:\n\t\tvar m = MeshInstance3D.new()\n\tfor j in range(3):\n\t\tprint(j)\n\nfunc cold():\n\tpass\n`);
  assert.deepEqual([...hotFunctions(scan)].sort(), ["_process", "update"]);
  const line = scan.lines.find((l) => l.code.includes("MeshInstance3D.new"));
  assert.equal(line.loopDepth, 1);
  assert.equal(line.smallLoop, false);
  assert.equal(scan.lines.find((l) => l.code.includes("print(j)")).smallLoop, true);
  assert.ok(!scan.lines[4].code.includes("get_node("));
});

test("visibility distance follows the size on screen", () => {
  assert.ok(Math.abs(distanceForPixels(1, 6) - 234.6) < 1);
  assert.ok(distanceForPixels(0.1, 6) < 30);
  assert.equal(distanceForPixels(2, 6), 2 * distanceForPixels(1, 6));
});
