class_name GOStreamer
extends Node3D
## World streaming: loads the chunks of a world around the camera on loader threads and puts them in the tree
## a slice per frame, so flying through a big world never stalls on a load.
##
## The manifest (JSON) lists the chunks; all coordinates are in this node's local space:
## {"version":1,"cell_size":64,"load_radius":192,"unload_radius":256,"chunks":[
##   {"id":"c_0_0","scene":"res://world/chunks/c_0_0.tscn","center":[x,y,z],"aabb":[minx,miny,minz,maxx,maxy,maxz],
##    "lod_scene":"res://... (optional far stand-in)","lod_radius":900,"cost":123,
##    "load_radius":600,"unload_radius":700 (optional, for this chunk only)}]}
## The node may have ordinary children of its own; the streamer only touches the chunks it loaded.
## A loaded chunk's root becomes a direct child of this node, named after the chunk id, with its own transform.

signal chunk_loaded(id: String)
signal chunk_unloaded(id: String)
## Emitted when everything in range is loaded and nothing is left to load, attach or free.
signal settled()

enum { UNLOADED, LOADING, ATTACHING, LOADED, UNLOADING }

## JSON manifest of the chunks.
@export_file("*.json") var manifest_path: String = ""
## Chunks whose box is nearer than this are loaded. 0: the manifest's value.
@export var load_radius: float = 0.0
## Loaded chunks farther than this are freed. 0: the manifest's value. Keep it above load_radius (hysteresis).
@export var unload_radius: float = 0.0
## Milliseconds per frame the streamer may spend attaching and freeing nodes.
@export var frame_budget_ms: float = 2.0
## Scenes loading at the same time.
@export var max_concurrent_loads: int = 3
## Load chunks ahead of the movement first, and start on the ones the target reaches within look_ahead_seconds.
@export var predictive: bool = true
@export var look_ahead_seconds: float = 2.0
## Node3D the world loads around. Empty: the viewport's current Camera3D.
@export var target: NodePath = NodePath("")
## Build each chunk's nodes on a worker thread instead of the main thread. Faster frames while loading; leave
## it off when chunk scenes hold nodes whose scripts touch the scene tree or other nodes in _init.
@export var threaded_instantiate: bool = false
## Start streaming when the node enters the tree.
@export var autostart: bool = true

var cell_size: float = 64.0

var _chunks: Array[Dictionary] = []
var _by_id: Dictionary = {}
var _active: bool = false
var _settled: bool = false
var _has_focus_override: bool = false
var _focus_override: Vector3 = Vector3.ZERO
var _last_focus: Vector3 = Vector3.ZERO
var _has_last_focus: bool = false
var _velocity: Vector3 = Vector3.ZERO
var _queue: Array[Dictionary] = []
var _loading_count: int = 0
var _attaching: Array[Dictionary] = []
var _freeing: Array[Node] = []
var _lod_loading: Array[Dictionary] = []
var _last_attach_ms: float = 0.0
var _max_attach_ms: float = 0.0
var _max_instantiate_ms: float = 0.0
var _loads_total: int = 0
var _unloads_total: int = 0


func _ready() -> void:
	if manifest_path != "":
		load_manifest(manifest_path)
	if autostart:
		start()


