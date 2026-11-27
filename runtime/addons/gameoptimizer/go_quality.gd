extends Node
## Autoload `GOQuality`: scalable quality tiers that apply at runtime, without a restart.
##
## Tiers come from `quality_tiers.json` next to this script (edit that file, or point `tiers_path` elsewhere).
## A tier is a flat dictionary of keys; `set_value` changes one key on top of the tier (a settings menu),
## `set_override` changes one key for a while without touching what the player chose (GOGovernor uses it).
##
## Effect keys (ssao, ssil, ssr, sdfgi, glow, volumetric_fog) take `false` (force off), `true` (as the scene
## was authored: a tier never switches on an effect the artist did not use) or `"on"` (force on).

signal tier_changed(tier_name: String)
signal value_changed(key: String, value: Variant)

const SAVE_PATH := "user://gameoptimizer.cfg"
const SAVE_SECTION := "quality"
const EFFECT_KEYS: Dictionary = {
	"ssao": "ssao_enabled",
	"ssil": "ssil_enabled",
	"ssr": "ssr_enabled",
	"sdfgi": "sdfgi_enabled",
	"glow": "glow_enabled",
	"volumetric_fog": "volumetric_fog_enabled",
}
const ENV_META := &"go_authored"

## Where the tiers are read from.
@export var tiers_path: String = "res://addons/gameoptimizer/quality_tiers.json"
## Apply the saved (or default) tier when the game starts. Off: nothing changes until apply_tier is called.
@export var apply_on_ready: bool = false

var _tiers: Dictionary = {}
var _default_tier: String = "high"
var _tier: String = ""
var _user: Dictionary = {}
var _overrides: Dictionary = {}
var _environments: Array[Environment] = []
var _refresh_queued: bool = false


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_load_tiers()
	get_tree().node_added.connect(_on_node_added)
	if apply_on_ready:
		if not load_saved():
			apply_tier(_default_tier)


## Names of the tiers, in the order of the file (lowest first).
func tiers() -> PackedStringArray:
	return PackedStringArray(_tiers.keys())


## The tier applied last ("" before the first apply_tier).
func get_tier() -> String:
	return _tier


## Applies every key of a tier. Values set with set_value are dropped; overrides stay.
func apply_tier(tier_name: String) -> void:
	if not _tiers.has(tier_name):
		push_error("GOQuality: no tier named '%s' (have: %s)" % [tier_name, ", ".join(tiers())])
		return
	_tier = tier_name
	_user.clear()
	_apply_all()
	tier_changed.emit(tier_name)


## Changes one key on top of the current tier (kept by save()).
func set_value(key: String, value: Variant) -> void:
	_user[key] = value
	if not _overrides.has(key):
		_apply_key(key, value)
	value_changed.emit(key, value)


## The value in effect for a key: override, then set_value, then the tier. null when unknown.
func get_value(key: String) -> Variant:
	if _overrides.has(key):
		return _overrides[key]
	return get_base_value(key)


## The value the player chose for a key (set_value or the tier), ignoring overrides.
func get_base_value(key: String) -> Variant:
	if _user.has(key):
		return _user[key]
	var tier: Dictionary = _tiers.get(_tier, {})
	return tier.get(key)


## Changes one key for a while without changing what the player chose. Not saved.
func set_override(key: String, value: Variant) -> void:
	_overrides[key] = value
	_apply_key(key, value)
	value_changed.emit(key, value)


## Drops an override and puts the player's value back.
func clear_override(key: String) -> void:
	if not _overrides.has(key):
		return
	_overrides.erase(key)
	var base: Variant = get_base_value(key)
	if base != null:
		_apply_key(key, base)
		value_changed.emit(key, base)


## Saves the tier and the set_value changes to user://gameoptimizer.cfg.
func save() -> Error:
	var config := ConfigFile.new()
	config.set_value(SAVE_SECTION, "tier", _tier)
	config.set_value(SAVE_SECTION, "values", _user)
	return config.save(SAVE_PATH)


## Loads and applies what save() wrote. False when there is nothing saved.
func load_saved() -> bool:
	var config := ConfigFile.new()
	if config.load(SAVE_PATH) != OK:
		return false
	var saved_tier: String = str(config.get_value(SAVE_SECTION, "tier", ""))
	if not _tiers.has(saved_tier):
		return false
	_tier = saved_tier
	var values: Variant = config.get_value(SAVE_SECTION, "values", {})
	_user = (values as Dictionary).duplicate() if values is Dictionary else {}
	_apply_all()
	tier_changed.emit(_tier)
	return true


