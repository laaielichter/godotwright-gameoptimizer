# Changelog

## Unreleased

- The texture report reads Radiance `.hdr` and OpenEXR `.exr` headers, so HDR skies and EXR lightmaps are listed
  with their real size and counted at 8 bytes per pixel in the VRAM total. Before, they were skipped. Thanks to
  @kragent66-glitch! (#6, #11)
- `--cell-size` / `cell_size` of 0, a negative number or a value that is not a number (`abc`) is refused at once
  with an error that names the option. Before, `costmap`, `audit` and the `instancing` and `partition` fixes hung.
  Thanks to @rishav-raj-genx! (#3, #13)

## 0.2.0

For worlds that are built from code, and games that only exist as a pack.

- `optimizer_census`: starts a scene of a project or a `.pck`, lets the world build and counts the live tree: nodes
  by class, by script and by the script that created them, repeated meshes, a mesh or a material per object,
  objects without a visibility range, textures and their GPU format, nodes that process every frame, SubViewports,
  canvas items. Findings carry ids that start with `live/`.
- `optimizer_fix policy` and `GOWorldPolicy`: a visibility range, shadow rule and distance fade for every mesh and
  light that enters the tree at run time, within a time budget.
- Script rules: whole-tree searches from the root, time tests that are true for a window of frames, label text set
  every frame, textures made from images at run time.
- `optimizer_demo` with `procedural`: the demo world built by a script.

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
