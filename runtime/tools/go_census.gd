extends SceneTree
## Live census: starts a scene of the game, lets it build its world, then counts what is really there.
## For worlds that are built from code, and for games that only exist as a .pck.
##
##   godot --path <project> -s <this file> -- --go-census=/abs/out.json
##   godot --main-pack game.pck -s <this file> -- --go-census=/abs/out.json
##
##   --go-scene=res://x.tscn   scene to start (default: the project's main scene)
##   --go-seconds=20           how long the world gets to build before it is counted (wall clock)
##   --go-frames=120           and at least this many frames
##
## It has no dependencies: one file, any Godot 4.3+ project.

var _out := ""
var _scene := ""
var _seconds := 20.0
var _min_frames := 120
var _frames := 0
var _start_usec := 0
var _started := false
var _done := false
var _error := ""


func _initialize() -> void:
	for arg: String in OS.get_cmdline_user_args():
		if arg.begins_with("--go-census="):
			_out = arg.trim_prefix("--go-census=")
		elif arg.begins_with("--go-scene="):
			_scene = arg.trim_prefix("--go-scene=")
		elif arg.begins_with("--go-seconds="):
			_seconds = float(arg.trim_prefix("--go-seconds="))
		elif arg.begins_with("--go-frames="):
			_min_frames = int(arg.trim_prefix("--go-frames="))
	if _out == "":
		push_error("GOCensus: pass -- --go-census=<file>")
		quit(2)
		return
	if _scene == "":
		_scene = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if _scene == "":
		_error = "no scene: the project has no main scene; pass --go-scene"


func _process(_delta: float) -> bool:
	if _done:
		return true
	if _error != "":
		_write({"version": 1, "error": _error})
		return true
	if not _started:
		_started = true
		_start_usec = Time.get_ticks_usec()
		var err := change_scene_to_file(_scene)
		if err != OK:
			_error = "cannot start %s (error %d)" % [_scene, err]
		return false
	_frames += 1
	var waited := float(Time.get_ticks_usec() - _start_usec) / 1000000.0
	if _frames < _min_frames or waited < _seconds:
		return false
	_write(_census(waited))
	return true


func _write(report: Dictionary) -> void:
	_done = true
	var file := FileAccess.open(_out, FileAccess.WRITE)
	if file == null:
		push_error("GOCensus: cannot write %s" % _out)
	else:
		file.store_string(JSON.stringify(report, " "))
		file.close()
		print("GOCensus: report written to %s" % _out)
	quit(0)


const _MATERIAL_TEXTURES: Array[StringName] = [
	&"albedo_texture", &"normal_texture", &"orm_texture", &"metallic_texture", &"roughness_texture", &"emission_texture",
	&"ao_texture", &"heightmap_texture", &"detail_albedo", &"detail_normal", &"clearcoat_texture", &"rim_texture",
	&"subsurf_scatter_texture", &"backlight_texture", &"refraction_texture", &"anisotropy_flowmap",
]
var _textures := {}


func _collect_textures(material: Material) -> void:
	if material is BaseMaterial3D:
		for name: StringName in _MATERIAL_TEXTURES:
			var value: Variant = material.get(name)
			if value is Texture2D:
				_textures[(value as Texture2D).get_instance_id()] = value
	elif material is ShaderMaterial:
		var shader := (material as ShaderMaterial).shader
		if shader == null:
			return
		for uniform: Dictionary in shader.get_shader_uniform_list():
			if int(uniform.get("type", 0)) != TYPE_OBJECT:
				continue
			var value: Variant = (material as ShaderMaterial).get_shader_parameter(uniform["name"])
			if value is Texture2D:
				_textures[(value as Texture2D).get_instance_id()] = value


func _script_of(node: Node) -> String:
	var script: Variant = node.get_script()
	if script is Script:
		var path := (script as Script).resource_path
		return path if path != "" else "<script built at run time>"
	return ""


func _res_name(res: Resource) -> String:
	if res == null:
		return ""
	if res.resource_path != "" and not res.resource_path.contains("::"):
		return res.resource_path
	if res.resource_path != "":
		return res.resource_path
	return "<%s made at run time>" % res.get_class()


func _bump(table: Dictionary, key: String, by: int = 1) -> void:
	table[key] = int(table.get(key, 0)) + by


