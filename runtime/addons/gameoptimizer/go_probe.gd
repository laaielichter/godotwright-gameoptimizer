extends Node
## Autoload `GOProbe`: measures the game the way a player feels it and writes a JSON report.
## Does nothing at all unless the game is started with `-- --go-probe=<out.json>`.
##
## User arguments (after `--`):
##   --go-probe=<out.json>     turn the probe on and write the report there
##   --go-frames=600           frames to measure
##   --go-warmup=60            frames to run first, unmeasured
##   --go-route=<route.json>   {"mode":"fly"|"stations","speed":30,"stations":[{"pos":[x,y,z],"look_at":[x,y,z]}]}
##   --go-shots=<dir>          save station_000.png ... (stations mode)
##   --go-tier=<name>          GOQuality.apply_tier(name) first
##   --go-wait-settled=1       wait (at most 30 s) until every GOStreamer is settled before measuring

const SETTLE_TIMEOUT_USEC := 30_000_000
const STATION_SETTLE_TIMEOUT_USEC := 10_000_000
const STATION_SETTLE_FRAMES := 8

enum Phase { IDLE, WAIT_SCENE, WARMUP, MEASURE, STATION_SETTLE, STATION_SAMPLE, STATION_SHOT, DONE }

var _out: String = ""
var _frames: int = 600
var _warmup: int = 60
var _shots: String = ""
var _tier: String = ""
var _wait_settled: bool = false
var _mode: String = ""
var _speed: float = 30.0
var _stations: Array[Dictionary] = []

var _phase: Phase = Phase.IDLE
var _camera: Camera3D = null
var _last_usec: int = 0
var _phase_start_usec: int = 0
var _count: int = 0
var _frame_ms: PackedFloat32Array = PackedFloat32Array()
var _process_ms: PackedFloat32Array = PackedFloat32Array()
var _physics_ms: PackedFloat32Array = PackedFloat32Array()
var _positions: PackedVector3Array = PackedVector3Array()
var _loading: PackedInt32Array = PackedInt32Array()
var _compiles: PackedInt32Array = PackedInt32Array()
var _monitors: Dictionary = {}
var _path_lengths: PackedFloat32Array = PackedFloat32Array()
var _path_total: float = 0.0
var _station: int = 0
var _station_count: int = 0
var _station_frames: int = 0
var _station_ms: PackedFloat32Array = PackedFloat32Array()
var _station_draws: float = 0.0
var _station_prims: float = 0.0
var _station_reports: Array[Dictionary] = []
var _compile_infos: PackedInt32Array = PackedInt32Array()
var _last_compiles: int = 0
var _warnings: PackedStringArray = PackedStringArray()


func _ready() -> void:
	set_process(false)
	for arg: String in OS.get_cmdline_user_args():
		if arg.begins_with("--go-probe="):
			_out = arg.trim_prefix("--go-probe=")
		elif arg.begins_with("--go-frames="):
			_frames = maxi(arg.trim_prefix("--go-frames=").to_int(), 1)
		elif arg.begins_with("--go-warmup="):
			_warmup = maxi(arg.trim_prefix("--go-warmup=").to_int(), 0)
		elif arg.begins_with("--go-route="):
			_load_route(arg.trim_prefix("--go-route="))
		elif arg.begins_with("--go-shots="):
			_shots = arg.trim_prefix("--go-shots=")
		elif arg.begins_with("--go-tier="):
			_tier = arg.trim_prefix("--go-tier=")
		elif arg.begins_with("--go-wait-settled="):
			_wait_settled = arg.trim_prefix("--go-wait-settled=") not in ["0", "false", ""]
	if _out == "":
		return
	process_mode = Node.PROCESS_MODE_ALWAYS
	# Measured last in the frame, after every other node.
	process_priority = 1 << 20
	if DisplayServer.get_name() != "headless":
		DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
	Engine.max_fps = 0
	for constant: String in ["RENDERING_INFO_PIPELINE_COMPILATIONS_CANVAS", "RENDERING_INFO_PIPELINE_COMPILATIONS_MESH",
			"RENDERING_INFO_PIPELINE_COMPILATIONS_SURFACE", "RENDERING_INFO_PIPELINE_COMPILATIONS_DRAW",
			"RENDERING_INFO_PIPELINE_COMPILATIONS_SPECIALIZATION"]:
		if ClassDB.class_has_integer_constant(&"RenderingServer", constant):
			_compile_infos.append(ClassDB.class_get_integer_constant(&"RenderingServer", constant))
	if _shots != "":
		DirAccess.make_dir_recursive_absolute(_shots)
	_phase = Phase.WAIT_SCENE
	set_process(true)


