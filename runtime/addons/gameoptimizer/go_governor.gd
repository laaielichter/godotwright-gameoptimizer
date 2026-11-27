extends Node
## Autoload `GOGovernor`: adaptive quality. Holds a target frame rate by moving the 3D resolution scale, and when
## that is not enough, by stepping down a ladder of costly settings; it climbs back when there is headroom.
##
## One slow frame (a level load, a shader compile) never lowers quality: single hitches are left out of the
## average, and the governor only acts on what lasted.

signal adjusted(scale: float, level: int)

## Runs the governor. Off until start() is called.
@export var enabled: bool = false
## Frame rate to hold. 0: the screen's refresh rate, or 60 when that is unknown.
@export var target_fps: float = 0.0
@export_range(0.25, 1.0) var min_scale: float = 0.5
@export_range(0.25, 2.0) var max_scale: float = 1.0
## Largest change of the scale in one decision.
@export var max_step: float = 0.08
## Seconds between decisions.
@export var interval: float = 0.5
## Go down when the load is above target * down_threshold, up when below target * up_threshold.
@export var down_threshold: float = 1.04
@export var up_threshold: float = 0.82
## Seconds the scale must sit at min_scale (max_scale) before the ladder steps down (up).
@export var ladder_delay: float = 3.0
## Steps taken one by one when the lowest scale is still too slow. Each is {key, value} for GOQuality.
@export var ladder: Array[Dictionary] = [
	{"key": "volumetric_fog", "value": false},
	{"key": "ssr", "value": false},
	{"key": "ssil", "value": false},
	{"key": "positional_soft_shadow_quality", "value": 0},
	{"key": "directional_soft_shadow_quality", "value": 1},
	{"key": "mesh_lod_threshold", "value": 3.0},
	{"key": "sdfgi", "value": false},
	{"key": "ssao", "value": false},
	{"key": "lod_bias", "value": 0.6},
]

const WINDOW := 120

var _scale: float = 1.0
var _level: int = 0
var _ema_ms: float = 0.0
var _render_ema_ms: float = 0.0
var _window: PackedFloat32Array = PackedFloat32Array()
var _window_at: int = 0
var _last_usec: int = 0
var _since_decision: float = 0.0
var _at_min_for: float = 0.0
var _at_max_for: float = 0.0
var _slow_run: int = 0
var _hitches_ignored: int = 0
var _measuring: bool = false
var _probe_ok: bool = true


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	set_process(enabled)
	if enabled:
		start(target_fps)


## Starts governing. `fps` 0 keeps the exported target (or the screen's refresh rate).
func start(fps: float = 0.0) -> void:
	if fps > 0.0:
		target_fps = fps
	if target_fps <= 0.0:
		var refresh := DisplayServer.screen_get_refresh_rate()
		target_fps = refresh if refresh > 1.0 else 60.0
	enabled = true
	_scale = clampf(get_viewport().scaling_3d_scale, min_scale, max_scale)
	_ema_ms = 0.0
	_render_ema_ms = 0.0
	_window.clear()
	_window_at = 0
	_last_usec = 0
	_since_decision = 0.0
	_at_min_for = 0.0
	_at_max_for = 0.0
	_slow_run = 0
	_set_measuring(true)
	set_process(true)


## Stops governing and puts the player's own settings back.
func stop() -> void:
	enabled = false
	set_process(false)
	_set_measuring(false)
	var quality := _quality()
	if quality != null:
		for step: Dictionary in ladder:
			quality.call(&"clear_override", str(step["key"]))
		quality.call(&"clear_override", "scaling_3d_scale")
	_level = 0


## What the governor sees and did: target, loads, scale, ladder level.
func get_state() -> Dictionary:
	return {
		"enabled": enabled,
		"target_fps": target_fps,
		"target_ms": _target_ms(),
		"frame_ms": _ema_ms,
		"render_ms": _render_ema_ms,
		"p95_ms": _p95(),
		"scale": _scale,
		"level": _level,
		"ladder_size": ladder.size(),
		"hitches_ignored": _hitches_ignored,
	}


func _target_ms() -> float:
	return 1000.0 / maxf(target_fps, 1.0)


func _quality() -> Node:
	return get_node_or_null(^"/root/GOQuality")


