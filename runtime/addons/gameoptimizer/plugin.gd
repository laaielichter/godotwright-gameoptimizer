@tool
extends EditorPlugin

const AUTOLOADS: Array[Array] = [
	["GOQuality", "res://addons/gameoptimizer/go_quality.gd"],
	["GOGovernor", "res://addons/gameoptimizer/go_governor.gd"],
	["GOSpawnQueue", "res://addons/gameoptimizer/go_spawn_queue.gd"],
	["GOProbe", "res://addons/gameoptimizer/go_probe.gd"],
]


func _enable_plugin() -> void:
	for entry: Array in AUTOLOADS:
		if not ProjectSettings.has_setting("autoload/" + str(entry[0])):
			add_autoload_singleton(entry[0], entry[1])


func _disable_plugin() -> void:
	for entry: Array in AUTOLOADS:
		if ProjectSettings.has_setting("autoload/" + str(entry[0])):
			remove_autoload_singleton(entry[0])