func _top(table: Dictionary, limit: int, field: String = "") -> Array:
	var rows: Array = []
	for key: Variant in table:
		rows.append([key, table[key]])
	if field == "":
		rows.sort_custom(func(a: Array, b: Array) -> bool: return int(a[1]) > int(b[1]))
	else:
		rows.sort_custom(func(a: Array, b: Array) -> bool: return float(a[1][field]) > float(b[1][field]))
	var out: Array = []
	for index: int in mini(limit, rows.size()):
		if field == "":
			out.append({"name": rows[index][0], "count": rows[index][1]})
		else:
			out.append(rows[index][1])
	return out


func _census(waited: float) -> Dictionary:
	var by_class := {}
	var by_script := {}
	var by_creator := {}
	var groups := {}
	var mesh_users := {}
	var material_users := {}
	var lights: Array = []
	var light_types := {}
	var bodies := {}
	var shapes := {}
	var viewports: Array = []
	var multimeshes: Array = []
	var nodes := 0
	var processing := 0
	var physics_processing := 0
	var mesh_instances := 0
	var triangles := 0
	var small_no_range := 0
	var small_no_range_tris := 0
	var tiny_casters := 0
	var with_range := 0
	var mm_instances := 0
	var canvas_items := 0
	var controls := 0
	var particles := 0
	var particle_amount := 0
	var trimesh_faces := 0
	var shadow_lights := 0
	var no_fade_lights := 0
	var lo := Vector3(INF, INF, INF)
	var hi := Vector3(-INF, -INF, -INF)
	var camera := root.get_camera_3d()
	var cam_far := camera.far if camera != null else 4000.0
	var fov := camera.fov if camera != null else 75.0
	var k := 1080.0 / (2.0 * tan(deg_to_rad(fov) * 0.5))
	var tri_cache := {}

	# Each node with the script that most likely made it: the nearest ancestor (or itself) that has a script.
	var stack: Array = [[root, ""]]
	while not stack.is_empty():
		var item: Array = stack.pop_back()
		var node: Node = item[0]
		var creator: String = item[1]
		nodes += 1
		_bump(by_class, node.get_class())
		var own := _script_of(node)
		if own != "":
			creator = own
			if not by_script.has(own):
				by_script[own] = {"script": own, "count": 0, "processing": 0, "physics_processing": 0}
			var row: Dictionary = by_script[own]
			row["count"] = int(row["count"]) + 1
			if node.is_processing():
				row["processing"] = int(row["processing"]) + 1
			if node.is_physics_processing():
				row["physics_processing"] = int(row["physics_processing"]) + 1
		if creator != "":
			_bump(by_creator, creator)
		if node.is_processing():
			processing += 1
		if node.is_physics_processing():
			physics_processing += 1
		for child: Node in node.get_children(true):
			stack.push_back([child, creator])

		if node is MeshInstance3D:
			var mi := node as MeshInstance3D
			var mesh := mi.mesh
			if mesh == null:
				continue
			mesh_instances += 1
			var mesh_id := mesh.get_instance_id()
			if not tri_cache.has(mesh_id):
				var tris := 0
				for surface: int in mesh.get_surface_count():
					if mesh is ArrayMesh:
						var arr := mesh as ArrayMesh
						var indices := arr.surface_get_array_index_len(surface)
						tris += (indices if indices > 0 else arr.surface_get_array_len(surface)) / 3
					elif mesh is PrimitiveMesh:
						var arrays := (mesh as PrimitiveMesh).get_mesh_arrays()
						var index: Variant = arrays[Mesh.ARRAY_INDEX]
						tris += (index.size() / 3) if index != null else 0
				tri_cache[mesh_id] = tris
			var tri_count: int = tri_cache[mesh_id]
			triangles += tri_count
			_bump(mesh_users, str(mesh_id))
			var material: Material = mi.material_override
			if material == null and mesh.get_surface_count() > 0:
				material = mi.get_active_material(0)
			if material != null:
				if not material_users.has(str(material.get_instance_id())):
					_collect_textures(material)
				_bump(material_users, str(material.get_instance_id()))
			var box := mi.get_aabb()
			var scale := mi.global_transform.basis.get_scale()
			var radius := box.size.length() * 0.5 * maxf(scale.x, maxf(scale.y, scale.z))
			var pos := mi.global_position
			lo = lo.min(pos)
			hi = hi.max(pos)
			if mi.visibility_range_end > 0.0:
				with_range += 1
			elif radius > 0.0 and (2.0 * radius * k) / 6.0 < cam_far * 0.6:
				small_no_range += 1
				small_no_range_tris += tri_count
			if radius > 0.0 and radius < 0.35 and mi.cast_shadow != GeometryInstance3D.SHADOW_CASTING_SETTING_OFF:
				tiny_casters += 1
			var key := "%d|%d" % [mesh_id, material.get_instance_id() if material != null else 0]
			if not groups.has(key):
				groups[key] = {
					"mesh": _res_name(mesh), "mesh_class": mesh.get_class(), "material": _res_name(material), "count": 0,
					"triangles_each": tri_count, "radius": snappedf(radius, 0.01), "with_range": 0, "weight": 0.0,
					"made_by": creator, "example": str(mi.get_path()),
				}
			var group: Dictionary = groups[key]
			group["count"] = int(group["count"]) + 1
			group["weight"] = float(group["weight"]) + 1500.0 + tri_count
			if mi.visibility_range_end > 0.0:
				group["with_range"] = int(group["with_range"]) + 1
		elif node is MultiMeshInstance3D:
			var mmi := node as MultiMeshInstance3D
			if mmi.multimesh != null:
				var count := mmi.multimesh.instance_count
				mm_instances += count
				multimeshes.append({"path": str(mmi.get_path()), "instances": count, "mesh": _res_name(mmi.multimesh.mesh), "size": snappedf(mmi.get_aabb().size.length(), 0.1), "range": mmi.visibility_range_end, "made_by": creator})
		elif node is Light3D:
			var light := node as Light3D
			_bump(light_types, light.get_class())
			if light.shadow_enabled:
				shadow_lights += 1
			if not (light is DirectionalLight3D) and not light.distance_fade_enabled:
				no_fade_lights += 1
			if lights.size() < 40 and not (light is DirectionalLight3D):
				lights.append({"path": str(light.get_path()), "type": light.get_class(), "shadow": light.shadow_enabled, "distance_fade": light.distance_fade_enabled, "made_by": creator})
		elif node is CollisionObject3D:
			_bump(bodies, node.get_class())
		elif node is CollisionShape3D:
			var shape := (node as CollisionShape3D).shape
			if shape != null:
				_bump(shapes, shape.get_class())
				if shape is ConcavePolygonShape3D:
					trimesh_faces += (shape as ConcavePolygonShape3D).get_faces().size() / 3
		elif node is SubViewport:
			var vp := node as SubViewport
			viewports.append({"path": str(vp.get_path()), "size": [vp.size.x, vp.size.y], "update_mode": vp.render_target_update_mode, "made_by": creator})
		elif node is GPUParticles3D:
			particles += 1
			particle_amount += (node as GPUParticles3D).amount
		elif node is CPUParticles3D:
			particles += 1
			particle_amount += (node as CPUParticles3D).amount
		if node is CanvasItem or node is SpriteBase3D:
			if &"texture" in node:
				var shown: Variant = node.get(&"texture")
				if shown is Texture2D:
					_textures[(shown as Texture2D).get_instance_id()] = shown
		if node is CanvasItem:
			canvas_items += 1
			if node is Control:
				controls += 1

	var meshes_once := 0
	for id: Variant in mesh_users:
		if int(mesh_users[id]) == 1:
			meshes_once += 1
	var materials_once := 0
	for id: Variant in material_users:
		if int(material_users[id]) == 1:
			materials_once += 1

	# Textures: what the materials and 2D nodes that are in the tree refer to. The format tells whether the GPU
	# holds it compressed; the size in memory is worked out from format and size.
	var textures: Array = []
	var texture_bytes := 0
	var uncompressed_bytes := 0
	var uncompressed_count := 0
	var runtime_bytes := 0
	var runtime_count := 0
	for tex: Texture2D in _textures.values():
		var width := tex.get_width()
		var height := tex.get_height()
		var format := -1
		if tex.has_method(&"get_format"):
			format = int(tex.call(&"get_format"))
		var made_at_run_time := tex.resource_path == "" or tex is ImageTexture
		var compressed := format >= Image.FORMAT_DXT1
		var per_pixel := 4.0
		if compressed:
			per_pixel = 0.5 if format == Image.FORMAT_DXT1 else 1.0
		elif format == Image.FORMAT_L8 or format == Image.FORMAT_R8:
			per_pixel = 1.0
		elif format == Image.FORMAT_LA8 or format == Image.FORMAT_RG8:
			per_pixel = 2.0
		elif format >= Image.FORMAT_RF and format < Image.FORMAT_DXT1:
			per_pixel = 8.0
		var bytes := int(float(width * height) * per_pixel * (1.3333 if compressed else 1.0))
		texture_bytes += bytes
		if not compressed and maxi(width, height) >= 512:
			uncompressed_bytes += bytes
			uncompressed_count += 1
			if made_at_run_time:
				runtime_bytes += bytes
				runtime_count += 1
		textures.append({"path": _res_name(tex), "class": tex.get_class(), "size": [width, height], "format": format, "compressed": compressed, "mb": snappedf(float(bytes) / 1048576.0, 0.01), "bytes": bytes})
	textures.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return int(a["bytes"]) > int(b["bytes"]))
	var texture_count := textures.size()
	textures.resize(mini(40, textures.size()))
	multimeshes.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return int(a["instances"]) > int(b["instances"]))
	multimeshes.resize(mini(20, multimeshes.size()))
	viewports.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return int(a["size"][0]) * int(a["size"][1]) > int(b["size"][0]) * int(b["size"][1]))
	viewports.resize(mini(20, viewports.size()))
	var scripts: Array = by_script.values()
	scripts.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return int(a["processing"]) + int(a["physics_processing"]) > int(b["processing"]) + int(b["physics_processing"]))
	scripts.resize(mini(40, scripts.size()))
	var has_extent := lo.x != INF
	return {
		"version": 1,
		"engine": Engine.get_version_info().get("string", ""),
		"renderer": RenderingServer.get_current_rendering_method(),
		"adapter": RenderingServer.get_video_adapter_name(),
		"headless": DisplayServer.get_name() == "headless",
		"scene": _scene,
		"seconds": snappedf(waited, 0.1),
		"frames": _frames,
		"camera": [camera.global_position.x, camera.global_position.y, camera.global_position.z] if camera != null else null,
		"camera_far": cam_far,
		"nodes": nodes,
		"processing": processing,
		"physics_processing": physics_processing,
		"classes": _top(by_class, 30),
		"scripts": scripts,
		"made_by": _top(by_creator, 30),
		"geometry": {
			"mesh_instances": mesh_instances, "triangles": triangles, "unique_meshes": mesh_users.size(), "meshes_used_once": meshes_once,
			"unique_materials": material_users.size(), "materials_used_once": materials_once, "with_range": with_range,
			"small_without_range": small_no_range, "small_without_range_triangles": small_no_range_tris, "tiny_shadow_casters": tiny_casters,
			"multimeshes": multimeshes.size(), "multimesh_instances": mm_instances,
			"groups": _top(groups, 40, "weight"), "largest_multimeshes": multimeshes,
		},
		"lights": {"types": light_types, "shadowed": shadow_lights, "positional_without_fade": no_fade_lights, "examples": lights},
		"physics": {"bodies": bodies, "shapes": shapes, "trimesh_faces": trimesh_faces},
		"textures": {
			"count": texture_count, "mb": snappedf(float(texture_bytes) / 1048576.0, 0.1), "uncompressed_large": uncompressed_count,
			"uncompressed_large_mb": snappedf(float(uncompressed_bytes) / 1048576.0, 0.1), "made_at_run_time": runtime_count,
			"made_at_run_time_mb": snappedf(float(runtime_bytes) / 1048576.0, 0.1), "largest": textures,
		},
		"viewports": viewports,
		"canvas_items": canvas_items,
		"controls": controls,
		"particles": {"systems": particles, "amount": particle_amount},
		"extent": {"min": [lo.x, lo.y, lo.z], "max": [hi.x, hi.y, hi.z], "farthest_from_origin": snappedf(maxf(lo.abs().length(), hi.abs().length()), 1.0)} if has_extent else null,
		"monitors": {
			"fps": Performance.get_monitor(Performance.TIME_FPS), "process_ms": Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0,
			"physics_ms": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0, "objects": Performance.get_monitor(Performance.OBJECT_COUNT),
			"draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME), "objects_drawn": Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME),
			"primitives": Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME), "video_mem_mb": Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED) / 1048576.0,
			"texture_mem_mb": Performance.get_monitor(Performance.RENDER_TEXTURE_MEM_USED) / 1048576.0, "physics_3d_active": Performance.get_monitor(Performance.PHYSICS_3D_ACTIVE_OBJECTS),
		},
	}