## Reads a manifest. Chunks that are loaded stay until they fall out of range.
func load_manifest(path: String) -> bool:
	if not FileAccess.file_exists(path):
		push_error("GOStreamer: manifest %s not found" % path)
		return false
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	if not (parsed is Dictionary) or not ((parsed as Dictionary).get("chunks") is Array):
		push_error("GOStreamer: %s is not a chunk manifest" % path)
		return false
	var manifest: Dictionary = parsed
	manifest_path = path
	cell_size = float(manifest.get("cell_size", 64.0))
	if load_radius <= 0.0:
		load_radius = float(manifest.get("load_radius", cell_size * 3.0))
	if unload_radius <= 0.0:
		unload_radius = float(manifest.get("unload_radius", load_radius + cell_size))
	unload_radius = maxf(unload_radius, load_radius)
	_chunks.clear()
	_by_id.clear()
	for entry: Variant in manifest["chunks"]:
		if not (entry is Dictionary):
			continue
		var data: Dictionary = entry
		var center := _vec3(data.get("center"), Vector3.ZERO)
		var box := AABB(center, Vector3.ZERO)
		var raw: Variant = data.get("aabb")
		if raw is Array and (raw as Array).size() >= 6:
			var numbers: Array = raw
			var low := Vector3(float(numbers[0]), float(numbers[1]), float(numbers[2]))
			var high := Vector3(float(numbers[3]), float(numbers[4]), float(numbers[5]))
			box = AABB(low, high - low).abs()
		else:
			box = AABB(center - Vector3.ONE * cell_size * 0.5, Vector3.ONE * cell_size)
		var chunk := {
			"id": str(data.get("id", "chunk_%d" % _chunks.size())),
			"scene": str(data.get("scene", "")),
			"aabb": box,
			"lod_scene": str(data.get("lod_scene", "")),
			"lod_radius": float(data.get("lod_radius", 0.0)),
			"load_radius": float(data.get("load_radius", 0.0)),
			"unload_radius": float(data.get("unload_radius", 0.0)),
			"state": UNLOADED,
			"node": null,
			"lod_node": null,
			"lod_state": UNLOADED,
			"wanted": false,
			"priority": 0.0,
			"task": -1,
			"built": null,
		}
		_chunks.append(chunk)
		_by_id[chunk["id"]] = chunk
	_settled = false
	return true


func start() -> void:
	_active = true
	set_process(true)


## Stops loading and unloading; what is loaded stays.
func stop() -> void:
	_active = false


## Streams around this position (in this node's local space) instead of the target node. See clear_focus().
func set_focus_position(local_position: Vector3) -> void:
	_has_focus_override = true
	_focus_override = local_position


func clear_focus() -> void:
	_has_focus_override = false


## True when everything in range is in the tree and no work is left.
func is_settled() -> bool:
	return _settled


## Ids of the chunks that are fully loaded.
func get_loaded_ids() -> PackedStringArray:
	var ids := PackedStringArray()
	for chunk: Dictionary in _chunks:
		if chunk["state"] == LOADED:
			ids.append(chunk["id"])
	return ids


## The root node of a loaded chunk, or null.
func get_chunk_node(id: String) -> Node:
	var chunk: Variant = _by_id.get(id)
	if chunk is Dictionary and (chunk as Dictionary)["state"] == LOADED:
		return (chunk as Dictionary)["node"]
	return null


func get_stats() -> Dictionary:
	var loaded := 0
	var lods := 0
	for chunk: Dictionary in _chunks:
		if chunk["state"] == LOADED:
			loaded += 1
		if chunk["lod_state"] == LOADED:
			lods += 1
	return {
		"chunks": _chunks.size(),
		"loaded": loaded,
		"loading": _loading_count + _attaching.size(),
		"queued": _queue.size(),
		"unloading": _freeing.size(),
		"lod_proxies": lods,
		"last_attach_ms": _last_attach_ms,
		"max_attach_ms": _max_attach_ms,
		"max_instantiate_ms": _max_instantiate_ms,
		"loads_total": _loads_total,
		"unloads_total": _unloads_total,
		"settled": _settled,
	}


