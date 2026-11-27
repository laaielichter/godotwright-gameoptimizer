# Godotwright Game Optimizer

**The performance optimizer for Godot 4 games, built for coding agents.** It reads a project, tells the agent what
holds the frame rate, memory and load times back, applies the fixes itself, and proves each one with a benchmark and
a screenshot comparison. Made for heavy open worlds; works on any 3D project.

By [laaielichter](https://github.com/laaielichter). MIT. Node 20+, zero dependencies, no build step.
Sister project of [Godotwright](https://github.com/laaielichter/godotwright), the coding toolkit for Godot agents.

```sh
npx -y github:laaielichter/godotwright-gameoptimizer audit path/to/project
```

```text
Open World Demo  (Godot 4.7, forward_plus, 28 files, 2 scripts)
  world/world.tscn: 20128 nodes, 17837 mesh instances (11 unique), 4508k triangles, 17837 surfaces in about 11 batches,
                    261 lights (261 shadowed), 501 bodies, 2400 x 2400 m
    worst view: 3892k triangles, 15129 surfaces in range (cells of 128 m)
  score 9/100   high 4  medium 7  low 4

HIGH   16k identical meshes are separate nodes (5 kinds)                  fix: gameoptimizer fix instancing
HIGH   14k small objects are drawn at any distance                        fix: gameoptimizer fix ranges
HIGH   260 of 260 omni and spot lights never fade out (260 cast shadows)  fix: gameoptimizer fix lights
HIGH   One scene holds a 2400 m world with 17k placed objects             fix: gameoptimizer fix partition
MEDIUM 7 textures on 3D materials are not VRAM-compressed ...             fix: gameoptimizer fix textures
...
Plan: install > settings > textures > lights > ranges > instancing > partition
Measure first: gameoptimizer bench --label baseline. After each step: bench --label <name>, compare <name>.
```

The audit needs no Godot and takes under a second on that project.

## What it solves

Godot 4 renders beautifully, but a large world runs into the same walls every time. Each row is a problem the
engine leaves to you, and what this tool does about it.

| Problem in Godot 4 | What the optimizer does |
| --- | --- |
| **No world streaming.** A scene is loaded, instantiated and kept in memory as a whole. | `partition` cuts a world scene into chunk scenes on a grid. **GOStreamer** loads them around the camera on a thread, attaches nodes within a per-frame time budget and loads ahead of the camera's movement. |
| **No HLOD.** Unload a chunk and its buildings vanish from the skyline. | Every chunk gets a **stand-in scene**: one MultiMesh per mesh of only the parts large enough to be seen from far, with no physics, lights or scripts. It is drawn while the chunk is not loaded, so the picture stays the same. |
| **Only a far plane.** A pebble 2 km away is still an instance to cull. | `ranges` gives every object a visibility range computed from its own size on screen (invisible below 6 pixels by default), and takes tiny objects out of the shadow passes. |
| **A MultiMesh is culled as one box.** One MultiMesh for a forest is always drawn in full; a node per blade of grass drowns the scene tree. | `instancing` merges identical meshes into **one MultiMesh per world cell**, each with its own visibility range. A trade (see Measured): the plan marks it optional unless the node count is high. |
| **No texture streaming.** Every texture of a loaded scene sits in VRAM in full; projects built outside the editor never get VRAM compression. | `textures` sets VRAM compression and mipmaps for the textures 3D materials use (4 to 8 times less memory). Streaming then makes texture memory follow what is loaded. |
| **No dynamic resolution, no quality presets.** Project settings are read at start. | **GOQuality**: five tiers (low to cinematic) applied at run time: FSR 1/2 and scale, AA, shadows, GI, SSAO, SSR, fog, LOD bias. **GOGovernor** holds a target frame rate by moving the resolution scale, then a ladder of settings. |
| **Hitches from main-thread loading.** `load`, `instantiate` and `add_child` block the frame. | **GOSpawnQueue** loads on a thread and attaches within a time budget. The audit finds the loops that do it the slow way. |
| **Shader compilation stutter** for content that arrives after the loading screen. | **GOPrewarm** draws every material and vertex format once behind the loading screen. The probe counts pipeline compilations per frame, so you can see it work. |
| **Lights that never switch off.** Every shadowed omni light renders the scene six times. | `lights` sets distance fade from each light's range; optional dual-paraboloid shadows. |
| **The world is built from code**, or the game only exists as a `.pck`: there is no scene file to read. | The **live census** starts the game, lets the world build and counts what is really in the tree: nodes per script that made them, repeated meshes, a mesh or a material per object, objects without a visibility range, textures that sit uncompressed in VRAM, nodes that process every frame. **GOWorldPolicy** then gives every mesh and light a visibility range, shadow rule and distance fade as it enters the tree. |
| **Where is it slow?** You find out by flying around. | The **world cost map** predicts triangles, draw calls and shadowed lights per cell from the files, finds the hotspots and writes a benchmark route through them. |
| **Did the optimization break the look?** | `bench` takes a screenshot at every station; `compare` checks them pixel by pixel next to the numbers. Runs use a fixed time step, so the sun and animations are in the same state in both. |
| **Importing on a machine without a GPU hangs** on VRAM-compressed textures (the GPU compressor runs on a software driver). | `import` and `bench` select the CPU compressor for the length of the import. |

Everything an agent changes is journaled: `undo` restores every byte.

## Measured

Two runs on the demo world (`gameoptimizer demo`), every number from `bench` and `compare`. The machine is a
4-core container without a GPU: rendering is Mesa's software Vulkan driver (llvmpipe), so milliseconds only compare
with each other. Counts and memory are exact.

**The 2.4 km world, 19 371 nodes, flown through headless** (script, scene and streaming cost, no rendering):

| | Before | After `install settings textures lights ranges partition` |
| --- | ---: | ---: |
| Frame time p50 (CPU side) | 8.19 ms | **1.31 ms** |
| Frame time p99 | 19.66 ms | **5.31 ms** |
| Hitches during the flight | 66 | **5** |
| Nodes in the tree (max) | 19 371 | **7 877** |
| Static memory | 91 MB | 85 MB |

**A 900 m world, rendered at 8 stations**, step by step, each compared with the step before:

| Step | Nodes | Objects drawn | Draw calls | Picture | Verdict of `compare` |
| --- | ---: | ---: | ---: | --- | --- |
| baseline | 3 127 | 2 033 | 117 | | |
| settings, textures, lights, ranges | 3 130 | 1 658 | 99 | changed on purpose: mipmaps end the shimmer | better |
| + partition with stand-ins | 1 662 | 810 | 335 | **same** (0.4% of pixels) | fewer nodes and culled objects; more draw calls |
| instancing instead (tried, undone) | 928 | 422 | 264 | **same** (0.0%) | regression on this renderer: undone |

What the numbers say, without rounding in our favour:

- Forward+ already draws identical meshes in a handful of draw calls (2 033 objects in 117 calls). Merging them
  into MultiMeshes, by `instancing` or in stand-ins, removes nodes and culling work but adds draw calls and culls
  more coarsely. On a software renderer that cost more frame time than it saved (+13%); on a GPU a few hundred
  draw calls are cheap and the CPU side is what the first table shows. That is why the tool measures, and why
  `instancing` is marked optional. Measure on your target and keep what wins there.
- The picture comparison caught three real mistakes while this tool was built (a too-early light fade, forest
  chunks unloaded too soon, a day cycle that made runs incomparable). That gate is in every `compare`.
- With streaming, video memory rose by 40 MB at one point: the omni shadow atlas, which Godot allocates the first
  time a shadowed lamp is drawn.

Reproduce: `gameoptimizer demo /tmp/world`, then the loop below.

## Install for your agent

The server speaks MCP over stdio. One command, no install step:

```sh
npx -y github:laaielichter/godotwright-gameoptimizer mcp
```

**Claude Code**

```sh
claude mcp add gameoptimizer -- npx -y github:laaielichter/godotwright-gameoptimizer mcp
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.gameoptimizer]
command = "npx"
args = ["-y", "github:laaielichter/godotwright-gameoptimizer", "mcp"]
```

**Gemini CLI, Cursor, VS Code, Windsurf, Cline and other MCP clients** (`mcpServers` in their JSON config)

```json
{
  "mcpServers": {
    "gameoptimizer": {
      "command": "npx",
      "args": ["-y", "github:laaielichter/godotwright-gameoptimizer", "mcp"]
    }
  }
}
```

On Windows, if `npx` does not start from the client: `"command": "cmd", "args": ["/c", "npx", "-y", ...]`.

**No MCP?** Every tool is a CLI command with `--json`. [AGENTS.md](AGENTS.md) and [llms.txt](llms.txt) describe the
loop; [skills/gameoptimizer](skills/gameoptimizer/SKILL.md) is the same as an agent skill.

Measuring needs Godot 4 (4.3 or newer; developed against 4.7.2): pass `godot` or set `GODOT`. The audit, the cost
map and every fix work without it.

## Worlds built from code

```sh
gameoptimizer census path/to/project            # or: --pack game.pck
gameoptimizer fix policy path/to/project
gameoptimizer census path/to/project --label after
```

On the demo built by a script (`gameoptimizer demo /tmp/w --procedural`, 1 101 mesh instances) the first census
reports 1 100 objects without a visibility range, 300 materials used by one object each and a 1024 px texture made
at run time, all traced to `world_builder.gd`. After `fix policy` the second census counts 1 object without a range
(the ground), no tiny shadow casters and no lights without a fade.

## The loop

```text
optimizer_audit                         findings + plan                      no Godot
optimizer_bench   label=baseline        frame times, hitches, draws, memory, screenshots
optimizer_fix     fix=<step>            one step of the plan (dry_run to preview)
optimizer_bench   label=<step>
optimizer_compare run=<step>            better / same / worse, picture same / changed
        keep it, or optimizer_undo
```

## Tools

| Tool | CLI | What it does |
| --- | --- | --- |
| `optimizer_audit` | `audit` | Findings with evidence and the plan. Reads scenes, models, textures, import files, settings, scripts and shaders. |
| `optimizer_costmap` | `costmap` | Predicted cost per world cell, hotspots, a text picture of the map, a benchmark route. |
| `optimizer_census` | `census` | Starts a scene (project or `--pack game.pck`), lets it build, counts the live tree and reports findings. For worlds built from code. |
| `optimizer_textures` | `textures` | GPU memory per texture, largest first. |
| `optimizer_fix` | `fix <name>` | `install`, `policy`, `settings`, `textures`, `lods`, `lights`, `ranges`, `instancing`, `partition`. `dry_run` supported. |
| `optimizer_undo` | `undo [id]` | Takes a fix back; `--list` shows the journal. |
| `optimizer_bench` | `bench` | Runs the game with the probe: percentiles, hitches with position and cause, monitors, screenshots. `stations` or `fly`. |
| `optimizer_compare` | `compare <run>` | Baseline against a run, per metric, per station and per screenshot. Exit code 1 on a regression. |
| `optimizer_import` | `import` | Godot's import, also on machines without a GPU. |
| `optimizer_explain` | `explain <topic>` | Why a finding costs performance in Godot, how the fix works, what to check after. |
| `optimizer_demo` | `demo <dir>` | Writes the heavy open-world demo project. |

## What the audit looks at

- **World**: repeated meshes as separate nodes, repeated scene instances, objects without a visibility range, tiny
  shadow casters, lights without distance fade, cube-shadow omnis, several shadowed suns, sun shadow distance, heavy
  meshes, CSG in levels, no occluders, heavy particle systems, trimesh colliders, body counts, content far from the
  origin (float precision), one scene holding a whole world, far plane without fog, SDFGI, probes that update every
  frame.
- **Textures and models**: 3D textures without VRAM compression or mipmaps, oversized textures, textures embedded
  in models, models imported without LODs.
- **Settings**: occlusion culling, VRAM compression, anisotropic filtering, debanding, physics engine and thread,
  culling thread threshold, MSAA with temporal AA, native high resolution without an upscaler, physics tick rate,
  uncapped frame rate, shadow atlas size. Every path was checked against the Godot 4.7 class reference.
- **The running game** (`census`): the same world rules on the live tree, plus a mesh or a material per object,
  uncompressed and run-time textures, nodes that process every frame, tree size, SubViewports that always update,
  canvas item counts, trimesh faces, distance from the origin. Every row names the script that built the nodes.
- **Scripts**: whole-tree searches from the root, time tests that stay true for a window of frames, label text
  set every frame, textures made from images at run time, node lookups and `load()` on per-frame paths, a `MeshInstance3D` or a material per object in a loop,
  `instantiate()` in loops, collision built from meshes in loops, mesh generation on the main thread, `print` every
  frame, arrays allocated every frame. This is where worlds built from code show up.
- **Shaders**: screen and depth reads, `discard` without a depth prepass, long texture loops.

## The runtime kit

`fix install` copies `addons/gameoptimizer/` into the game and registers its autoloads. Plain GDScript, no
GDExtension, Godot 4.3+.

```gdscript
GOQuality.apply_tier(GOQuality.auto_detect())   # low, medium, high, ultra, cinematic
GOQuality.set_value("scaling_3d_scale", 0.67)   # one key, for a settings menu
GOGovernor.start(60)                             # hold 60 fps with dynamic resolution
GOSpawnQueue.instantiate_async("res://enemy.tscn", parent, func(node): ...)
await prewarm.run(["res://world/world_chunks/Town/c_0_0.tscn"])   # GOPrewarm, behind the loading screen
```

`GOStreamer` nodes are placed by `partition`. The full API is in
[runtime/addons/gameoptimizer/README.md](runtime/addons/gameoptimizer/README.md).

## Limits

- The audit reads text scenes and resources (`.tscn`, `.tres`) and glTF models. Binary `.scn` and `.res` files are
  counted but not opened.
- A world built entirely from code has no scene to partition. `census` shows what the code builds and which
  script builds it, `fix policy` culls it at run time, and the script rules point at the loops; merging nodes into
  MultiMeshes or streaming generated chunks is then a change in that code.
- Stand-ins cover plain meshes. Models placed as `.glb` scenes, skinned meshes, MultiMeshes and anything with a
  light that still shines beyond the load radius stay real nodes in far chunks.
- `instancing` and `partition` leave nodes alone that have a script, a group, children (instancing), a connection
  or a NodePath pointing at them. Code that finds moved nodes by path has to change.
- Occluders are not baked for you (Godot bakes them in the editor); the audit says when they are missing.
- Visibility distances assume a 75° field of view at 1080p; `pixels` and the tiers' `lod_bias` scale them.
- Without a GPU, frame times come from a software renderer and only compare with each other.

## Development

```sh
npm test                      # no dependencies, no Godot
GO_TEST_GODOT=1 npm test      # also runs the runtime kit and a full optimize-and-measure in Godot
```

See [AGENTS.md](AGENTS.md) for the layout and the rules. Issues and pull requests are welcome.

## License

MIT, see [LICENSE](LICENSE).
