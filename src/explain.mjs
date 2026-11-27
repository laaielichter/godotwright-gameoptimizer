// Explanations an agent can ask for: what a finding means in Godot, how the fix works, what to check after.
export const EXPLAIN = {
  workflow: {
    title: "The loop: audit, baseline, fix, measure, keep or undo",
    text: "1. optimizer_audit: findings and a plan. 2. optimizer_bench with label baseline: real numbers on a route through the predicted hotspots. 3. One optimizer_fix at a time, in the plan's order (dry_run first if unsure). 4. optimizer_bench with a new label, optimizer_compare against the baseline. 5. Keep the fix when the verdict is an improvement with the picture unchanged; optimizer_undo when it is a regression. Findings without a fix are code or content changes: optimizer_explain tells you what to change.",
    check: "Each fix is one journal entry. Commit to git between steps so structural fixes are easy to review.",
  },
  streaming: {
    title: "World streaming (partition + GOStreamer)",
    findings: ["world/monolithic-scene", "world/repeated-scene-instances", "world/many-bodies"],
    text: "Godot has no built-in world streaming (proposals 11728 and 7144): a scene is loaded, instantiated and kept in memory as a whole. The partition fix cuts the children of each container node into chunk scenes on a grid and turns the container into a GOStreamer. The streamer loads chunks around the camera with ResourceLoader.load_threaded_request, attaches their nodes within a per-frame time budget (frame_budget_ms), loads chunks ahead of the camera's movement first (predictive), and frees far chunks spread over frames. Objects large enough to be seen from far go into separate far chunks with a long radius, so the skyline stays while the detail streams. Resources that several chunks use are written once to a shared folder, so chunks share meshes and the renderer can still batch across them.",
    check: "Scripts that looked up moved nodes by path must wait for GOStreamer.chunk_loaded, or find them by group. Measure with optimizer_bench mode fly: the hitch list shows frames where a chunk attach went over budget; lower frame_budget_ms or turn on threaded_instantiate.",
  },
  instancing: {
    title: "Instancing per world cell",
    findings: ["world/repeated-mesh-nodes", "script/mesh-node-per-object", "script/material-per-object"],
    text: "A MeshInstance3D per object costs a node, a culled instance and scene-tree memory each. A MultiMesh draws thousands of copies of one mesh in one call, but Godot culls a MultiMesh as one box and gives it one LOD (proposal 10669): a single MultiMesh for a whole forest is always drawn in full. The instancing fix makes one MultiMesh per world cell, placed at the cell centre (which also keeps the floats small), each with a visibility range from the size of its largest instance. Cells behind the camera or out of range are culled as before.",
    check: "Merged nodes no longer exist by name. Per-instance colour or custom data is available through MultiMesh.use_colors / use_custom_data.",
  },
  "visibility-ranges": {
    title: "Visibility ranges sized from the object",
    findings: ["world/no-visibility-range", "world/tiny-shadow-casters", "world/far-plane-without-fog"],
    text: "Godot culls by the view frustum and the far plane; a 20 cm pebble 2 km away is still an instance to cull and a draw. visibility_range_end removes an object beyond a distance. The ranges fix computes that distance per object: where its box is smaller than N pixels on a 1080p screen (default 6). Nothing visible changes at 1080p; the margin gives hysteresis so objects do not flicker at the boundary. GOQuality's lod_bias scales all ranges per quality tier at run time. HLOD (a far proxy that replaces a group) is the same property with visibility_range_begin on the proxy.",
    check: "Compare screenshots with optimizer_compare. Raise pixels for a more aggressive cut on low tiers through lod_bias, not in the scene.",
  },
  "quality-tiers": {
    title: "Quality tiers (GOQuality)",
    findings: ["runtime/no-quality-tiers", "settings/native-high-resolution", "world/sdfgi-open-world"],
    text: "Project settings are read at start; most render settings must be changed through the Viewport and the RenderingServer to take effect in a running game. GOQuality does that: five tiers (low, medium, high, ultra, cinematic) in quality_tiers.json set resolution scale and upscaler (bilinear, FSR 1, FSR 2), anti-aliasing, shadow atlas sizes and filter quality, mesh LOD threshold, visibility-range bias, SSAO, SSIL, SSR, SDFGI, glow, volumetric fog, anisotropic filtering, vsync and the frame cap. A tier never switches on an effect the scene's artist did not use. auto_detect picks a tier for the machine; set_value changes one key for a settings menu; save keeps the player's choice.",
    check: "Run optimizer_bench with tier low and tier ultra to see the range the tiers give this game.",
  },
  governor: {
    title: "Adaptive quality (GOGovernor)",
    text: "Godot has no dynamic resolution. GOGovernor holds a target frame rate by moving scaling_3d_scale between a minimum and a maximum, from a smoothed frame time; single hitches (a chunk load, a shader compile) are ignored so they do not drop the resolution. When the lowest scale is still too slow it steps down a ladder of settings (shadow quality, LOD threshold, SSR, volumetric fog), and climbs back when there is headroom. It uses overrides, so the player's saved settings are untouched.",
    check: "GOGovernor.start(60) after loading; GOGovernor.get_state() shows scale and ladder level.",
  },
  "shader-stutter": {
    title: "Shader and pipeline compilation stutter",
    text: "Godot 4.4 added ubershaders and pipeline precompilation at load time for Forward+ and Mobile, which removed most first-sight stutter. Still not covered: features that turn on mid-game (a new MSAA level, the first VoxelGI), material overrides set on nodes at run time, content that arrives by streaming after the load screen, and driver caches wiped by a driver update. GOPrewarm draws every unique material and vertex format (also as shadow caster and as MultiMesh) a few centimetres across for a few frames behind the loading screen, so the pipelines exist before the player sees the object. The probe counts pipeline compilations per frame, so optimizer_bench shows whether hitches come from compiles.",
    check: "optimizer_bench mode fly: pipeline_compiles and the hitches' compile counts.",
  },
  textures: {
    title: "Texture memory",
    findings: ["textures/uncompressed-3d", "textures/no-mipmaps-3d", "textures/oversized", "textures/embedded-in-models", "textures/not-imported"],
    text: "Godot 4.7 has no texture streaming (proposal 3177; an experimental StreamedTexture2D arrives in 4.8): every texture of every loaded scene is in VRAM in full. A lossless or lossy texture is small on disk but uploaded at 4 bytes per pixel; VRAM compression (S3TC/BPTC) is 4 to 8 times smaller and samples faster. The editor switches a texture to VRAM compression the first time it sees it on a 3D material, but a project assembled on the command line or by an agent never gets that pass. The textures fix sets compression and mipmaps in the .import files of textures used by 3D materials and turns on import_s3tc_bptc. With world streaming, texture memory also follows what is loaded.",
    check: "Re-import (optimizer_import or optimizer_bench with reimport), then compare texture memory. Normal maps keep their own detection.",
  },
  shadows: {
    title: "Shadows and lights",
    findings: ["world/lights-without-distance-fade", "world/many-cube-shadow-omnis", "world/several-shadowed-suns", "world/sun-shadow-distance", "settings/shadow-atlas-size"],
    text: "A shadowed omni light renders the scene 6 times (cube) or 2 times (dual paraboloid); a sun renders it once per cascade. Any moving object in a light's range re-renders that shadow map. Distance fade switches a light, and earlier its shadow, off beyond a distance: the lights fix sets it from each light's range. Tiny objects are taken out of the shadow passes by the ranges fix. Tiers change atlas sizes and filter quality at run time.",
    check: "optimizer_compare: draw calls at the stations in towns drop; the pictures stay the same within the fade distance.",
  },
  occlusion: {
    title: "Occlusion culling",
    findings: ["world/no-occluders"],
    text: "Without occluders Godot draws everything in the view frustum, also what is behind a hill or a building. Occlusion culling needs OccluderInstance3D nodes with baked occluders (the editor bakes them from the meshes under the node) and the project setting rendering/occlusion_culling/use_occlusion_culling. Use terrain, buildings and large walls as occluders; keep them simple. Streamed chunks can each carry their occluder.",
    check: "The settings fix turns the setting on; baking is done in the editor (select the OccluderInstance3D, Bake Occluders).",
  },
  precision: {
    title: "Large worlds and float precision",
    findings: ["world/far-from-origin"],
    text: "Positions are 32-bit floats: 8 km from the origin the smallest step is about a millimetre and shadows, physics and animation start to jitter; at 50 km it is centimetres. Either build Godot with double precision (also the export templates and every GDExtension), or shift the origin: keep the player near 0,0,0 by moving the world root. GOStreamer measures in its own local space, so chunks follow when the streamer's parent is moved.",
    check: "Look for jitter at the far corners of the map; Jolt also limits the world boundary shape size.",
  },
  physics: {
    title: "Physics at scale",
    findings: ["world/many-trimesh-colliders", "settings/high-physics-tick", "script/trimesh-in-loop"],
    text: "Every body in the tree is in the physics space, awake or not. Concave (trimesh) shapes are the slowest and only valid on static bodies. Jolt is several times faster than Godot Physics with many bodies; physics on a separate thread takes the step off the main thread. Streaming removes the bodies of far chunks. A high tick rate multiplies all of it and all _physics_process code.",
    check: "optimizer_bench reports physics_ms and physics_active_objects.",
  },
  scripts: {
    title: "Per-frame script cost and hitches",
    findings: ["script/"],
    text: "GDScript calls every _process and _physics_process of every node, each frame, visible or not. Node lookups by path or group inside them walk the tree each time. load(), instantiate() and add_child() run on the main thread: in a loop they are one long frame. Fixes: cache nodes in @onready variables; stop processing far objects; move repeated work into one manager; load with ResourceLoader.load_threaded_request; attach through GOSpawnQueue, which spends a fixed time per frame; build meshes on WorkerThreadPool and assign them with call_deferred.",
    check: "optimizer_bench headless shows process_ms and physics_ms without the GPU in the way.",
  },
};
