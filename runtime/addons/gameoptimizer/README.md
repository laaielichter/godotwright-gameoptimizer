# Game Optimizer runtime kit

The Godot side of godotwright-gameoptimizer. Copy `addons/gameoptimizer/` into a project and enable the plugin
(Project Settings > Plugins); that adds four autoloads. Godot 4.3 or newer; tested on 4.7.2, Forward+ and headless.

| Script | What it is | For |
| --- | --- | --- |
| `go_quality.gd` | autoload `GOQuality` | quality tiers that apply at runtime |
| `go_governor.gd` | autoload `GOGovernor` | holds a frame rate by scaling resolution and settings |
| `go_streamer.gd` | `class_name GOStreamer` (Node3D) | loads world chunks around the camera without hitches |
| `go_spawn_queue.gd` | autoload `GOSpawnQueue` | adds nodes a few per frame |
| `go_prewarm.gd` | `class_name GOPrewarm` (Node) | compiles pipelines behind a loading screen |
| `go_lod.gd` | `class_name GOLod` | scales visibility ranges by one bias |
| `go_probe.gd` | autoload `GOProbe` | measures a run and writes JSON; inert unless asked |

## GOQuality

Tiers live in `quality_tiers.json`: `low`, `medium`, `high`, `ultra`, `cinematic`, each a flat dictionary.

```gdscript
GOQuality.apply_tier(GOQuality.auto_detect())   # or a name from GOQuality.tiers()
GOQuality.set_value("scaling_3d_scale", 0.67)    # one key on top of the tier (a settings menu)
GOQuality.save()                                 # user://gameoptimizer.cfg; load_saved() applies it again
```

- `apply_tier(name)`, `get_tier()`, `tiers()`, `set_value(key, value)`, `get_value(key)`, `get_base_value(key)`.
- `set_override(key, value)` / `clear_override(key)`: a temporary value that is not saved (the governor uses it).
- `auto_detect() -> String`: a tier for this machine (renderer, kind of GPU, adapter name, screen size). It applies
  nothing and never returns `cinematic`.
- `refresh_environment()`: re-applies the effect keys; called for you when a WorldEnvironment or Camera3D enters the tree.
- Signals `tier_changed(name)`, `value_changed(key, value)`. `apply_on_ready` (off) applies the saved or default tier.

Keys: `scaling_3d_mode` (`bilinear`, `fsr1`, `fsr2`), `scaling_3d_scale`, `fsr_sharpness`, `msaa_3d` (0, 2, 4, 8),
`screen_space_aa` (`off`, `fxaa`, `smaa`), `use_taa`, `use_debanding`, `mesh_lod_threshold`, `lod_bias`,
`shadow_atlas_size`, `shadow_atlas_16_bits`, `directional_shadow_size`, `directional_shadow_16_bits`,
`directional_soft_shadow_quality` and `positional_soft_shadow_quality` (0 hard to 5 ultra), `ssao`, `ssao_quality`
(0 to 4), `ssao_half_size`, `ssil`, `ssil_quality`, `ssil_half_size`, `ssr`, `ssr_half_size`, `sdfgi`,
`sdfgi_ray_count` (0 to 6), `gi_half_resolution`, `glow`, `glow_bicubic_upscale`, `volumetric_fog`,
`volumetric_fog_size`, `volumetric_fog_depth`, `volumetric_fog_filter`, `sss_quality` (0 to 3),
`anisotropic_filtering` (0, 2, 4, 8, 16), `texture_mipmap_bias`, `max_fps`, `vsync` (`off`, `on`, `adaptive`,
`mailbox`), `physics_ticks` (0: leave alone).

Effect keys (`ssao`, `ssil`, `ssr`, `sdfgi`, `glow`, `volumetric_fog`) take `false` (off), `true` (as the scene was
authored: a tier never switches on an effect the artist did not use) or `"on"` (force on). They act on the
Environment of the current camera and of the WorldEnvironment. FSR2, TAA and SDFGI are only used in Forward+; with
FSR2 on, TAA stays off.

## GOGovernor

```gdscript
GOGovernor.start(60.0)   # hold 60 fps; start() with no argument uses the screen's refresh rate
GOGovernor.stop()        # puts the player's settings back
```