func _load_route(path: String) -> void:
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path)) if FileAccess.file_exists(path) else null
	if not (parsed is Dictionary):
		_warnings.append("route %s could not be read; measuring the scene as it is" % path)
		return
	var route: Dictionary = parsed
	_speed = maxf(float(route.get("speed", 30.0)), 0.01)
	var raw: Variant = route.get("stations")
	if raw is Array:
		for entry: Variant in raw:
			if entry is Dictionary and (entry as Dictionary).get("pos") is Array and ((entry as Dictionary)["pos"] as Array).size() >= 3:
				var pos: Array = (entry as Dictionary)["pos"]
				var station := {"pos": Vector3(float(pos[0]), float(pos[1]), float(pos[2])), "has_look": false, "look": Vector3.ZERO}
				var look: Variant = (entry as Dictionary).get("look_at")
				if look is Array and (look as Array).size() >= 3:
					station["has_look"] = true
					station["look"] = Vector3(float((look as Array)[0]), float((look as Array)[1]), float((look as Array)[2]))
				_stations.append(station)
	if _stations.is_empty():
		_warnings.append("route %s has no stations; measuring the scene as it is" % path)
		return
	_mode = "stations" if str(route.get("mode", "fly")) == "stations" else "fly"
	if _mode == "fly":
		if _stations.size() < 2:
			_mode = "stations"
			return
		_path_lengths.append(0.0)
		for index: int in range(1, _stations.size()):
			_path_total += (_stations[index]["pos"] as Vector3).distance_to(_stations[index - 1]["pos"])
			_path_lengths.append(_path_total)


func _streamers() -> Array[Node]:
	var found: Array[Node] = []
	var stack: Array[Node] = [get_tree().root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		# By its methods, not its class: the probe also runs in a project that has only this file.
		if node.has_method("is_settled") and node.has_method("get_stats") and node.has_method("load_manifest"):
			found.append(node)
		else:
			stack.append_array(node.get_children())
	return found


func _streamers_settled() -> bool:
	for node: Node in _streamers():
		if not bool(node.call("is_settled")):
			return false
	return true


func _streamers_loading() -> int:
	var total := 0
	for node: Node in _streamers():
		var stats: Dictionary = node.call("get_stats")
		total += int(stats["loading"]) + int(stats["queued"])
	return total


func _look(from: Vector3, to: Vector3) -> void:
	_camera.global_position = from
	var direction := to - from
	if direction.length_squared() < 0.000001:
		return
	var up := Vector3.UP if absf(direction.normalized().dot(Vector3.UP)) < 0.999 else Vector3.FORWARD
	_camera.look_at(to, up)


func _place_on_path(fraction: float) -> void:
	var distance := clampf(fraction, 0.0, 1.0) * _path_total
	var index := 1
	while index < _path_lengths.size() - 1 and _path_lengths[index] < distance:
		index += 1
	var a: Dictionary = _stations[index - 1]
	var b: Dictionary = _stations[index]
	var span := _path_lengths[index] - _path_lengths[index - 1]
	var t := 0.0 if span <= 0.0 else (distance - _path_lengths[index - 1]) / span
	var pos: Vector3 = (a["pos"] as Vector3).lerp(b["pos"], t)
	if a["has_look"] and b["has_look"]:
		_look(pos, (a["look"] as Vector3).lerp(b["look"], t))
	elif a["has_look"] or b["has_look"]:
		_look(pos, a["look"] if a["has_look"] else b["look"])
	else:
		_look(pos, pos + ((b["pos"] as Vector3) - (a["pos"] as Vector3)))


func _place_at_station(index: int) -> void:
	var station: Dictionary = _stations[index]
	var pos: Vector3 = station["pos"]
	if station["has_look"]:
		_look(pos, station["look"])
	elif index + 1 < _stations.size():
		_look(pos, _stations[index + 1]["pos"])
	else:
		_camera.global_position = pos


func _compile_count() -> int:
	var total := 0
	for info: int in _compile_infos:
		total += RenderingServer.get_rendering_info(info as RenderingServer.RenderingInfo)
	return total


func _sample_monitors() -> void:
	_monitor("draw_calls", RenderingServer.get_rendering_info(RenderingServer.RENDERING_INFO_TOTAL_DRAW_CALLS_IN_FRAME))
	_monitor("primitives", RenderingServer.get_rendering_info(RenderingServer.RENDERING_INFO_TOTAL_PRIMITIVES_IN_FRAME))
	_monitor("objects", RenderingServer.get_rendering_info(RenderingServer.RENDERING_INFO_TOTAL_OBJECTS_IN_FRAME))
	_monitor("video_mem_mb", RenderingServer.get_rendering_info(RenderingServer.RENDERING_INFO_VIDEO_MEM_USED) / 1048576.0)
	_monitor("texture_mem_mb", RenderingServer.get_rendering_info(RenderingServer.RENDERING_INFO_TEXTURE_MEM_USED) / 1048576.0)
	_monitor("buffer_mem_mb", RenderingServer.get_rendering_info(RenderingServer.RENDERING_INFO_BUFFER_MEM_USED) / 1048576.0)
	_monitor("nodes", Performance.get_monitor(Performance.OBJECT_NODE_COUNT))
	_monitor("orphans", Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT))
	_monitor("static_mem_mb", Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0)
	_monitor("physics_active_objects", Performance.get_monitor(Performance.PHYSICS_3D_ACTIVE_OBJECTS))


