// Writes a heavy open-world demo project: a 2 km map with forests, villages, street lights and rocks, built the way
// worlds usually start out (one big scene, a node per object, uncompressed textures). It is the project the tests
// and the benchmarks in the README run on, and a place to try the optimizer without risking a real game.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { encodePng } from "./png.mjs";
import { num } from "./godot/variant.mjs";

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function texture(size, base, vary, alpha, seed) {
  const r = rng(seed);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const band = Math.sin(x * 0.19 + Math.sin(y * 0.07) * 3) * 0.5 + 0.5;
      const k = (r() - 0.5) * vary + band * vary * 0.6;
      data[i] = clamp(base[0] + k);
      data[i + 1] = clamp(base[1] + k);
      data[i + 2] = clamp(base[2] + k * 0.8);
      data[i + 3] = alpha ? (r() < 0.82 ? 255 : 0) : 255;
    }
  }
  return encodePng(size, size, data, { alpha });
}
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

function yRot(angle, scale, x, y, z) {
  const c = Math.cos(angle) * scale;
  const s = Math.sin(angle) * scale;
  return `Transform3D(${[c, 0, s, 0, scale, 0, -s, 0, c, x, y, z].map(num).join(", ")})`;
}

const IMPORT = (file, uid) => `[remap]

importer="texture"
type="CompressedTexture2D"
uid="uid://${uid}"
path="res://.godot/imported/${file.split("/").pop()}-${uid}.ctex"
metadata={
"vram_texture": false
}

[deps]

source_file="res://${file}"
dest_files=["res://.godot/imported/${file.split("/").pop()}-${uid}.ctex"]

[params]

compress/mode=0
compress/high_quality=false
compress/lossy_quality=0.7
compress/uastc_level=0
compress/rdo_quality_loss=0.0
compress/hdr_compression=1
compress/normal_map=0
compress/channel_pack=0
mipmaps/generate=false
mipmaps/limit=-1
roughness/mode=0
roughness/src_normal=""
process/channel_remap/red=0
process/channel_remap/green=1
process/channel_remap/blue=2
process/channel_remap/alpha=3
process/fix_alpha_border=true
process/premult_alpha=false
process/normal_map_invert_y=false
process/hdr_as_srgb=false
process/hdr_clamp_exposure=false
process/size_limit=0
detect_3d/compress_to=1
`;

