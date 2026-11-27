extends Node
## GOWorldPolicy: culling rules for worlds that are built from code.
##
## A scene file can be optimized on disk. Nodes that scripts create while the game runs cannot: this node gives
## them the same treatment as they enter the tree, a few per frame within a time budget:
##   - a visibility range sized from the object's own box (smaller than `pixels` on screen: not drawn),
##   - no shadows from objects smaller than `shadow_min_radius`,
##   - a distance fade on omni and spot lights, shadows first.
## Nothing that already has a range or a fade is touched. A node in the group "go_keep", or with the meta
## "go_keep", is left alone, and so is everything below a node with that meta.
##
## Use it as an autoload (fix `policy` registers it), or add it yourself: add_child(GOWorldPolicy.new()).
## Settings come from res://addons/gameoptimizer/world_policy.json when it exists.

signal applied(ranges: int, shadows: int, lights: int)

const POLICY_PATH := "res://addons/gameoptimizer/world_policy.json"

@export var enabled := true
## An object is not drawn where it is smaller than this many pixels (at 1080p, with the camera's field of view).
@export var pixels := 6.0
@export var min_range := 30.0
## Objects seen further than this get no range (terrain, large buildings).
@export var max_range := 3600.0
@export var shadow_min_radius := 0.35
## A light's shadow fades out at this many times its range; the light itself at four times that.
@export var light_fade_factor := 8.0
@export var budget_ms := 1.0
## Hysteresis: the share of the range used as margin, so objects do not flicker at the boundary.
@export var margin := 0.08

var _queue: Array[int] = []
var _head := 0
var _ranges := 0
var _shadows := 0
var _lights := 0
var _seen := 0
var _skipped := 0
var _k := 703.0


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_load_policy()
	get_tree().node_added.connect(_on_node_added)
	# What is already there.
	var stack: Array[Node] = [get_tree().root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		_on_node_added(node)
		for child: Node in node.get_children():
			stack.push_back(child)


func _load_policy() -> void:
	if not FileAccess.file_exists(POLICY_PATH):
		return
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(POLICY_PATH))
	if not (parsed is Dictionary):
		return
	var data: Dictionary = parsed
	for key: String in ["enabled", "pixels", "min_range", "max_range", "shadow_min_radius", "light_fade_factor", "budget_ms", "margin"]:
		if data.has(key):
			set(key, data[key])


func _on_node_added(node: Node) -> void:
	if node is GeometryInstance3D or node is Light3D:
		_queue.append(node.get_instance_id())


func _process(_delta: float) -> void:
	if not enabled or _head >= _queue.size():
		return
	var camera := get_viewport().get_camera_3d()
	if camera != null:
		_k = 1080.0 / (2.0 * tan(deg_to_rad(camera.fov) * 0.5))
	var start := Time.get_ticks_usec()
	var budget := int(maxf(budget_ms, 0.05) * 1000.0)
	var ranges := 0
	var shadows := 0
	var lights := 0
	while _head < _queue.size():
		var object := instance_from_id(_queue[_head])
		_head += 1
		if object is GeometryInstance3D:
			var result := _apply_geometry(object as GeometryInstance3D)
			ranges += result & 1
			shadows += (result >> 1) & 1
		elif object is Light3D:
			lights += _apply_light(object as Light3D)
		if Time.get_ticks_usec() - start >= budget:
			break
	if _head >= _queue.size():
		_queue.clear()
		_head = 0
	elif _head > 4096:
		_queue = _queue.slice(_head)
		_head = 0
	if ranges + shadows + lights > 0:
		_ranges += ranges
		_shadows += shadows
		_lights += lights
		applied.emit(ranges, shadows, lights)


func _kept(node: Node) -> bool:
	if node.is_in_group(&"go_keep"):
		return true
	var at := node
	var depth := 0
	while at != null and depth < 6:
		if at.has_meta(&"go_keep"):
			return true
		at = at.get_parent()
		depth += 1
	return false


## Bit 0: a range was set. Bit 1: shadows were turned off.
func _apply_geometry(node: GeometryInstance3D) -> int:
	_seen += 1
	if not node.is_inside_tree() or _kept(node):
		_skipped += 1
		return 0
	var box := node.get_aabb()
	var scale := node.global_transform.basis.get_scale()
	var radius := box.size.length() * 0.5 * maxf(absf(scale.x), maxf(absf(scale.y), absf(scale.z)))
	if radius <= 0.0:
		return 0
	var result := 0
	if node.visibility_range_end <= 0.0 and node.visibility_range_begin <= 0.0:
		var distance := maxf(min_range, (2.0 * radius * _k) / maxf(pixels, 0.5))
		if distance < max_range:
			node.visibility_range_end = distance
			node.visibility_range_end_margin = maxf(2.0, distance * margin)
			result |= 1
	if radius < shadow_min_radius and node.cast_shadow != GeometryInstance3D.SHADOW_CASTING_SETTING_OFF:
		node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		result |= 2
	return result


func _apply_light(light: Light3D) -> int:
	if light is DirectionalLight3D or light.distance_fade_enabled or not light.is_inside_tree() or _kept(light):
		return 0
	var reach := 5.0
	if light is OmniLight3D:
		reach = (light as OmniLight3D).omni_range
	elif light is SpotLight3D:
		reach = (light as SpotLight3D).spot_range
	var shadow_end := maxf(40.0, reach * light_fade_factor)
	var begin := clampf(reach * light_fade_factor * 4.0, 120.0, 1500.0)
	light.distance_fade_enabled = true
	light.distance_fade_begin = begin
	light.distance_fade_shadow = shadow_end
	light.distance_fade_length = maxf(10.0, begin * 0.2)
	return 1


func pending() -> int:
	return _queue.size() - _head


func get_stats() -> Dictionary:
	return {"seen": _seen, "ranges_set": _ranges, "shadows_off": _shadows, "lights_faded": _lights, "left_alone": _skipped, "pending": pending()}
