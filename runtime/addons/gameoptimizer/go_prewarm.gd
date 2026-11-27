class_name GOPrewarm
extends Node
## Compiles render pipelines behind a loading screen, so the first time a material is seen in play does not
## stutter. Draws every unique mesh surface + material pairing (also as shadow caster, and as MultiMesh when
## the scene uses it that way) for a few frames, tiny, in front of the current camera; without a 3D camera it
## draws into a small SubViewport of its own.
##
##     var prewarm := GOPrewarm.new()
##     add_child(prewarm)
##     await prewarm.run(["res://world/chunks/c_0_0.tscn", some_node, some_packed_scene])

signal progress(done: int, total: int)
signal finished()

## Pairings drawn per frame.
@export var batch_size: int = 12
## Frames each batch stays on screen.
@export var frames_per_batch: int = 2
## Draw into an own SubViewport even when there is a camera. Pipelines depend on the target's format, so the
## main viewport (default) warms exactly what the game will use.
@export var force_sub_viewport: bool = false

var _jobs: Array[Dictionary] = []
var _seen: Dictionary = {}
var _running: bool = false


## Collects from scenes: an Array (or one) of res:// paths, PackedScenes or Nodes. Returns the number of
## pairings found so far.
func prewarm_scene(sources: Variant) -> int:
	var list: Array = sources if sources is Array else [sources]
	for source: Variant in list:
		if source is PackedStringArray:
			prewarm_scene(Array(source as PackedStringArray))
		elif source is String or source is StringName:
			var packed := ResourceLoader.load(str(source), "PackedScene") as PackedScene
			if packed == null:
				push_warning("GOPrewarm: %s is not a scene" % str(source))
				continue
			_collect_packed(packed)
		elif source is PackedScene:
			_collect_packed(source as PackedScene)
		elif source is Node:
			_collect(source as Node)
	return _jobs.size()


## Collects materials to warm on a plain quad (for materials that are assigned by code later).
func prewarm_materials(materials: Array) -> int:
	var quad := QuadMesh.new()
	for material: Variant in materials:
		if material is Material:
			_add_job(quad, 0, material as Material, false, true)
	return _jobs.size()


## Collects from `root_or_paths` (see prewarm_scene; null: only what was collected before) and draws it all.
## Await it: it returns when every pipeline had its frames.
func run(root_or_paths: Variant = null) -> void:
	if root_or_paths != null:
		prewarm_scene(root_or_paths)
	if _running:
		await finished
		return
	_running = true
	var total := _jobs.size()
	if total == 0 or DisplayServer.get_name() == "headless" or not is_inside_tree():
		_jobs.clear()
		_running = false
		progress.emit(total, total)
		finished.emit()
		return
	var holder := Node3D.new()
	holder.name = "GOPrewarmStage"
	var sub_viewport: SubViewport = null
	var camera := get_viewport().get_camera_3d()
	if camera == null or force_sub_viewport:
		var main := get_viewport()
		sub_viewport = SubViewport.new()
		sub_viewport.size = Vector2i(64, 64)
		sub_viewport.own_world_3d = true
		sub_viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
		sub_viewport.msaa_3d = main.msaa_3d
		sub_viewport.use_taa = main.use_taa
		sub_viewport.screen_space_aa = main.screen_space_aa
		sub_viewport.use_debanding = main.use_debanding
		sub_viewport.scaling_3d_mode = main.scaling_3d_mode
		add_child(sub_viewport)
		var own_camera := Camera3D.new()
		sub_viewport.add_child(own_camera)
		own_camera.current = true
		var sun := DirectionalLight3D.new()
		sun.shadow_enabled = true
		sun.rotation_degrees = Vector3(-50.0, 30.0, 0.0)
		sub_viewport.add_child(sun)
		own_camera.add_child(holder)
		camera = own_camera
	else:
		camera.add_child(holder)
	# Just beyond the near plane, a few centimetres across: drawn, but too small to notice.
	var depth := maxf(camera.near * 4.0, 0.2)
	holder.position = Vector3(0.0, 0.0, -depth)
	var lamp := OmniLight3D.new()
	lamp.shadow_enabled = true
	lamp.omni_range = depth
	lamp.light_energy = 0.01
	lamp.position = Vector3(0.0, depth * 0.3, depth * 0.3)
	holder.add_child(lamp)
	var cell := depth * 0.05
	var done := 0
	while done < total:
		if not is_instance_valid(holder) or not holder.is_inside_tree():
			break
		var drawn: Array[Node] = []
		var count := mini(batch_size, total - done)
		for index: int in count:
			var node := _make_instance(_jobs[done + index], cell)
			var column := index % 4
			var row := index / 4
			node.position += Vector3((column - 1.5) * cell * 1.5, (row - 1.0) * cell * 1.5, 0.0)
			holder.add_child(node)
			drawn.append(node)
		for frame: int in maxi(frames_per_batch, 1):
			await get_tree().process_frame
		for node: Node in drawn:
			if is_instance_valid(node):
				node.queue_free()
		done += count
		progress.emit(done, total)
	if is_instance_valid(holder):
		holder.queue_free()
	if sub_viewport != null and is_instance_valid(sub_viewport):
		sub_viewport.queue_free()
	_jobs.clear()
	_running = false
	finished.emit()


