# AGENTS.md

Guide for coding agents: first how to use the optimizer on a game, then how to work on this repository.

## Using the optimizer on a Godot project

Start the MCP server (`npx -y github:laaielichter/godotwright-gameoptimizer mcp`) or call the CLI
(`npx -y github:laaielichter/godotwright-gameoptimizer <command>`). Every tool returns JSON.

The loop:

1. `optimizer_audit`: findings with evidence, and a plan (the fixes in order, each a ready `optimizer_fix` call).
   Needs no Godot and takes seconds.
2. `optimizer_bench` with `label: "baseline"`: measured frame times, hitches, draw calls, memory and a screenshot per
   station, on a camera route through the predicted hotspots. Needs Godot 4 (`godot` input or `$GODOT`).
3. One `optimizer_fix` at a time, in the plan's order. Use `dry_run` first when unsure.
4. `optimizer_bench` with a new label, then `optimizer_compare`. After the `textures` or `lods` fix pass
   `reimport: true`.
5. Keep the fix when the verdict is an improvement with the picture unchanged. `optimizer_undo` when it is a
   regression, or tune the fix (`pixels`, `cell_size`, `load_radius`) and try again.
6. Findings without a fix are code or content changes. `optimizer_explain` with the finding id says what to change.

A world that is built from code (or a game that only exists as a `.pck`) has no scene file for the audit to read.
Use `optimizer_census` (with `pack` for a .pck): it runs the game and counts the live tree, and its findings name
the script that built the nodes. `optimizer_fix {fix: "policy"}` applies the culling rules at run time; the rest is
a change in the code that the finding points at.

Rules of thumb:

- Never apply `instancing` or `partition` without a baseline: they are structural. Commit to git before each.
- `instancing` is optional (the plan says so): it trades nodes for draw calls. Keep it only when the comparison
  on the target hardware is better.
- `partition` needs `install` first. Scripts that looked up moved nodes by path must wait for
  `GOStreamer.chunk_loaded` or use groups; the fix leaves nodes alone that a connection or a NodePath refers to.
- On a machine without a GPU (a container, CI) frame times come from a software renderer: trust draw calls,
  primitives, node counts and memory; treat milliseconds as relative.
- State lives in `<project>/.gameoptimizer/` (journal, routes, benchmark reports and screenshots). It holds a
  `.gdignore`, so Godot does not import it. Add it to `.gitignore`.

## Working on this repository

```sh
npm test                      # node --test, no dependencies, no Godot needed
GO_TEST_GODOT=1 npm test      # also the tests that run Godot (set GODOT or have godot on PATH)
node bin/gameoptimizer.mjs --help
```

Node 20 or newer, ESM, zero runtime dependencies, no build step: `npx github:...` must work from a clean clone.

### Layout

- `bin/gameoptimizer.mjs`: entry point. `src/cli.mjs`: commands and text output. `src/mcp.mjs`: MCP over stdio.
- `src/tools.mjs`: every tool once (schema and handler); the CLI and the MCP server both read it. A new tool or
  input goes here, then into `README.md`, `llms.txt`, `skills/gameoptimizer/SKILL.md` and a test.
- `src/godot/`: readers without I/O policy: `variant.mjs` (Variant text and transform math), `tscn.mjs` (lossless
  sections of .tscn, .tres, project.godot, .import), `glb.mjs` (glTF), `image.mjs` (image headers, VRAM estimate),
  `gdscript.mjs` (functions and loops by indentation).
- `src/project.mjs`: files, settings, import files, uid lookup. `src/world.mjs`: the world model (scenes flattened
  into objects with world transforms, boxes, triangles, surfaces). `src/costmap.mjs`: cost per cell, hotspots, route.
- `src/analyze/`: the rules (`world`, `textures`, `settings`, `scripts`, `shaders`). `src/audit.mjs` runs them and
  builds the plan. `src/explain.mjs`: the texts of `optimizer_explain`.
- `src/fix/`: the fixes (`settings.mjs` also holds the .import edits, `scene.mjs` lights, ranges and instancing,
  `partition.mjs`, `install.mjs`). Every fix writes through a `Transaction` (`src/journal.mjs`): dry run and undo
  come from there, never write files directly.
- `src/census.mjs`: runs `runtime/tools/go_census.gd` (a SceneTree script with no dependencies) on a project or a
  pack and turns the report into findings.
- `src/bench.mjs`: runs Godot with the probe, imports, compares reports and screenshots. `src/png.mjs`: PNG codec.
- `src/demo.mjs`: the demo open world (also the test fixture).
- `runtime/addons/gameoptimizer/`: the GDScript kit that `install` copies into a game. Its `README.md` is the API.

### Rules

- A rule must be quiet on a project that does it right: test both ways. Every setting path and default must exist
  in the Godot version named in the README; look it up, do not write it from memory.
- A fix must be exact (the tests count objects before and after), reversible (undo restores every byte) and
  idempotent (a second run changes nothing).
- Scene files are edited as sections; an untouched section is written back byte for byte.
- Numbers in the README come from `optimizer_bench` runs on the demo world; say which machine and renderer.
- Changes to the runtime kit are run in Godot (`GO_TEST_GODOT=1 npm test` runs its self-test).
- Commits and credit: see `CLAUDE.md`.