## Picks a tier for this machine from the renderer, the kind of GPU and the screen size. Applies nothing.
func auto_detect() -> String:
	var names := tiers()
	if names.is_empty():
		return ""
	var method := RenderingServer.get_current_rendering_method()
	var adapter := RenderingServer.get_video_adapter_name().to_lower()
	var rank := 2
	if DisplayServer.get_name() == "headless" or method == "" or method == "dummy":
		rank = 0
	elif method == "gl_compatibility":
		rank = 0
	else:
		match RenderingServer.get_video_adapter_type():
			RenderingDevice.DEVICE_TYPE_DISCRETE_GPU:
				rank = 2
			RenderingDevice.DEVICE_TYPE_INTEGRATED_GPU:
				rank = 1
			RenderingDevice.DEVICE_TYPE_CPU:
				rank = 0
			_:
				rank = 1
		if _matches_any(adapter, ["llvmpipe", "lavapipe", "swiftshader", "software"]):
			rank = 0
		elif _matches_any(adapter, ["rtx 40", "rtx 50", "rtx 3080", "rtx 3090", "rx 7800", "rx 7900", "rx 9070", "rx 6900", "rx 6950"]):
			rank = 3
		elif _matches_any(adapter, ["gtx 9", "gtx 10", "gtx 16", "rx 4", "rx 5", "mx", "intel", "adreno", "mali", "powervr"]):
			rank = mini(rank, 1)
		if method == "mobile":
			rank = mini(rank, 1)
		var screen := DisplayServer.screen_get_size()
		if screen.x * screen.y > 2560 * 1440 and rank > 0 and rank < 3:
			rank -= 1
	# "cinematic" is for screenshots and trailers: never picked for a player.
	var top := names.size() - 1
	if names[top] == "cinematic":
		top -= 1
	return names[clampi(rank, 0, maxi(top, 0))]


## Re-applies the effect keys to the environment in use now. Called for you when a WorldEnvironment or Camera3D
## enters the tree; call it yourself after swapping `Camera3D.environment` by code.
func refresh_environment() -> void:
	_refresh_queued = false
	if _tier == "":
		return
	for key: String in EFFECT_KEYS:
		var value: Variant = get_value(key)
		if value != null:
			_apply_effect(key, value)


func _load_tiers() -> void:
	_tiers.clear()
	if not FileAccess.file_exists(tiers_path):
		push_error("GOQuality: %s not found" % tiers_path)
		return
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(tiers_path))
	if not (parsed is Dictionary) or not ((parsed as Dictionary).get("tiers") is Dictionary):
		push_error("GOQuality: %s is not a tiers file" % tiers_path)
		return
	_tiers = (parsed as Dictionary)["tiers"]
	_default_tier = str((parsed as Dictionary).get("default", "high"))
	if not _tiers.has(_default_tier) and not _tiers.is_empty():
		_default_tier = str(_tiers.keys()[0])


func _apply_all() -> void:
	var tier: Dictionary = _tiers.get(_tier, {})
	var merged: Dictionary = tier.duplicate()
	merged.merge(_user, true)
	merged.merge(_overrides, true)
	for key: String in merged:
		_apply_key(key, merged[key])


func _matches_any(text: String, needles: Array) -> bool:
	for needle: String in needles:
		if text.contains(needle):
			return true
	return false


func _on_node_added(node: Node) -> void:
	if _tier != "" and not _refresh_queued and (node is WorldEnvironment or node is Camera3D):
		_refresh_queued = true
		refresh_environment.call_deferred()


func _has_renderer() -> bool:
	return DisplayServer.get_name() != "headless"


func _setting(path: String, fallback: Variant) -> Variant:
	return ProjectSettings.get_setting(path, fallback)


func _current_environments() -> Array[Environment]:
	var found: Array[Environment] = []
	var viewport := get_viewport()
	if viewport == null:
		return found
	var camera := viewport.get_camera_3d()
	if camera != null and camera.environment != null:
		found.append(camera.environment)
	var world := viewport.find_world_3d()
	if world != null and world.environment != null and not found.has(world.environment):
		found.append(world.environment)
	return found