## Loads every chunk now, on this thread, without a budget. For baking, tests and tools; not for gameplay.
func load_all_blocking() -> void:
	for chunk: Dictionary in _chunks:
		if chunk["state"] == LOADED:
			continue
		if chunk["state"] == LOADING and int(chunk["task"]) >= 0:
			WorkerThreadPool.wait_for_task_completion(int(chunk["task"]))
			chunk["task"] = -1
		var root: Node = chunk["built"] if chunk["built"] is Node else null
		chunk["built"] = null
		if chunk["state"] == ATTACHING:
			for job: Dictionary in _attaching:
				if job["chunk"] == chunk:
					var rest: Array[Node] = job["children"]
					for index: int in range(int(job["at"]), rest.size()):
						(chunk["node"] as Node).add_child(rest[index])
			_attaching = _attaching.filter(func(job: Dictionary) -> bool: return job["chunk"] != chunk)
			_finish_chunk(chunk)
			continue
		if chunk["state"] == LOADING:
			_loading_count -= 1
		if root == null:
			# Takes over a threaded load that is under way, or loads from scratch.
			var packed: PackedScene = null
			if ResourceLoader.load_threaded_get_status(chunk["scene"]) != ResourceLoader.THREAD_LOAD_INVALID_RESOURCE:
				packed = ResourceLoader.load_threaded_get(chunk["scene"]) as PackedScene
			else:
				packed = ResourceLoader.load(chunk["scene"], "PackedScene") as PackedScene
			if packed == null:
				push_error("GOStreamer: cannot load chunk %s (%s)" % [chunk["id"], chunk["scene"]])
				chunk["state"] = UNLOADED
				continue
			root = packed.instantiate()
		root.name = chunk["id"]
		add_child(root)
		chunk["node"] = root
		_finish_chunk(chunk)
	_queue.clear()


func _vec3(value: Variant, fallback: Vector3) -> Vector3:
	if value is Array and (value as Array).size() >= 3:
		var numbers: Array = value
		return Vector3(float(numbers[0]), float(numbers[1]), float(numbers[2]))
	return fallback


func _focus() -> Variant:
	if _has_focus_override:
		return _focus_override
	var node: Node3D = null
	if not target.is_empty():
		node = get_node_or_null(target) as Node3D
	if node == null:
		var viewport := get_viewport()
		if viewport != null:
			node = viewport.get_camera_3d()
	if node == null:
		return null
	return to_local(node.global_position)


## Distance from a point to a box (0 inside it).
func _distance(box: AABB, point: Vector3) -> float:
	var nearest := point.clamp(box.position, box.end)
	return nearest.distance_to(point)


func _process(delta: float) -> void:
	if _active:
		var focus: Variant = _focus()
		if focus != null:
			_update_wanted(focus, delta)
		_start_loads()
	_poll_loads()
	_spend_budget()
	var now_settled := _active and _has_last_focus and _queue.is_empty() and _loading_count == 0 \
			and _attaching.is_empty() and _freeing.is_empty() and _lod_loading.is_empty()
	if now_settled and not _settled:
		_settled = true
		settled.emit()
	elif not now_settled:
		_settled = false


func _update_wanted(focus: Vector3, delta: float) -> void:
	if _has_last_focus and delta > 0.0:
		var moved := (focus - _last_focus) / delta
		# A teleport is not a speed.
		_velocity = Vector3.ZERO if moved.length() > load_radius * 20.0 else _velocity.lerp(moved, 0.2)
	_last_focus = focus
	_has_last_focus = true
	var ahead := focus + _velocity * look_ahead_seconds if predictive else focus
	_queue.clear()
	for chunk: Dictionary in _chunks:
		var box: AABB = chunk["aabb"]
		var near := _distance(box, focus)
		var near_ahead := _distance(box, ahead) if predictive else near
		var reach := minf(near, near_ahead)
		var state: int = chunk["state"]
		# A chunk may bring its own radii (layers: detail near, large objects far).
		var load_at: float = chunk["load_radius"] if chunk["load_radius"] > 0.0 else load_radius
		var unload_at: float = chunk["unload_radius"] if chunk["unload_radius"] > 0.0 else unload_radius
		if chunk["load_radius"] > 0.0 and chunk["unload_radius"] <= 0.0:
			unload_at = load_at + maxf(unload_radius - load_radius, 0.0)
		unload_at = maxf(unload_at, load_at)
		var wanted := reach <= load_at
		if state == LOADED or state == ATTACHING or state == LOADING:
			wanted = reach <= unload_at
		chunk["wanted"] = wanted
		# What lies ahead comes first; of two chunks equally far, the one being approached wins.
		chunk["priority"] = near * 0.5 + near_ahead * 0.5
		if wanted and state == UNLOADED and chunk["scene"] != "":
			_queue.append(chunk)
		elif not wanted and state == LOADED:
			_unload(chunk)
		_update_lod(chunk, near)
	if _queue.size() > 1:
		_queue.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return a["priority"] < b["priority"])