func _set_measuring(on: bool) -> void:
	if DisplayServer.get_name() == "headless":
		return
	RenderingServer.viewport_set_measure_render_time(get_viewport().get_viewport_rid(), on)
	_measuring = on


func _p95() -> float:
	if _window.is_empty():
		return 0.0
	var sorted := _window.duplicate()
	sorted.sort()
	return sorted[mini(int(sorted.size() * 0.95), sorted.size() - 1)]


func _process(_delta: float) -> void:
	var now := Time.get_ticks_usec()
	if _last_usec == 0:
		_last_usec = now
		return
	var frame_ms := float(now - _last_usec) / 1000.0
	_last_usec = now
	if _ema_ms <= 0.0:
		_ema_ms = frame_ms
	# A frame far above the average is a hitch, not load: it only counts once several come in a row.
	var counted := frame_ms
	if frame_ms > _ema_ms * 2.5 and frame_ms > _target_ms() * 1.5:
		_slow_run += 1
		if _slow_run < 4:
			_hitches_ignored += 1
			counted = -1.0
	else:
		_slow_run = 0
	if counted >= 0.0:
		_ema_ms = lerpf(_ema_ms, counted, 0.1)
		if _window.size() < WINDOW:
			_window.append(counted)
		else:
			_window[_window_at] = counted
			_window_at = (_window_at + 1) % WINDOW
		if _measuring:
			var rid := get_viewport().get_viewport_rid()
			var render_ms := RenderingServer.viewport_get_measured_render_time_cpu(rid) \
					+ RenderingServer.viewport_get_measured_render_time_gpu(rid)
			if render_ms > 0.0:
				_render_ema_ms = render_ms if _render_ema_ms <= 0.0 else lerpf(_render_ema_ms, render_ms, 0.1)
	_since_decision += frame_ms / 1000.0
	if _since_decision >= interval and _window.size() >= 20:
		_decide(_since_decision)
		_since_decision = 0.0


func _decide(elapsed: float) -> void:
	var target := _target_ms()
	var p95 := _p95()
	var too_slow := _ema_ms > target * down_threshold
	# With vsync the frame time never drops below the target, so headroom shows only in the render time
	# (CPU + GPU of the viewport). Without that measurement, try a higher scale while frames are on target.
	var headroom := false
	if _render_ema_ms > 0.0:
		headroom = _render_ema_ms < target * up_threshold and p95 < target * 1.15
	else:
		headroom = _ema_ms < target * up_threshold or (_ema_ms <= target * 1.02 and p95 <= target * 1.1 and _probe_ok)
	var new_scale := _scale
	if too_slow:
		var over := _ema_ms / target - 1.0
		new_scale = _scale - clampf(over * 0.5, 0.02, max_step)
		_probe_ok = false
	elif headroom:
		new_scale = _scale + 0.02
	else:
		_probe_ok = true
	new_scale = clampf(new_scale, min_scale, max_scale)
	var new_level := _level
	if new_scale <= min_scale + 0.001 and too_slow:
		_at_min_for += elapsed
		if _at_min_for >= ladder_delay and _level < ladder.size():
			new_level = _level + 1
			_at_min_for = 0.0
	else:
		_at_min_for = 0.0
	if new_scale >= max_scale - 0.001 and headroom:
		_at_max_for += elapsed
		if _at_max_for >= ladder_delay and _level > 0:
			new_level = _level - 1
			_at_max_for = 0.0
			# A step up costs frame time: leave room for it.
			new_scale = maxf(min_scale, max_scale - max_step)
	else:
		_at_max_for = 0.0
	if is_equal_approx(new_scale, _scale) and new_level == _level:
		return
	var quality := _quality()
	if new_level > _level:
		var step: Dictionary = ladder[_level]
		if quality != null:
			quality.call(&"set_override", str(step["key"]), step["value"])
	elif new_level < _level:
		var step: Dictionary = ladder[new_level]
		if quality != null:
			quality.call(&"clear_override", str(step["key"]))
	_level = new_level
	if not is_equal_approx(new_scale, _scale):
		_scale = new_scale
		if quality != null and str(quality.call(&"get_tier")) != "":
			quality.call(&"set_override", "scaling_3d_scale", _scale)
		else:
			get_viewport().scaling_3d_scale = _scale
	adjusted.emit(_scale, _level)