export function writeDemoWorld(dir, { trees = 6000, rocks = 2500, houses = 500, lamps = 260, fences = 1500, extent = 2000, seed = 7, textureSize = 1024, force = false } = {}) {
  if (existsSync(join(dir, "project.godot")) && !force) throw new Error(`${dir} already holds a Godot project (pass force to overwrite)`);
  const r = rng(seed);
  const put = (file, content) => {
    const p = join(dir, file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  put(
    "project.godot",
    `; Engine configuration file.
; It's best edited using the editor UI and not directly,
; since the parameters that go here are not all obvious.
;
; Format:
;   [section] ; section goes between []
;   param=value ; assign values to parameters

config_version=5

[application]

config/name="Open World Demo"
run/main_scene="res://world/world.tscn"
config/features=PackedStringArray("4.7", "Forward Plus")

[display]

window/size/viewport_width=1920
window/size/viewport_height=1080
window/vsync/vsync_mode=0

[rendering]

anti_aliasing/quality/msaa_3d=2
`,
  );
  const tex = [
    ["textures/bark.png", [92, 68, 44], 50, false],
    ["textures/leaves.png", [52, 110, 46], 70, true],
    ["textures/brick.png", [150, 84, 66], 46, false],
    ["textures/roof.png", [84, 60, 56], 36, false],
    ["textures/ground.png", [88, 112, 66], 40, false],
    ["textures/rock.png", [120, 118, 112], 50, false],
    ["textures/wood.png", [130, 98, 60], 44, false],
  ];
  tex.forEach(([file, base, vary, alpha], i) => {
    put(file, texture(textureSize, base, vary, alpha, 100 + i));
    put(file + ".import", IMPORT(file, `demo${String(i).padStart(2, "0")}tex${seed}`));
  });
  const mat = (name, file, extra = "") =>
    put(`materials/${name}.tres`, `[gd_resource type="StandardMaterial3D" load_steps=2 format=3]\n\n[ext_resource type="Texture2D" path="res://${file}" id="1"]\n\n[resource]\nalbedo_texture = ExtResource("1")\n${extra}`);
  mat("bark", "textures/bark.png", "uv1_scale = Vector3(2, 4, 1)\n");
  mat("leaves", "textures/leaves.png", "transparency = 2\nalpha_scissor_threshold = 0.5\ncull_mode = 2\nuv1_scale = Vector3(4, 4, 1)\n");
  mat("brick", "textures/brick.png", "uv1_triplanar = true\n");
  mat("roof", "textures/roof.png", "uv1_triplanar = true\n");
  mat("ground", "textures/ground.png", "uv1_scale = Vector3(400, 400, 1)\n");
  mat("rock", "textures/rock.png", "uv1_triplanar = true\n");
  mat("wood", "textures/wood.png");

  put(
    "world/house.tscn",
    `[gd_scene load_steps=7 format=3]

[ext_resource type="Material" path="res://materials/brick.tres" id="1"]
[ext_resource type="Material" path="res://materials/roof.tres" id="2"]

[sub_resource type="BoxMesh" id="walls"]
material = ExtResource("1")
size = Vector3(8, 5, 10)

[sub_resource type="PrismMesh" id="roof"]
material = ExtResource("2")
size = Vector3(9, 3, 11)

[sub_resource type="BoxMesh" id="chimney"]
material = ExtResource("1")
size = Vector3(0.8, 2.4, 0.8)

[sub_resource type="BoxShape3D" id="shape"]
size = Vector3(8, 5, 10)

[node name="House" type="StaticBody3D"]

[node name="Walls" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 2.5, 0)
mesh = SubResource("walls")

[node name="Roof" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 6.5, 0)
mesh = SubResource("roof")

[node name="Chimney" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 2.4, 7.4, 2)
mesh = SubResource("chimney")

[node name="Shape" type="CollisionShape3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 2.5, 0)
shape = SubResource("shape")
`,
  );
  put(
    "world/lamp.tscn",
    `[gd_scene load_steps=4 format=3]

[ext_resource type="Material" path="res://materials/wood.tres" id="1"]

[sub_resource type="CylinderMesh" id="post"]
material = ExtResource("1")
top_radius = 0.07
bottom_radius = 0.1
height = 5.0
radial_segments = 12
rings = 1

[sub_resource type="SphereMesh" id="bulb"]
radius = 0.2
height = 0.4
radial_segments = 12
rings = 6

[node name="Lamp" type="Node3D"]

[node name="Post" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 2.5, 0)
mesh = SubResource("post")

[node name="Bulb" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 5.1, 0)
mesh = SubResource("bulb")

[node name="Light" type="OmniLight3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 4.8, 0)
light_color = Color(1, 0.86, 0.62, 1)
light_energy = 3.0
shadow_enabled = true
omni_range = 18.0
`,
  );
  put(
    "world/fly_camera.gd",
    `extends Camera3D
## Free-fly camera: WASD to move, right mouse button to look, Shift to go fast.

@export var speed := 30.0
var _look := Vector2.ZERO


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseMotion and Input.is_mouse_button_pressed(MOUSE_BUTTON_RIGHT):
		_look -= event.relative * 0.003
		_look.y = clampf(_look.y, -1.5, 1.5)
		rotation = Vector3(_look.y, _look.x, 0.0)


func _process(delta: float) -> void:
	var dir := Vector3.ZERO
	if Input.is_key_pressed(KEY_W):
		dir -= basis.z
	if Input.is_key_pressed(KEY_S):
		dir += basis.z
	if Input.is_key_pressed(KEY_A):
		dir -= basis.x
	if Input.is_key_pressed(KEY_D):
		dir += basis.x
	var boost := 4.0 if Input.is_key_pressed(KEY_SHIFT) else 1.0
	position += dir * speed * boost * delta
`,
  );
  put(
    "world/day_cycle.gd",
    `extends Node
## Turns the sun slowly. Written the slow way on purpose: the audit should point at it.

@export var day_length := 600.0


func _process(delta: float) -> void:
	var sun := get_node("../Sun") as DirectionalLight3D
	if sun:
		sun.rotate_x(delta * TAU / day_length)
	for lamp in get_tree().get_nodes_in_group("lamps"):
		lamp.visible = sun.rotation.x > -0.2
`,
  );

  // ---- the world scene --------------------------------------------------------------------------------------
  const half = extent / 2;
  const villages = [];
  for (let i = 0; i < 6; i++) villages.push([(r() - 0.5) * extent * 0.8, (r() - 0.5) * extent * 0.8, 60 + r() * 90]);
  const forests = [];
  for (let i = 0; i < 14; i++) forests.push([(r() - 0.5) * extent * 0.92, (r() - 0.5) * extent * 0.92, 60 + r() * 160]);
  const gauss = () => (r() + r() + r() - 1.5) / 1.5;
  const inVillage = (x, z) => villages.some((v) => Math.hypot(x - v[0], z - v[1]) < v[2] * 0.9);
  const L = [];
  L.push(`[gd_scene load_steps=20 format=3]

[ext_resource type="Script" path="res://world/fly_camera.gd" id="cam"]
[ext_resource type="Script" path="res://world/day_cycle.gd" id="day"]
[ext_resource type="PackedScene" path="res://world/house.tscn" id="house"]
[ext_resource type="PackedScene" path="res://world/lamp.tscn" id="lamp"]
[ext_resource type="Material" path="res://materials/bark.tres" id="bark"]
[ext_resource type="Material" path="res://materials/leaves.tres" id="leaves"]
[ext_resource type="Material" path="res://materials/ground.tres" id="ground"]
[ext_resource type="Material" path="res://materials/rock.tres" id="rock"]
[ext_resource type="Material" path="res://materials/wood.tres" id="wood"]

[sub_resource type="ProceduralSkyMaterial" id="skymat"]

[sub_resource type="Sky" id="sky"]
sky_material = SubResource("skymat")

[sub_resource type="Environment" id="env"]
background_mode = 2
sky = SubResource("sky")
tonemap_mode = 2
ssao_enabled = true
glow_enabled = true

[sub_resource type="PlaneMesh" id="groundmesh"]
material = ExtResource("ground")
size = Vector2(${extent + 400}, ${extent + 400})

[sub_resource type="WorldBoundaryShape3D" id="groundshape"]

[sub_resource type="CylinderMesh" id="trunk"]
material = ExtResource("bark")
top_radius = 0.18
bottom_radius = 0.32
height = 6.0
radial_segments = 16
rings = 2

[sub_resource type="SphereMesh" id="crown"]
material = ExtResource("leaves")
radius = 2.6
height = 5.4
radial_segments = 24
rings = 12

[sub_resource type="SphereMesh" id="rockmesh"]
material = ExtResource("rock")
radius = 0.5
height = 0.7
radial_segments = 10
rings = 5

[sub_resource type="BoxMesh" id="fencemesh"]
material = ExtResource("wood")
size = Vector3(2.4, 1.1, 0.08)

[sub_resource type="SphereMesh" id="pebble"]
material = ExtResource("rock")
radius = 0.12
height = 0.16
radial_segments = 8
rings = 4

[node name="World" type="Node3D"]

[node name="Environment" type="WorldEnvironment" parent="."]
environment = SubResource("env")

[node name="Sun" type="DirectionalLight3D" parent="."]
transform = Transform3D(0.866, -0.354, 0.354, 0, 0.707, 0.707, -0.5, -0.612, 0.612, 0, 50, 0)
shadow_enabled = true
directional_shadow_max_distance = 250.0

[node name="DayCycle" type="Node" parent="."]
script = ExtResource("day")

[node name="Camera" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.966, 0.259, 0, -0.259, 0.966, ${num(villages[0][0])}, 12, ${num(villages[0][1] + 60)})
current = true
far = 4000.0
script = ExtResource("cam")

[node name="Ground" type="StaticBody3D" parent="."]

[node name="Mesh" type="MeshInstance3D" parent="Ground"]
mesh = SubResource("groundmesh")

[node name="Shape" type="CollisionShape3D" parent="Ground"]
shape = SubResource("groundshape")

[node name="Forest" type="Node3D" parent="."]
`);
  const pad = (i) => String(i).padStart(5, "0");
  for (let i = 0; i < trees; i++) {
    const f = forests[Math.floor(r() * forests.length)];
    let x = f[0] + gauss() * f[2];
    let z = f[1] + gauss() * f[2];
    x = Math.max(-half, Math.min(half, x));
    z = Math.max(-half, Math.min(half, z));
    const s = 0.7 + r() * 0.9;
    const a = r() * Math.PI * 2;
    L.push(`[node name="Trunk${pad(i)}" type="MeshInstance3D" parent="Forest"]\ntransform = ${yRot(a, s, x, 3 * s, z)}\nmesh = SubResource("trunk")\n`);
    L.push(`[node name="Crown${pad(i)}" type="MeshInstance3D" parent="Forest"]\ntransform = ${yRot(a, s, x, 7.2 * s, z)}\nmesh = SubResource("crown")\n`);
  }
  L.push(`[node name="Rocks" type="Node3D" parent="."]\n`);
  for (let i = 0; i < rocks; i++) {
    const x = (r() - 0.5) * extent;
    const z = (r() - 0.5) * extent;
    const big = r() < 0.4;
    const s = big ? 0.6 + r() * 2.2 : 0.6 + r();
    L.push(`[node name="${big ? "Rock" : "Pebble"}${pad(i)}" type="MeshInstance3D" parent="Rocks"]\ntransform = ${yRot(r() * 6.28, s, x, big ? 0.2 * s : 0.05, z)}\nmesh = SubResource("${big ? "rockmesh" : "pebble"}")\n`);
  }
  L.push(`[node name="Town" type="Node3D" parent="."]\n`);
  for (let i = 0; i < houses; i++) {
    const v = villages[i % villages.length];
    const ring = Math.sqrt(r());
    const ang = r() * Math.PI * 2;
    const x = v[0] + Math.cos(ang) * ring * v[2];
    const z = v[1] + Math.sin(ang) * ring * v[2];
    L.push(`[node name="House${pad(i)}" parent="Town" instance=ExtResource("house")]\ntransform = ${yRot(Math.round(r() * 4) * (Math.PI / 2) + (r() - 0.5) * 0.2, 1, x, 0, z)}\n`);
  }
  for (let i = 0; i < lamps; i++) {
    const v = villages[i % villages.length];
    const ang = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * v[2];
    L.push(`[node name="Lamp${pad(i)}" parent="Town" groups=["lamps"] instance=ExtResource("lamp")]\ntransform = ${yRot(0, 1, v[0] + Math.cos(ang) * d, 0, v[1] + Math.sin(ang) * d)}\n`);
  }
  L.push(`[node name="Fences" type="Node3D" parent="."]\n`);
  for (let i = 0; i < fences; i++) {
    const v = villages[i % villages.length];
    const ang = (i / fences) * Math.PI * 2 * villages.length;
    const d = v[2] * (0.95 + (i % 3) * 0.04);
    const x = v[0] + Math.cos(ang) * d;
    const z = v[1] + Math.sin(ang) * d;
    if (!inVillage(x, z) && i % 7 === 0) continue;
    L.push(`[node name="Fence${pad(i)}" type="MeshInstance3D" parent="Fences"]\ntransform = ${yRot(-ang + Math.PI / 2, 1, x, 0.55, z)}\nmesh = SubResource("fencemesh")\n`);
  }
  put("world/world.tscn", L.join("\n"));
  put(".gitignore", ".godot/\n");
  return { dir, trees, rocks, houses, lamps, fences, extent, scene: "world/world.tscn" };
}
