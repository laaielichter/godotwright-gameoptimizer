---
name: gameoptimizer
description: Optimize the performance of a Godot 4 game with godotwright-gameoptimizer. Use when a Godot project is slow, stutters, loads slowly, uses too much VRAM, needs world streaming, LOD, instancing, quality settings or an upscaler, or when asked to make an open world run well. Works from the project files; measuring needs Godot 4.
---

# Optimizing a Godot game

Tools come from the MCP server `godotwright-gameoptimizer` (`optimizer_*`). Without the server, run the same
commands through the CLI: `npx -y github:laaielichter/godotwright-gameoptimizer <command> [project] --json`.

## The loop

1. `optimizer_audit {project}`. Read `findings` (ranked, with evidence) and `plan.steps`.
2. `optimizer_bench {project, label: "baseline"}`. Skip only when there is no Godot; then say so in your report and
   rely on the static numbers (draws, triangles, nodes, VRAM estimate).
3. For each plan step, in order: `optimizer_fix {project, fix, ...}`. Then `optimizer_bench {label: "<fix>"}` and
   `optimizer_compare {run: "<fix>"}`. Pass `reimport: true` to the bench after `textures` or `lods`.
4. Verdict "improvement, picture unchanged": keep it and commit. "regression": `optimizer_undo`. "the picture
   changed": look at the screenshots in `shots`, then keep, tune (`pixels`, `load_radius`, `far_radius`) or undo.
5. For findings without a fix, call `optimizer_explain {topic: "<finding id>"}` and change the code or content
   yourself. Re-run the audit: the finding should be gone.

## Worlds built from code, and games that are a .pck

When `optimizer_audit` finds no world scene (few or no mesh instances) but the game clearly has a world, the
world is built by scripts. Then:

1. `optimizer_census {project}` or `{pack: "game.pck"}`; give a large world more `seconds`. Use `headless: true`
   on a machine without a GPU.
2. `optimizer_fix {fix: "policy"}` when the census reports objects without a range, tiny shadow casters or lights
   without a fade. Run the census again with another `label`: those counts should be near zero.
3. For `live/repeated-mesh-nodes`, `live/mesh-per-object` and `live/material-per-object`, open the script named in
   `made_by` and change the loop: share the mesh and the material, fill a MultiMesh per world cell.
4. For `live/uncompressed-textures` with run-time textures: bake them to compressed files; `Image.compress` does
   not exist in an exported game.

## Choosing parameters

- `pixels` (ranges, instancing, partition): 6 is invisible at 1080p. 12 to 20 suits low-end targets; prefer the
  `lod_bias` key of the quality tiers over raising it in the scene.
- `cell_size`: the default follows the size of the world. Smaller cells cull better and load in smaller steps, but
  mean more draw calls and more files. 64 m for dense towns, 128 to 256 m for forests and terrain.
- `load_radius` (partition): at least 2 cells. Things that must exist far away (gameplay, not looks) should stay
  out of the containers, or be reached through `GOStreamer.load_all_blocking()`.
- `instancing` is optional: Forward+ already batches identical meshes. Apply it when node count or load time is
  the problem (tens of thousands of identical props), and keep it only if `optimizer_compare` agrees.
- `stand_ins: false` (partition) keeps large objects as real nodes in far chunks instead of MultiMesh stand-ins:
  fewer draw calls, more nodes.
- `mode: "fly"` in the bench exercises streaming; `stations` gives comparable pictures.

## After the fixes: wire the runtime kit

- At start: `GOQuality.load_saved()` or `GOQuality.apply_tier(GOQuality.auto_detect())`. Offer the tiers in the
  settings menu with `GOQuality.tiers()`, `apply_tier`, `set_value`, `save`.
- After loading: `GOGovernor.start(60)` to hold the frame rate with dynamic resolution.
- Behind the loading screen: `await GOPrewarm.new().run(paths)` (add it to the tree first) to compile pipelines.
- Spawning at run time: `GOSpawnQueue.instantiate_async(path, parent, callback)` instead of `load` + `add_child`.

The API of every script is in `addons/gameoptimizer/README.md` after `install`.

## Report to the user

Give the before and after of p50 and p99 frame time, hitches, draw calls, nodes and memory from
`optimizer_compare`, name the fixes kept and undone, and list the findings that still need a human decision. On a
software renderer say that the milliseconds are relative.