func _monitor(key: String, value: float) -> void:
	var entry: Variant = _monitors.get(key)
	if entry == null:
		_monitors[key] = {"sum": value, "max": value, "n": 1}
		return
	var stats: Dictionary = entry
	stats["sum"] = float(stats["sum"]) + value
	stats["max"] = maxf(float(stats["max"]), value)
	stats["n"] = int(stats["n"]) + 1


func _record(frame_ms: float) -> void:
	_frame_ms.append(frame_ms)
	_process_ms.append(Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0)
	_physics_ms.append(Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0)
	var camera := _camera if _camera != null else get_viewport().get_camera_3d()
	_positions.append(camera.global_position if camera != null else Vector3.ZERO)
	_loading.append(_streamers_loading())
	var compiles := _compile_count()
	_compiles.append(compiles - _last_compiles)
	_last_compiles = compiles
	_sample_monitors()


func _process(_delta: float) -> void:
	var now := Time.get_ticks_usec()
	var frame_ms := float(now - _last_usec) / 1000.0
	_last_usec = now
	match _phase:
		Phase.WAIT_SCENE:
			if get_tree().current_scene == null:
				return
			if _tier != "":
				var quality := get_node_or_null(^"/root/GOQuality")
				if quality != null:
					quality.call(&"apply_tier", _tier)
				else:
					_warnings.append("--go-tier given but the GOQuality autoload is not there")
			if _mode != "":
				_camera = Camera3D.new()
				_camera.name = "GOProbeCamera"
				var scene_camera := get_viewport().get_camera_3d()
				if scene_camera != null:
					_camera.fov = scene_camera.fov
					_camera.near = scene_camera.near
					_camera.far = scene_camera.far
					_camera.environment = scene_camera.environment
					_camera.attributes = scene_camera.attributes
				get_tree().root.add_child(_camera)
				_camera.make_current()
				if _mode == "fly":
					_place_on_path(0.0)
				else:
					_place_at_station(0)
			_count = 0
			_phase_start_usec = now
			_phase = Phase.WARMUP
		Phase.WARMUP:
			_count += 1
			if _count < _warmup:
				return
			if _wait_settled and not _streamers_settled() and now - _phase_start_usec < SETTLE_TIMEOUT_USEC:
				return
			if _wait_settled and not _streamers_settled():
				_warnings.append("streamers were not settled after 30 s; measured anyway")
			_last_compiles = _compile_count()
			_count = 0
			if _mode == "stations":
				_station_frames = maxi(_frames / _stations.size(), 10)
				_station = 0
				_begin_station(now)
			else:
				_phase = Phase.MEASURE
		Phase.MEASURE:
			_record(frame_ms)
			_count += 1
			if _count >= _frames:
				_finish()
			elif _mode == "fly":
				_place_on_path(float(_count) / float(maxi(_frames - 1, 1)))
		Phase.STATION_SETTLE:
			_count += 1
			if _count < STATION_SETTLE_FRAMES:
				return
			if not _streamers_settled() and now - _phase_start_usec < STATION_SETTLE_TIMEOUT_USEC:
				return
			_count = 0
			_station_ms.clear()
			_station_draws = 0.0
			_station_prims = 0.0
			_last_compiles = _compile_count()
			_phase = Phase.STATION_SAMPLE
		Phase.STATION_SAMPLE:
			_record(frame_ms)
			_station_ms.append(frame_ms)
			_station_draws += RenderingServer.get_rendering_info(RenderingServer.RENDERING_INFO_TOTAL_DRAW_CALLS_IN_FRAME)
			_station_prims += RenderingServer.get_rendering_info(RenderingServer.RENDERING_INFO_TOTAL_PRIMITIVES_IN_FRAME)
			_count += 1
			if _count >= _station_frames:
				_phase = Phase.STATION_SHOT
				_end_station()
		_:
			pass


func _begin_station(now: int) -> void:
	_place_at_station(_station)
	_count = 0
	_phase_start_usec = now
	_phase = Phase.STATION_SETTLE