Moves `scaling_3d_scale` between `min_scale` and `max_scale`. When the lowest scale is still too slow for
`ladder_delay` seconds it takes the next step of `ladder` (an array of `{key, value}` for GOQuality), and steps back
when there is headroom. Single hitches are left out of the average. Headroom is read from the viewport's measured
render time, so it also works with vsync on. `get_state() -> Dictionary`; signal `adjusted(scale, level)`.
The ladder needs a tier to be applied (it restores the tier's values).

## GOStreamer

Add a Node3D with `go_streamer.gd` and set `manifest_path`. The node may have ordinary children of its own.

```json
{"version":1,"cell_size":64,"load_radius":192,"unload_radius":256,"chunks":[
 {"id":"c_0_0","scene":"res://world/chunks/c_0_0.tscn","center":[32,0,32],"aabb":[0,0,0,64,20,64],
  "lod_scene":"res://world/chunks/c_0_0_lod.tscn","lod_radius":900,"load_radius":0,"unload_radius":0,"cost":123}]}
```

Coordinates are in the streamer's local space. Distance is measured to the chunk's box. A chunk loads on a loader
thread, its root becomes a child of the streamer (named after the id), and the root's children are attached within
`frame_budget_ms` per frame; unloading is spread the same way. `lod_scene` is a stand-in shown while the chunk is
not loaded (up to `lod_radius`; 0: always). A chunk's own `load_radius` / `unload_radius` override the defaults.

- Exports: `manifest_path`, `load_radius`, `unload_radius` (0: from the manifest), `frame_budget_ms` (2.0),
  `max_concurrent_loads` (3), `predictive` and `look_ahead_seconds` (chunks ahead of the movement first), `target`
  (empty: the current Camera3D), `threaded_instantiate` (build nodes on a worker thread), `autostart`.
- `load_manifest(path)`, `start()`, `stop()`, `set_focus_position(local_pos)`, `clear_focus()`, `is_settled()`,
  `get_loaded_ids()`, `get_chunk_node(id)`, `get_stats()`, `load_all_blocking()`.
- Signals `chunk_loaded(id)`, `chunk_unloaded(id)`, `settled()`.

## GOSpawnQueue

```gdscript
GOSpawnQueue.add(parent, node_or_packed_scene, func(node): ...)
GOSpawnQueue.instantiate_async("res://enemy.tscn", parent, func(node): ...)
```

Spends at most `budget_ms` (1.5) per frame. `pending()` is the number still waiting.

## GOPrewarm

```gdscript
var prewarm := GOPrewarm.new()
add_child(prewarm)
prewarm.progress.connect(func(done, total): bar.value = float(done) / total)
await prewarm.run(["res://world/chunks/c_0_0.tscn", get_tree().current_scene])
```

`prewarm_scene(sources)` (paths, PackedScenes, Nodes), `prewarm_materials(materials)`, `run(sources = null)`,
`pending()`; signals `progress(done, total)`, `finished()`. Each unique material + vertex format (also as shadow
caster and as MultiMesh) is drawn for `frames_per_batch` frames, a few centimetres across, in front of the current
camera; without a 3D camera, or with `force_sub_viewport`, in a SubViewport of its own.

## GOLod

`GOLod.apply_bias(root, bias)` multiplies `visibility_range_begin/end` and their margins under `root`. The authored
ranges are kept in the `go_vr` meta, so the bias does not compound. GOQuality's `lod_bias` calls it on the current
scene, GOStreamer on every chunk it loads.

## GOProbe

```sh
godot --path <project> -- --go-probe=/abs/out.json --go-frames=600 --go-warmup=60 \
  --go-route=/abs/route.json --go-shots=/abs/dir --go-tier=high --go-wait-settled=1
```

Route: `{"mode":"fly"|"stations","speed":30,"stations":[{"pos":[x,y,z],"look_at":[x,y,z]}]}`. `fly` moves a camera
of its own along the stations, the same distance every frame (so two runs see the same frames; `speed` is not
used); `stations` goes from one to the next, waits for streamers, measures, and saves `station_000.png` ... to
`--go-shots`. Without a route the scene is measured as it is. Vsync and the fps cap are off while probing.

The report has `frame_ms`, `process_ms`, `physics_ms` (each `p50`, `p95`, `p99`, `max`, `mean`), `hitches` (the 20
worst, with position, chunks loading and pipelines compiled on that frame), `hitch_count`, `hitch_threshold_ms`,
`pipeline_compiles`, `monitors` (`draw_calls`, `primitives`, `objects`, `video_mem_mb`, `texture_mem_mb`,
`buffer_mem_mb`, `nodes`, `orphans`, `static_mem_mb`, `physics_active_objects`, each `avg` and `max`), `stations`,
`streamers` and `warnings`. The game quits when the report is written.