func _apply_effect(key: String, value: Variant) -> void:
	var property: String = EFFECT_KEYS[key]
	for environment: Environment in _current_environments():
		var authored: Dictionary = environment.get_meta(ENV_META, {})
		if not authored.has(property):
			authored[property] = environment.get(property)
			environment.set_meta(ENV_META, authored)
		var enable: bool = authored[property]
		if value is String:
			enable = str(value) == "on" or (str(value) == "scene" and enable)
		elif not bool(value):
			enable = false
		if key == "sdfgi" and RenderingServer.get_current_rendering_method() != "forward_plus":
			enable = false
		if environment.get(property) != enable:
			environment.set(property, enable)


func _apply_key(key: String, value: Variant) -> void:
	if value == null:
		return
	if EFFECT_KEYS.has(key):
		_apply_effect(key, value)
		return
	var viewport := get_viewport()
	var method := RenderingServer.get_current_rendering_method()
	var forward := method == "forward_plus"
	var rd := method == "forward_plus" or method == "mobile"
	match key:
		"scaling_3d_mode":
			var mode := Viewport.SCALING_3D_MODE_BILINEAR
			match str(value):
				"fsr1", "fsr":
					mode = Viewport.SCALING_3D_MODE_FSR if rd else Viewport.SCALING_3D_MODE_BILINEAR
				"fsr2":
					if forward:
						mode = Viewport.SCALING_3D_MODE_FSR2
					elif rd:
						mode = Viewport.SCALING_3D_MODE_FSR
			viewport.scaling_3d_mode = mode
			_apply_taa()
		"scaling_3d_scale":
			viewport.scaling_3d_scale = clampf(float(value), 0.25, 2.0)
		"fsr_sharpness":
			viewport.fsr_sharpness = float(value)
		"msaa_3d":
			var samples := int(value)
			var msaa := Viewport.MSAA_DISABLED
			if samples >= 8:
				msaa = Viewport.MSAA_8X
			elif samples >= 4:
				msaa = Viewport.MSAA_4X
			elif samples >= 2:
				msaa = Viewport.MSAA_2X
			viewport.msaa_3d = msaa
		"screen_space_aa":
			var aa := 0
			match str(value):
				"fxaa":
					aa = 1
				"smaa":
					# SMAA came with Godot 4.5; older versions fall back to FXAA.
					aa = 2 if ClassDB.class_has_integer_constant(&"Viewport", &"SCREEN_SPACE_AA_SMAA") else 1
			viewport.screen_space_aa = aa as Viewport.ScreenSpaceAA
		"use_taa":
			_apply_taa()
		"use_debanding":
			viewport.use_debanding = bool(value)
		"mesh_lod_threshold":
			viewport.mesh_lod_threshold = maxf(float(value), 0.0)
		"lod_bias":
			var scene := get_tree().current_scene
			if scene != null:
				GOLod.apply_bias(scene, float(value))
		"shadow_atlas_size":
			viewport.positional_shadow_atlas_size = int(value)
		"shadow_atlas_16_bits":
			viewport.positional_shadow_atlas_16_bits = bool(value)
		"directional_shadow_size", "directional_shadow_16_bits":
			var size: Variant = get_value("directional_shadow_size")
			var bits: Variant = get_value("directional_shadow_16_bits")
			if key == "directional_shadow_size":
				size = value
			else:
				bits = value
			RenderingServer.directional_shadow_atlas_set_size(
				int(size) if size != null else int(_setting("rendering/lights_and_shadows/directional_shadow/size", 4096)),
				bool(bits) if bits != null else bool(_setting("rendering/lights_and_shadows/directional_shadow/16_bits", true)))
		"directional_soft_shadow_quality":
			RenderingServer.directional_soft_shadow_filter_set_quality(clampi(int(value), 0, 5) as RenderingServer.ShadowQuality)
		"positional_soft_shadow_quality":
			RenderingServer.positional_soft_shadow_filter_set_quality(clampi(int(value), 0, 5) as RenderingServer.ShadowQuality)
		"ssao_quality", "ssao_half_size":
			var quality: Variant = value if key == "ssao_quality" else get_value("ssao_quality")
			var half: Variant = value if key == "ssao_half_size" else get_value("ssao_half_size")
			RenderingServer.environment_set_ssao_quality(
				clampi(int(quality) if quality != null else 2, 0, 4) as RenderingServer.EnvironmentSSAOQuality,
				bool(half) if half != null else true,
				float(_setting("rendering/environment/ssao/adaptive_target", 0.5)),
				int(_setting("rendering/environment/ssao/blur_passes", 2)),
				float(_setting("rendering/environment/ssao/fadeout_from", 50.0)),
				float(_setting("rendering/environment/ssao/fadeout_to", 300.0)))
		"ssil_quality", "ssil_half_size":
			var quality: Variant = value if key == "ssil_quality" else get_value("ssil_quality")
			var half: Variant = value if key == "ssil_half_size" else get_value("ssil_half_size")
			RenderingServer.environment_set_ssil_quality(
				clampi(int(quality) if quality != null else 2, 0, 4) as RenderingServer.EnvironmentSSILQuality,
				bool(half) if half != null else true,
				float(_setting("rendering/environment/ssil/adaptive_target", 0.5)),
				int(_setting("rendering/environment/ssil/blur_passes", 4)),
				float(_setting("rendering/environment/ssil/fadeout_from", 50.0)),
				float(_setting("rendering/environment/ssil/fadeout_to", 300.0)))
		"ssr_half_size":
			if RenderingServer.has_method(&"environment_set_ssr_half_size"):
				RenderingServer.call(&"environment_set_ssr_half_size", bool(value))
		"sdfgi_ray_count":
			RenderingServer.environment_set_sdfgi_ray_count(clampi(int(value), 0, 6) as RenderingServer.EnvironmentSDFGIRayCount)
		"gi_half_resolution":
			RenderingServer.gi_set_use_half_resolution(bool(value))
		"glow_bicubic_upscale":
			RenderingServer.environment_glow_set_use_bicubic_upscale(bool(value))
		"volumetric_fog_size", "volumetric_fog_depth":
			var size: Variant = value if key == "volumetric_fog_size" else get_value("volumetric_fog_size")
			var depth: Variant = value if key == "volumetric_fog_depth" else get_value("volumetric_fog_depth")
			RenderingServer.environment_set_volumetric_fog_volume_size(
				int(size) if size != null else 64, int(depth) if depth != null else 64)
		"volumetric_fog_filter":
			RenderingServer.environment_set_volumetric_fog_filter_active(bool(value))
		"sss_quality":
			RenderingServer.sub_surface_scattering_set_quality(clampi(int(value), 0, 3) as RenderingServer.SubSurfaceScatteringQuality)
		"anisotropic_filtering":
			var level := int(value)
			var index := 0
			if level >= 16:
				index = 4
			elif level >= 8:
				index = 3
			elif level >= 4:
				index = 2
			elif level >= 2:
				index = 1
			# A viewport property since Godot 4.4; before that it is a project setting that needs a restart.
			if &"anisotropic_filtering_level" in viewport:
				viewport.set(&"anisotropic_filtering_level", index)
		"texture_mipmap_bias":
			viewport.texture_mipmap_bias = float(value)
		"max_fps":
			Engine.max_fps = maxi(int(value), 0)
		"vsync":
			if _has_renderer():
				var vsync := DisplayServer.VSYNC_ENABLED
				match str(value):
					"off", "false":
						vsync = DisplayServer.VSYNC_DISABLED
					"adaptive":
						vsync = DisplayServer.VSYNC_ADAPTIVE
					"mailbox":
						vsync = DisplayServer.VSYNC_MAILBOX
				DisplayServer.window_set_vsync_mode(vsync)
		"physics_ticks":
			if int(value) > 0:
				Engine.physics_ticks_per_second = int(value)
		_:
			push_warning("GOQuality: unknown key '%s'" % key)


## TAA only exists in Forward+, and FSR2 brings its own: with FSR2 on, Godot's TAA stays off.
func _apply_taa() -> void:
	var viewport := get_viewport()
	var wanted: Variant = get_value("use_taa")
	var enable := wanted != null and bool(wanted)
	if RenderingServer.get_current_rendering_method() != "forward_plus":
		enable = false
	if viewport.scaling_3d_mode == Viewport.SCALING_3D_MODE_FSR2:
		enable = false
	viewport.use_taa = enable