## Number of pairings waiting to be drawn.
func pending() -> int:
	return _jobs.size()


func _collect_packed(packed: PackedScene) -> void:
	var root := packed.instantiate()
	if root == null:
		return
	_collect(root)
	root.free()


func _collect(root: Node) -> void:
	var stack: Array[Node] = [root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		stack.append_array(node.get_children())
		if node is MeshInstance3D:
			var instance := node as MeshInstance3D
			if instance.mesh == null:
				continue
			var shadows := instance.cast_shadow != GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
			for surface: int in instance.mesh.get_surface_count():
				var material := instance.material_override
				if material == null:
					material = instance.get_active_material(surface)
				_add_job(instance.mesh, surface, material, false, shadows)
				if instance.material_overlay != null:
					_add_job(instance.mesh, surface, instance.material_overlay, false, false)
		elif node is MultiMeshInstance3D:
			var multi := node as MultiMeshInstance3D
			if multi.multimesh == null or multi.multimesh.mesh == null:
				continue
			var mesh := multi.multimesh.mesh
			var shadows := multi.cast_shadow != GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
			for surface: int in mesh.get_surface_count():
				var material := multi.material_override
				if material == null:
					material = mesh.surface_get_material(surface)
				_add_job(mesh, surface, material, true, shadows)
		elif node is GPUParticles3D:
			var particles := node as GPUParticles3D
			for pass_index: int in particles.draw_passes:
				var mesh := particles.get_draw_pass_mesh(pass_index)
				if mesh == null:
					continue
				for surface: int in mesh.get_surface_count():
					var material := particles.material_override
					if material == null:
						material = mesh.surface_get_material(surface)
					_add_job(mesh, surface, material, true, false)
		elif node is CSGShape3D or node is GeometryInstance3D:
			var geometry := node as GeometryInstance3D
			if geometry != null and geometry.material_override != null:
				_add_job(QuadMesh.new(), 0, geometry.material_override, false, true)


func _add_job(mesh: Mesh, surface: int, material: Material, multimesh: bool, shadows: bool) -> void:
	# A pipeline is set by the shader, the vertex format and how it is drawn; the mesh itself does not matter.
	var format := 0
	if mesh is ArrayMesh:
		format = (mesh as ArrayMesh).surface_get_format(surface)
	else:
		format = hash(mesh.get_class())
	var key := "%d|%d|%s|%s" % [material.get_rid().get_id() if material != null else 0, format, multimesh, shadows]
	if _seen.has(key):
		return
	_seen[key] = true
	_jobs.append({"mesh": mesh, "surface": surface, "material": material, "multimesh": multimesh, "shadows": shadows})


func _make_instance(job: Dictionary, cell: float) -> GeometryInstance3D:
	var mesh: Mesh = job["mesh"]
	var material: Material = job["material"]
	var box := mesh.get_aabb()
	var longest := maxf(box.get_longest_axis_size(), 0.0001)
	var fit := cell / longest
	var node: GeometryInstance3D = null
	if job["multimesh"]:
		var multi := MultiMesh.new()
		multi.transform_format = MultiMesh.TRANSFORM_3D
		multi.mesh = mesh
		multi.instance_count = 1
		multi.set_instance_transform(0, Transform3D.IDENTITY)
		var multi_node := MultiMeshInstance3D.new()
		multi_node.multimesh = multi
		node = multi_node
	else:
		var mesh_node := MeshInstance3D.new()
		mesh_node.mesh = mesh
		node = mesh_node
	if material != null:
		node.material_override = material
	node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON if job["shadows"] \
			else GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	node.scale = Vector3.ONE * fit
	node.position = -box.get_center() * fit
	node.extra_cull_margin = 16384.0
	return node
