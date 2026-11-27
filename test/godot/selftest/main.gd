extends Node3D
# Exercises every script of the addon when started with `-- --selftest`.

var _loaded := 0
var _unloaded := 0


func _ready() -> void:
	var world: GOStreamer = $World
	world.chunk_loaded.connect(func(_id: String) -> void: _loaded += 1)
	world.chunk_unloaded.connect(func(_id: String) -> void: _unloaded += 1)
	if "--selftest" in OS.get_cmdline_user_args():
		_selftest.call_deferred()


func _check(ok: bool, what: String) -> void:
	print(("PASS " if ok else "FAIL ") + what)


func _selftest() -> void:
	var world: GOStreamer = $World
	print("tiers: ", GOQuality.tiers(), " auto: ", GOQuality.auto_detect())
	for tier: String in GOQuality.tiers():
		GOQuality.apply_tier(tier)
		await get_tree().process_frame
	_check(GOQuality.get_tier() == "cinematic", "apply_tier walks every tier")
	GOQuality.apply_tier("low")
	var env: Environment = $Env.environment
	_check(not env.ssao_enabled and env.glow_enabled and not env.volumetric_fog_enabled, "low: ssao off, glow kept, fog off")
	_check(not env.ssr_enabled, "tier never enables an effect the scene did not author")
	GOQuality.apply_tier("high")
	_check(env.ssao_enabled and env.volumetric_fog_enabled, "high: authored effects back")
	GOQuality.set_value("scaling_3d_scale", 0.5)
	_check(is_equal_approx(get_viewport().scaling_3d_scale, 0.5), "set_value applies")
	GOQuality.set_override("ssao", false)
	_check(not env.ssao_enabled, "override applies")
	GOQuality.clear_override("ssao")
	_check(env.ssao_enabled, "clear_override restores")
	_check(GOQuality.save() == OK and GOQuality.load_saved() and is_equal_approx(float(GOQuality.get_value("scaling_3d_scale")), 0.5), "save/load_saved")
	GOQuality.set_value("ssr", "on")
	_check(env.ssr_enabled, "\"on\" forces an effect")
	GOQuality.apply_tier("high")

	while not world.is_settled():
		await get_tree().process_frame
	var first := world.get_loaded_ids().size()
	_check(first > 0 and first < 16, "streamer loads only what is near (%d of 16)" % first)
	print("stats: ", world.get_stats())
	var node := world.get_chunk_node(world.get_loaded_ids()[0])
	_check(node != null and node.get_parent() == world and node.get_child_count() == 40, "chunk root is a child with all 40 children")
	GOQuality.set_value("lod_bias", 0.5)
	var mesh: MeshInstance3D = node.get_child(0)
	_check(is_equal_approx(mesh.visibility_range_end, 40.0), "lod_bias 0.5 halves visibility range")
	GOQuality.set_value("lod_bias", 1.0)
	_check(is_equal_approx(mesh.visibility_range_end, 80.0), "lod_bias 1.0 restores it")
	GOQuality.set_value("lod_bias", 2.0)

	$Cam.position = Vector3(112, 6, 112)
	await get_tree().process_frame
	await get_tree().process_frame
	while not world.is_settled():
		await get_tree().process_frame
	_check(_unloaded > 0 and world.get_chunk_node("c_0_0") == null and world.get_chunk_node("c_3_3") != null, "moving unloads the old chunks and loads new ones")
	var far: MeshInstance3D = world.get_chunk_node("c_3_3").get_child(0)
	_check(is_equal_approx(far.visibility_range_end, 160.0), "new chunks get the current lod_bias")
	_check(world.get_node_or_null("c_0_0_lod") != null and world.get_node_or_null("c_3_3_lod") == null, "far chunks show their stand-in, loaded ones do not")
	world.threaded_instantiate = true
	$Cam.position = Vector3(16, 6, 16)
	await get_tree().process_frame
	await get_tree().process_frame
	while not world.is_settled():
		await get_tree().process_frame
	_check(world.get_chunk_node("c_0_0") != null and world.get_chunk_node("c_0_0").get_child_count() == 40, "threaded_instantiate loads chunks")
	world.load_all_blocking()
	_check(world.get_loaded_ids().size() == 16, "load_all_blocking loads all 16")
	print("stats: ", world.get_stats())

	var holder := Node3D.new()
	add_child(holder)
	var called := [0]
	for index: int in 50:
		GOSpawnQueue.add(holder, MeshInstance3D.new(), func(_n: Node) -> void: called[0] += 1)
	GOSpawnQueue.add(holder, load("res://world/chunks/c_1_1_lod.tscn"))
	GOSpawnQueue.instantiate_async("res://world/chunks/c_2_2_lod.tscn", holder, func(_n: Node) -> void: called[0] += 1)
	while GOSpawnQueue.pending() > 0:
		await get_tree().process_frame
	_check(holder.get_child_count() == 52 and called[0] == 51, "spawn queue adds everything and calls back")

	var prewarm := GOPrewarm.new()
	add_child(prewarm)
	var seen := [0, 0]
	prewarm.progress.connect(func(done: int, total: int) -> void:
		seen[0] = done
		seen[1] = total)
	prewarm.prewarm_materials([StandardMaterial3D.new()])
	await prewarm.run(["res://world/chunks/c_0_0.tscn", world])
	_check(seen[1] > 2 and seen[0] == seen[1] and prewarm.pending() == 0, "prewarm drew %d pairings" % seen[1])
	prewarm.force_sub_viewport = true
	await prewarm.run("res://world/chunks/c_0_1.tscn")
	_check(get_viewport().get_camera_3d() == $Cam, "prewarm leaves the camera alone")
	prewarm.queue_free()

	GOGovernor.interval = 0.1
	GOGovernor.ladder_delay = 0.3
	GOGovernor.start(100000.0)
	for index: int in 120:
		await get_tree().process_frame
	var state := GOGovernor.get_state()
	print("governor (impossible target): ", state)
	_check(float(state["scale"]) <= 0.5 + 0.001 and int(state["level"]) > 0, "governor lowers the scale, then steps down the ladder")
	GOGovernor.stop()
	GOGovernor.start(0.5)
	for index: int in 150:
		await get_tree().process_frame
	state = GOGovernor.get_state()
	print("governor (easy target): ", state)
	_check(float(state["scale"]) > 0.5, "governor raises the scale when there is headroom")
	GOGovernor.stop()
	_check(env.ssao_enabled, "stop() restores the ladder")
	print("SELFTEST DONE")
	get_tree().quit()