func _end_station() -> void:
	var report := {
		"index": _station,
		"pos": _vec(_stations[_station]["pos"]),
		"frame_ms": _stats(_station_ms),
		"draw_calls": snappedf(_station_draws / maxf(_station_ms.size(), 1.0), 0.1),
		"primitives": snappedf(_station_prims / maxf(_station_ms.size(), 1.0), 0.1),
	}
	if _shots != "" and DisplayServer.get_name() != "headless":
		await RenderingServer.frame_post_draw
		var texture := get_viewport().get_texture()
		var image := texture.get_image() if texture != null else null
		if image != null and not image.is_empty():
			var file := "station_%03d.png" % _station
			if image.save_png(_shots.path_join(file)) == OK:
				report["shot"] = file
	_station_reports.append(report)
	_station += 1
	if _station >= _stations.size():
		_finish()
	else:
		_last_usec = Time.get_ticks_usec()
		_begin_station(_last_usec)


func _vec(value: Vector3) -> Array:
	return [snappedf(value.x, 0.001), snappedf(value.y, 0.001), snappedf(value.z, 0.001)]


func _stats(values: PackedFloat32Array) -> Dictionary:
	if values.is_empty():
		return {"p50": 0.0, "p95": 0.0, "p99": 0.0, "max": 0.0, "mean": 0.0}
	var sorted := values.duplicate()
	sorted.sort()
	var sum := 0.0
	for value: float in sorted:
		sum += value
	var last := sorted.size() - 1
	return {
		"p50": snappedf(sorted[mini(int(sorted.size() * 0.5), last)], 0.001),
		"p95": snappedf(sorted[mini(int(sorted.size() * 0.95), last)], 0.001),
		"p99": snappedf(sorted[mini(int(sorted.size() * 0.99), last)], 0.001),
		"max": snappedf(sorted[last], 0.001),
		"mean": snappedf(sum / sorted.size(), 0.001),
	}


func _finish() -> void:
	_phase = Phase.DONE
	set_process(false)
	var frame_stats := _stats(_frame_ms)
	var p50: float = frame_stats["p50"]
	# A hitch is a frame the player notices: well above the usual frame, and at least 4 ms longer.
	var threshold := maxf(p50 * 2.0, p50 + 4.0)
	var hitches: Array[Dictionary] = []
	var hitch_count := 0
	for index: int in _frame_ms.size():
		if _frame_ms[index] > threshold:
			hitch_count += 1
			hitches.append({
				"frame": index,
				"ms": snappedf(_frame_ms[index], 0.001),
				"pos": _vec(_positions[index]),
				"streamer_loading": _loading[index],
				"pipeline_compiles": _compiles[index],
			})
	hitches.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return a["ms"] > b["ms"])
	if hitches.size() > 20:
		hitches.resize(20)
	var monitors := {}
	for key: String in _monitors:
		var entry: Dictionary = _monitors[key]
		monitors[key] = {"avg": snappedf(float(entry["sum"]) / float(entry["n"]), 0.01), "max": snappedf(float(entry["max"]), 0.01)}
	var compiles_total := 0
	for value: int in _compiles:
		compiles_total += value
	var streamers: Array[Dictionary] = []
	for node: Node in _streamers():
		var stats: Dictionary = node.call("get_stats")
		stats["path"] = str(node.get_path())
		streamers.append(stats)
	var version := Engine.get_version_info()
	var size := get_viewport().get_visible_rect().size
	var scene := get_tree().current_scene
	var quality := get_node_or_null(^"/root/GOQuality")
	var report := {
		"version": 1,
		"engine": "%d.%d.%d" % [version["major"], version["minor"], version["patch"]],
		"renderer": RenderingServer.get_current_rendering_method(),
		"adapter": RenderingServer.get_video_adapter_name(),
		"resolution": [int(size.x), int(size.y)],
		"scaling_3d_scale": get_viewport().scaling_3d_scale,
		"scene": scene.scene_file_path if scene != null else "",
		"tier": str(quality.call(&"get_tier")) if quality != null else "",
		"mode": _mode if _mode != "" else "scene",
		"frames": _frame_ms.size(),
		"frame_ms": frame_stats,
		"process_ms": _stats(_process_ms),
		"physics_ms": _stats(_physics_ms),
		"hitch_threshold_ms": snappedf(threshold, 0.001),
		"hitch_count": hitch_count,
		"hitches": hitches,
		"pipeline_compiles": compiles_total,
		"monitors": monitors,
		"stations": _station_reports,
		"streamers": streamers,
		"warnings": Array(_warnings),
	}
	var base := _out.get_base_dir()
	if base != "":
		DirAccess.make_dir_recursive_absolute(base)
	var file := FileAccess.open(_out, FileAccess.WRITE)
	if file == null:
		push_error("GOProbe: cannot write %s (error %d)" % [_out, FileAccess.get_open_error()])
	else:
		file.store_string(JSON.stringify(report, "\t"))
		file.close()
		print("GOProbe: report written to ", _out)
	get_tree().quit()
