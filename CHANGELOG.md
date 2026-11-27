# Changelog

## 0.1.0

First release.

- `optimizer_audit`: world model of every scene (nodes, meshes, triangles, surfaces, lights, bodies, extent), ranked
  findings over world, textures, models, settings, scripts and shaders, and a plan of fixes. No Godot needed.
- `optimizer_costmap`: predicted cost per world cell, hotspots and a benchmark route through them.
- `optimizer_fix`: `install`, `settings`, `textures`, `lods`, `lights`, `ranges`, `instancing`, `partition`, each
  with `dry_run`, journaled and undone with `optimizer_undo`.
- `optimizer_bench` and `optimizer_compare`: measured frame times, hitches, draw calls, memory and a screenshot per
  station, compared metric by metric and pixel by pixel.
- `optimizer_import`: Godot's import with the CPU texture compressor, so it finishes on machines without a GPU.
- Runtime kit `addons/gameoptimizer`: GOQuality (quality tiers), GOGovernor (adaptive resolution and settings),
  GOStreamer (world streaming), GOSpawnQueue, GOPrewarm, GOLod, GOProbe.
- MCP server over stdio and a CLI with the same tools; zero dependencies.
