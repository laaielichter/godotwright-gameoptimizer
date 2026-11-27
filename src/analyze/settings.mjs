// Project settings rules. Every path and default here was checked against the Godot 4.7 class reference.

/** Settings the `settings` fix writes: safe for any 3D project, no visible change unless noted. */
export function recommendedSettings(project, ctx = {}) {
  const rec = [];
  const cur = (p) => project.setting(p);
  const is3d = ctx.is3d !== false;
  const openWorld = !!ctx.openWorld;
  const want = (path, value, why, { when = true, visual = false } = {}) => {
    if (!when) return;
    const now = cur(path);
    if (JSON.stringify(now) === JSON.stringify(value)) return;
    rec.push({ path, value, current: now === undefined ? null : now, why, visual });
  };
  if (!is3d) return rec;
  const rd = project.renderer !== "gl_compatibility";
  want("rendering/occlusion_culling/use_occlusion_culling", true, "Occluders do nothing while this is off. It costs nothing without occluders, and lets baked ones hide what is behind buildings and terrain.", { when: cur("rendering/occlusion_culling/use_occlusion_culling") !== true });
  want("rendering/textures/vram_compression/import_s3tc_bptc", true, "Needed for VRAM-compressed textures on desktop.", { when: cur("rendering/textures/vram_compression/import_s3tc_bptc") !== true && ctx.exportsDesktop !== false });
  want("rendering/textures/default_filters/anisotropic_filtering_level", 4, "16x anisotropic filtering: roads and ground stay sharp at grazing angles. Nearly free on desktop GPUs.", { when: (cur("rendering/textures/default_filters/anisotropic_filtering_level") ?? 2) < 3, visual: true });
  want("rendering/anti_aliasing/quality/use_debanding", true, "Removes the banding in skies and fog gradients for almost nothing.", { when: rd && cur("rendering/anti_aliasing/quality/use_debanding") !== true, visual: true });
  want("physics/3d/run_on_separate_thread", true, "Physics steps on its own thread, off the main thread's frame time.", { when: cur("physics/3d/run_on_separate_thread") !== true && ctx.manyBodies });
  want("physics/3d/physics_engine", "Jolt Physics", "Jolt is several times faster than Godot Physics with many bodies and is the default for new projects.", { when: (cur("physics/3d/physics_engine") ?? "DEFAULT") === "DEFAULT" && ctx.manyBodies && versionAtLeast(project, 4, 4) });
  want("rendering/limits/spatial_indexer/threaded_cull_minimum_instances", 500, "Culling goes multithreaded from this many instances; open worlds are always past it.", { when: openWorld && (cur("rendering/limits/spatial_indexer/threaded_cull_minimum_instances") ?? 1000) > 500 });
  want("rendering/mesh_lod/lod_change/threshold_pixels", 1.0, "Above 1 pixel the automatic mesh LODs visibly pop; the quality tiers change this per tier at run time instead.", { when: (cur("rendering/mesh_lod/lod_change/threshold_pixels") ?? 1) > 4 });
  return rec;
}

function versionAtLeast(project, major, minor) {
  const v = project.engineVersion;
  if (!v) return true;
  const [a, b] = v.split(".").map(Number);
  return a > major || (a === major && b >= minor);
}

export function analyzeSettings(project, ctx = {}) {
  const out = [];
  const cur = (p) => project.setting(p);
  const is3d = ctx.is3d !== false;
  const rec = recommendedSettings(project, ctx);
  if (rec.length) {
    out.push({
      id: "settings/recommended",
      severity: "medium",
      category: "settings",
      title: `${rec.length} project settings hold the game back`,
      detail: "Safe engine settings for a 3D game of this size. None of them changes how the game looks, except where marked.",
      evidence: rec.map((r) => ({ setting: r.path, now: r.current, set: r.value, why: r.why })),
      fix: { fix: "settings" },
      risk: "safe",
    });
  }
  if (!is3d) return out;
  const scale = cur("rendering/scaling_3d/scale") ?? 1;
  const mode = cur("rendering/scaling_3d/mode") ?? 0;
  const msaa = cur("rendering/anti_aliasing/quality/msaa_3d") ?? 0;
  const taa = cur("rendering/anti_aliasing/quality/use_taa") === true;
  const w = cur("display/window/size/viewport_width") ?? 1152;
  const h = cur("display/window/size/viewport_height") ?? 648;
  if (msaa >= 2 && (taa || mode === 2)) out.push({ id: "settings/msaa-with-temporal-aa", severity: "medium", category: "settings", title: "MSAA and temporal anti-aliasing are both on", detail: "MSAA 4x multiplies the cost of every pixel edge and FSR2/TAA already resolve the same edges. Use one: FSR2 or TAA for an open world with foliage, MSAA for clean geometry.", fix: null, risk: "visual" });
  if (msaa >= 3) out.push({ id: "settings/msaa-8x", severity: "medium", category: "settings", title: "MSAA 8x", detail: "8x costs far more than 4x for a difference few players can see. The quality tiers use 4x at most.", fix: null, risk: "visual" });
  if (w * h >= 2560 * 1440 && scale >= 1 && mode === 0 && !ctx.hasQualityKit) {
    out.push({ id: "settings/native-high-resolution", severity: "medium", category: "settings", title: `Renders 3D at ${w}x${h} with no upscaler`, detail: "Pixel cost is the largest part of a Forward+ frame. FSR2 at 67% scale draws 45% of the pixels and reconstructs the rest; it also anti-aliases. GOQuality's tiers set scale, upscaler and sharpness together, and GOGovernor moves the scale at run time to hold the frame rate.", fix: { fix: "install" }, risk: "visual" });
  }
  const ticks = cur("physics/common/physics_ticks_per_second") ?? 60;
  if (ticks > 60 && cur("physics/common/physics_interpolation") === true) out.push({ id: "settings/high-physics-tick", severity: "low", category: "physics", title: `${ticks} physics ticks per second with interpolation on`, detail: "Physics interpolation already makes 60 ticks look smooth at any frame rate; every extra tick runs all _physics_process code and the physics step again. Keep the high rate only if the simulation itself needs it (fast vehicles, flight models).", fix: null, risk: "gameplay" });
  if ((cur("display/window/vsync/vsync_mode") ?? 1) === 0 && (cur("application/run/max_fps") ?? 0) === 0) out.push({ id: "settings/uncapped-fps", severity: "low", category: "settings", title: "V-Sync off and no frame cap", detail: "The GPU runs flat out in menus and light scenes: heat, fan noise and uneven frame pacing. Set application/run/max_fps or let GOQuality apply the player's choice.", fix: null, risk: "none" });
  const atlas = cur("rendering/lights_and_shadows/positional_shadow/atlas_size") ?? 4096;
  if (atlas > 8192) out.push({ id: "settings/shadow-atlas-size", severity: "low", category: "shadows", title: `Positional shadow atlas of ${atlas}`, detail: "16384 is 1 GB of depth at 32 bits. 4096 with 16 bits is enough for most scenes; raise it per tier.", fix: null, risk: "visual" });
  if (project.renderer === "gl_compatibility" && ctx.openWorld) out.push({ id: "settings/compatibility-renderer", severity: "info", category: "settings", title: "Compatibility renderer", detail: "No clustered lighting, FSR2, SDFGI, volumetric fog or pipeline precompilation here. Fine for low-end targets; a heavy open world on desktop wants Forward+.", fix: null, risk: "none" });
  return out;
}