func _update_lod(chunk: Dictionary, near: float) -> void:
	if chunk["lod_scene"] == "":
		return
	var lod_state: int = chunk["lod_state"]
	var radius: float = chunk["lod_radius"]
	var show: bool = chunk["state"] != LOADED and (radius <= 0.0 or near <= radius)
	# The stand-in stays until the real chunk is fully in the tree, so nothing pops out and in.
	if show and lod_state == UNLOADED:
		if ResourceLoader.load_threaded_request(chunk["lod_scene"], "PackedScene") == OK:
			chunk["lod_state"] = LOADING
			_lod_loading.append(chunk)
	elif not show and lod_state == LOADED:
		var node: Node = chunk["lod_node"]
		if is_instance_valid(node):
			node.queue_free()
		chunk["lod_node"] = null
		chunk["lod_state"] = UNLOADED


func _start_loads() -> void:
	while _loading_count < max_concurrent_loads and not _queue.is_empty():
		var chunk: Dictionary = _queue.pop_front()
		var err := ResourceLoader.load_threaded_request(chunk["scene"], "PackedScene")
		if err != OK:
			push_error("GOStreamer: cannot load chunk %s (%s)" % [chunk["id"], chunk["scene"]])
			chunk["scene"] = ""
			continue
		chunk["state"] = LOADING
		chunk["task"] = -1
		chunk["built"] = null
		_loading_count += 1


func _poll_loads() -> void:
	if _loading_count > 0:
		for chunk: Dictionary in _chunks:
			if chunk["state"] != LOADING:
				continue
			if int(chunk["task"]) >= 0:
				if WorkerThreadPool.is_task_completed(int(chunk["task"])):
					WorkerThreadPool.wait_for_task_completion(int(chunk["task"]))
					chunk["task"] = -1
					_begin_attach(chunk, chunk["built"] as Node)
					chunk["built"] = null
				continue
			var status := ResourceLoader.load_threaded_get_status(chunk["scene"])
			if status == ResourceLoader.THREAD_LOAD_IN_PROGRESS:
				continue
			if status != ResourceLoader.THREAD_LOAD_LOADED:
				push_error("GOStreamer: loading chunk %s failed (%s)" % [chunk["id"], chunk["scene"]])
				chunk["state"] = UNLOADED
				chunk["scene"] = ""
				_loading_count -= 1
				continue
			var packed := ResourceLoader.load_threaded_get(chunk["scene"]) as PackedScene
			if packed == null:
				chunk["state"] = UNLOADED
				chunk["scene"] = ""
				_loading_count -= 1
				continue
			if threaded_instantiate:
				chunk["task"] = WorkerThreadPool.add_task(_build.bind(chunk, packed), false, "GOStreamer instantiate")
			else:
				var start := Time.get_ticks_usec()
				var root := packed.instantiate()
				_max_instantiate_ms = maxf(_max_instantiate_ms, float(Time.get_ticks_usec() - start) / 1000.0)
				_begin_attach(chunk, root)
	var i := 0
	while i < _lod_loading.size():
		var chunk: Dictionary = _lod_loading[i]
		var status := ResourceLoader.load_threaded_get_status(chunk["lod_scene"])
		if status == ResourceLoader.THREAD_LOAD_IN_PROGRESS:
			i += 1
			continue
		_lod_loading.remove_at(i)
		chunk["lod_state"] = UNLOADED
		if status != ResourceLoader.THREAD_LOAD_LOADED:
			push_error("GOStreamer: loading %s failed" % chunk["lod_scene"])
			chunk["lod_scene"] = ""
			continue
		var packed := ResourceLoader.load_threaded_get(chunk["lod_scene"]) as PackedScene
		if packed == null or chunk["state"] == LOADED:
			continue
		var node := packed.instantiate()
		node.name = str(chunk["id"]) + "_lod"
		add_child(node)
		chunk["lod_node"] = node
		chunk["lod_state"] = LOADED


## Runs on a worker thread: builds the nodes of a chunk outside the tree.
func _build(chunk: Dictionary, packed: PackedScene) -> void:
	chunk["built"] = packed.instantiate()


func _begin_attach(chunk: Dictionary, root: Node) -> void:
	_loading_count -= 1
	if root == null:
		chunk["state"] = UNLOADED
		chunk["scene"] = ""
		return
	if not chunk["wanted"]:
		# Out of range again before it arrived.
		chunk["state"] = UNLOADED
		_freeing.append(root)
		return
	# The root goes into the tree empty; its children follow a slice per frame.
	var children: Array[Node] = []
	for child: Node in root.get_children():
		children.append(child)
	for child: Node in children:
		root.remove_child(child)
		child.owner = null
	root.name = chunk["id"]
	chunk["node"] = root
	chunk["state"] = ATTACHING
	add_child(root)
	_attaching.append({"chunk": chunk, "children": children, "at": 0})


func _finish_chunk(chunk: Dictionary) -> void:
	chunk["state"] = LOADED
	_loads_total += 1
	var lod: Variant = chunk["lod_node"]
	if lod is Node and is_instance_valid(lod):
		(lod as Node).queue_free()
	chunk["lod_node"] = null
	if chunk["lod_state"] == LOADED:
		chunk["lod_state"] = UNLOADED
	var quality := get_node_or_null(^"/root/GOQuality")
	if quality != null:
		var bias: Variant = quality.call(&"get_value", "lod_bias")
		if bias != null and not is_equal_approx(float(bias), 1.0):
			GOLod.apply_bias(chunk["node"], float(bias))
	chunk_loaded.emit(chunk["id"])


func _unload(chunk: Dictionary) -> void:
	var node: Variant = chunk["node"]
	chunk["node"] = null
	chunk["state"] = UNLOADED
	_unloads_total += 1
	if node is Node and is_instance_valid(node):
		_freeing.append(node)
	chunk_unloaded.emit(chunk["id"])


func _spend_budget() -> void:
	if _attaching.is_empty() and _freeing.is_empty():
		return
	var start := Time.get_ticks_usec()
	var budget := int(maxf(frame_budget_ms, 0.1) * 1000.0)
	while not _attaching.is_empty():
		var job: Dictionary = _attaching[0]
		var chunk: Dictionary = job["chunk"]
		var children: Array[Node] = job["children"]
		var root: Node = chunk["node"]
		var at: int = job["at"]
		while at < children.size():
			root.add_child(children[at])
			at += 1
			if Time.get_ticks_usec() - start >= budget:
				break
		job["at"] = at
		if at >= children.size():
			_attaching.pop_front()
			if chunk["wanted"] or not _active:
				_finish_chunk(chunk)
			else:
				chunk["node"] = null
				chunk["state"] = UNLOADED
				_freeing.append(root)
		if Time.get_ticks_usec() - start >= budget:
			break
	# Freeing a big subtree in one go is a hitch of its own: take it apart child by child.
	while not _freeing.is_empty() and Time.get_ticks_usec() - start < budget:
		var node: Node = _freeing[0]
		if not is_instance_valid(node):
			_freeing.pop_front()
			continue
		var count := node.get_child_count()
		if count == 0:
			_freeing.pop_front()
			if node.is_inside_tree():
				node.queue_free()
			else:
				node.free()
			continue
		var child := node.get_child(count - 1)
		node.remove_child(child)
		child.free()
	_last_attach_ms = float(Time.get_ticks_usec() - start) / 1000.0
	_max_attach_ms = maxf(_max_attach_ms, _last_attach_ms)


func _exit_tree() -> void:
	for chunk: Dictionary in _chunks:
		if int(chunk["task"]) >= 0:
			WorkerThreadPool.wait_for_task_completion(int(chunk["task"]))
			chunk["task"] = -1
		if chunk["built"] is Node:
			(chunk["built"] as Node).free()
			chunk["built"] = null
	for job: Dictionary in _attaching:
		var children: Array[Node] = job["children"]
		for index: int in range(int(job["at"]), children.size()):
			children[index].free()
	_attaching.clear()
	for node: Node in _freeing:
		if is_instance_valid(node) and not node.is_inside_tree():
			node.free()
	_freeing.clear()
