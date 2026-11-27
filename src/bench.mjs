// Measuring: runs the game with the probe on a fixed camera route, saves the report, and compares two reports
// (frame times, hitches, draw calls, memory, and the screenshots of every station pixel by pixel).
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, copyFileSync } from "node:fs";
import { join, delimiter, resolve } from "node:path";
import { Project, OptimizerError } from "./project.mjs";
import { World } from "./world.mjs";
import { buildCostMap, routeFromCostMap } from "./costmap.mjs";
import { editProjectSettings } from "./fix/settings.mjs";
import { RUNTIME_DIR } from "./fix/install.mjs";
import { decodePng } from "./png.mjs";

export function findGodot(explicit, env = process.env) {
  for (const c of [explicit, env.GODOT, env.GODOT_BIN, env.GODOT4]) {
    if (c && !c.includes("${") && existsSync(c)) return resolve(c);
  }
  const names = process.platform === "win32" ? ["godot.exe", "godot4.exe", "godot.cmd"] : ["godot", "godot4", "godot-4"];
  for (const dir of (env.PATH ?? "").split(delimiter)) for (const n of names) if (dir && existsSync(join(dir, n))) return join(dir, n);
  throw new OptimizerError("Godot was not found.", "Pass `godot` with the path of the Godot 4 binary, or set the GODOT environment variable. The audit, the cost map and every fix work without Godot; only measuring needs it.");
}

export function runProcess(cmd, args, { timeoutMs = 600_000, env } = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const take = (d) => {
      out += d.toString();
      if (out.length > 400_000) out = out.slice(-200_000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: -1, out: out + String(e), timedOut: false });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ code: code ?? -1, out, timedOut: signal === "SIGKILL" });
    });
  });
}

export function wrapDisplay(cmd, args, headless) {
  if (headless) return [cmd, ["--headless", ...args]];
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    const x = spawnSync("which", ["xvfb-run"]);
    if (x.status === 0) return ["xvfb-run", ["-a", cmd, ...args]];
    return [cmd, ["--headless", ...args]];
  }
  return [cmd, args];
}

/**
 * Imports the project's assets (what the editor does on open). Godot compresses VRAM textures on the GPU by default;
 * without a real GPU (a build server, a container, an agent's sandbox) that step runs on a software Vulkan driver
 * and takes minutes per texture or never ends. So for the length of the import the CPU compressor is selected,
 * unless the project set the option itself. The imported files are the same format either way.
 */
export async function importProject(project, godot, { timeoutMs = 1_800_000, cpuCompress = true } = {}) {
  const file = join(project.root, "project.godot");
  const before = readFileSync(file, "utf8");
  const key = "rendering/textures/vram_compression/compress_with_gpu";
  const override = cpuCompress && project.setting(key) === undefined;
  if (override) writeFileSync(file, editProjectSettings(before, { [key]: false }));
  try {
    const r = await runProcess(godot, ["--headless", "--path", project.root, "--import"], { timeoutMs });
    const errors = r.out.split("\n").filter((l) => /^(ERROR|SCRIPT ERROR)/.test(l) && !/alsa|audio|pulse/i.test(l));
    return { ok: !r.timedOut, timed_out: r.timedOut, errors: errors.slice(0, 20) };
  } finally {
    if (override) writeFileSync(file, before);
  }
}

const stateDir = (project) => join(project.root, ".gameoptimizer");

/** The benchmark route of a scene: made once from the cost map and then reused, so every run sees the same views. */
export function routeFor(project, scene, { regenerate = false, mode = "stations", viewDistance } = {}) {
  const dir = stateDir(project);
  const file = join(dir, "routes", scene.replace(/[\/\\]/g, "__") + ".json");
  if (existsSync(file) && !regenerate) return { file, route: JSON.parse(readFileSync(file, "utf8")), reused: true };
  const world = new World(project);
  const flat = world.flatten(scene);
  const map = buildCostMap(flat.objects, { viewDistance });
  let route = routeFromCostMap(map, { mode });
  if (!route) {
    const cam = flat.objects.find((o) => o.kind === "camera");
    if (!cam) return { file: null, route: null, reused: false };
    return { file: null, route: null, reused: false };
  }
  mkdirSync(join(dir, "routes"), { recursive: true });
  if (!existsSync(join(dir, ".gdignore"))) writeFileSync(join(dir, ".gdignore"), "");
  writeFileSync(file, JSON.stringify(route, null, 1));
  return { file, route, reused: false };
}

/**
 * Runs the game with the probe and returns its report. Options: scene, label, frames, warmup, tier, route (a file),
 * mode ("stations" or "fly"), headless, resolution "WxH", renderer, godot, shots (default true), importFirst.
 */
export async function bench(root, options = {}) {
  const project = root instanceof Project ? root : new Project(root);
  const godot = findGodot(options.godot);
  const scene = options.scene ? project.rel(options.scene) : project.mainScene;
  if (!scene) throw new OptimizerError("No scene to measure.", "Pass `scene`, or set a main scene in the project.");
  const dir = stateDir(project);
  mkdirSync(join(dir, "bench"), { recursive: true });
  if (!existsSync(join(dir, ".gdignore"))) writeFileSync(join(dir, ".gdignore"), "");
  const label = (options.label ?? `run-${readdirSync(join(dir, "bench")).filter((f) => f.endsWith(".json")).length + 1}`).replace(/[^A-Za-z0-9_.-]/g, "_");
  const out = join(dir, "bench", `${label}.json`);
  const shotsDir = join(dir, "bench", label);
  rmSync(out, { force: true });
  rmSync(shotsDir, { recursive: true, force: true });

  let routeFile = options.route ? resolve(options.route) : null;
  let routeInfo = null;
  if (!routeFile && options.route !== false) {
    routeInfo = routeFor(project, scene, { mode: options.mode ?? "stations", regenerate: options.newRoute });
    routeFile = routeInfo.file;
    if (routeFile && options.mode && routeInfo.route.mode !== options.mode) {
      routeFile = join(dir, "routes", `${options.mode}-` + scene.replace(/[\/\\]/g, "__") + ".json");
      writeFileSync(routeFile, JSON.stringify({ ...routeInfo.route, mode: options.mode }, null, 1));
    }
  }

  // The probe is an autoload. A project without the runtime kit gets it for the length of the run only.
  const probeTarget = join(project.root, "addons", "gameoptimizer", "go_probe.gd");
  // "Has the kit" means the whole kit: a lone probe file is a leftover of an interrupted run and is replaced.
  const hadProbe = existsSync(probeTarget) && existsSync(join(project.root, "addons", "gameoptimizer", "go_quality.gd"));
  const hadFolder = existsSync(join(project.root, "addons", "gameoptimizer"));
  const settingsFile = join(project.root, "project.godot");
  const settingsBefore = readFileSync(settingsFile, "utf8");
  const needAutoload = project.setting("autoload/GOProbe") === undefined;
  const staleAutoload = !needAutoload && !hadProbe; // left behind by an interrupted run
  const cleanup = [];
  const runCleanup = () => {
    for (const c of cleanup.splice(0).reverse()) {
      try {
        c();
      } catch {
        /* best effort */
      }
    }
  };
  // Also put the project back when this process is stopped mid-run.
  const onSignal = () => {
    runCleanup();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    if (!hadProbe) {
      mkdirSync(join(project.root, "addons", "gameoptimizer"), { recursive: true });
      copyFileSync(join(RUNTIME_DIR, "go_probe.gd"), probeTarget);
      cleanup.push(() => rmSync(probeTarget, { force: true }), () => rmSync(probeTarget + ".uid", { force: true }));
      if (!hadFolder) cleanup.push(() => rmSync(join(project.root, "addons", "gameoptimizer"), { recursive: true, force: true }));
    }
    if (needAutoload) {
      writeFileSync(settingsFile, editProjectSettings(settingsBefore, { "autoload/GOProbe": "*res://addons/gameoptimizer/go_probe.gd" }));
      cleanup.push(() => writeFileSync(settingsFile, settingsBefore));
    } else if (staleAutoload) {
      cleanup.push(() => writeFileSync(settingsFile, editProjectSettings(settingsBefore, { "autoload/GOProbe": undefined })));
    }
    let imported = null;
    if (options.importFirst ?? (!existsSync(join(project.root, ".godot", "imported")) || options.reimport)) imported = await importProject(project, godot);
    const args = ["--path", project.root];
    if (options.renderer) args.push("--rendering-method", options.renderer);
    if (options.resolution) args.push("--resolution", options.resolution);
    // A fixed time step: every frame advances the game by the same amount whatever the machine's speed, so two
    // runs see the same animation, sun and physics state at the same frame. Frame times are still wall-clock.
    const fixedFps = options.fixedFps ?? 60;
    if (fixedFps > 0) args.push("--fixed-fps", String(fixedFps));
    args.push(`res://${scene}`, "--");
    args.push(`--go-probe=${out}`, `--go-frames=${options.frames ?? 300}`, `--go-warmup=${options.warmup ?? 30}`, "--go-wait-settled=1");
    if (routeFile) args.push(`--go-route=${routeFile}`);
    if (options.shots !== false && !options.headless) {
      mkdirSync(shotsDir, { recursive: true });
      args.push(`--go-shots=${shotsDir}`);
    }
    if (options.tier) args.push(`--go-tier=${options.tier}`);
    const [cmd, full] = wrapDisplay(godot, args, options.headless);
    const started = Date.now();
    const r = await runProcess(cmd, full, { timeoutMs: options.timeoutMs ?? 900_000 });
    if (!existsSync(out)) {
      const lines = r.out.split("\n").filter((l) => l.trim() && !/ALSA|snd_|audio/i.test(l));
      const tail = [...lines.filter((l) => /^(SCRIPT ERROR|ERROR)/.test(l)).slice(0, 10), ...lines.slice(-15)].join("\n");
      throw new OptimizerError(`The run wrote no report${r.timedOut ? " (timed out)" : ` (exit code ${r.code})`}.`, `Last output of Godot:\n${tail}`);
    }
    const report = JSON.parse(readFileSync(out, "utf8"));
    const all = r.out.split("\n").filter((l) => /^(SCRIPT ERROR|ERROR)/.test(l) && !/alsa|audio|pulse|status < 0/i.test(l));
    // What the engine reports while it shuts down is kept apart from errors of the run itself.
    const atExit = (l) => /at exit|never freed|leaked at exit|still in use/.test(l);
    const scriptErrors = all.filter((l) => !atExit(l));
    const exitLeaks = all.filter(atExit).length;
    const result = { label, file: out, scene, seconds: Math.round((Date.now() - started) / 100) / 10, route: routeFile, shots: existsSync(shotsDir) ? shotsDir : null, imported, errors: [...new Set(scriptErrors)].slice(0, 15), exit_leak_messages: exitLeaks, report };
    writeFileSync(out, JSON.stringify({ ...report, label, route: routeFile, errors: result.errors }, null, 1));
    return result;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    runCleanup();
  }
}

export function loadReport(project, labelOrFile) {
  const candidates = [labelOrFile, join(stateDir(project), "bench", `${labelOrFile}.json`), join(stateDir(project), "bench", labelOrFile)];
  for (const c of candidates) if (c && existsSync(c) && c.endsWith(".json")) return { file: resolve(c), report: JSON.parse(readFileSync(c, "utf8")) };
  const have = existsSync(join(stateDir(project), "bench")) ? readdirSync(join(stateDir(project), "bench")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
  throw new OptimizerError(`No benchmark report "${labelOrFile}".`, have.length ? `Reports here: ${have.join(", ")}.` : "Run optimizer_bench first.");
}

/** Pixel comparison of two screenshots: the share of pixels that changed and the mean difference. */
export function diffShots(fileA, fileB, { tolerance = 24 } = {}) {
  const a = decodePng(readFileSync(fileA));
  const b = decodePng(readFileSync(fileB));
  if (a.width !== b.width || a.height !== b.height) return { comparable: false, reason: `sizes differ (${a.width}x${a.height} and ${b.width}x${b.height})` };
  let changed = 0;
  let sum = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    const d = Math.abs(a.data[k] - b.data[k]) + Math.abs(a.data[k + 1] - b.data[k + 1]) + Math.abs(a.data[k + 2] - b.data[k + 2]);
    sum += d;
    if (d > tolerance * 3) changed++;
  }
  return { comparable: true, changed_percent: Math.round((changed / n) * 10000) / 100, mean_difference: Math.round((sum / n / 3) * 100) / 100 };
}

const pct = (a, b) => (a > 0 ? Math.round(((b - a) / a) * 1000) / 10 : 0);

/** Compares a run with a baseline. `budget` is the frame budget in ms for the verdict on hitches. */
export function compare(project, baseLabel, newLabel, { noise = 5, visualLimit = 2.0 } = {}) {
  const A = loadReport(project, baseLabel);
  const B = loadReport(project, newLabel);
  const a = A.report;
  const b = B.report;
  const row = (name, x, y, lowerIsBetter = true) => {
    if (typeof x !== "number" || typeof y !== "number") return null;
    const change = pct(x, y);
    const verdict = Math.abs(change) <= noise ? "same" : (change < 0) === lowerIsBetter ? "better" : "worse";
    return { metric: name, before: round(x), after: round(y), change_percent: change, verdict };
  };
  const rows = [
    row("frame_ms p50", a.frame_ms?.p50, b.frame_ms?.p50),
    row("frame_ms p95", a.frame_ms?.p95, b.frame_ms?.p95),
    row("frame_ms p99", a.frame_ms?.p99, b.frame_ms?.p99),
    row("frame_ms max", a.frame_ms?.max, b.frame_ms?.max),
    row("hitches", a.hitch_count, b.hitch_count),
    row("draw calls (avg)", a.monitors?.draw_calls?.avg, b.monitors?.draw_calls?.avg),
    row("draw calls (max)", a.monitors?.draw_calls?.max, b.monitors?.draw_calls?.max),
    row("primitives (avg)", a.monitors?.primitives?.avg, b.monitors?.primitives?.avg),
    row("objects drawn (avg)", a.monitors?.objects?.avg, b.monitors?.objects?.avg),
    row("video memory MB (max)", a.monitors?.video_mem_mb?.max, b.monitors?.video_mem_mb?.max),
    row("texture memory MB (max)", a.monitors?.texture_mem_mb?.max, b.monitors?.texture_mem_mb?.max),
    row("nodes (max)", a.monitors?.nodes?.max, b.monitors?.nodes?.max),
    row("static memory MB (max)", a.monitors?.static_mem_mb?.max, b.monitors?.static_mem_mb?.max),
  ].filter(Boolean);
  // Stations: frame time and the picture.
  const stations = [];
  const dirA = A.file.replace(/\.json$/, "");
  const dirB = B.file.replace(/\.json$/, "");
  let worstVisual = 0;
  const count = Math.min(a.stations?.length ?? 0, b.stations?.length ?? 0);
  for (let i = 0; i < count; i++) {
    const sa = a.stations[i];
    const sb = b.stations[i];
    const st = { station: i, frame_ms_p50: [round(sa.frame_ms?.p50), round(sb.frame_ms?.p50)], draw_calls: [sa.draw_calls, sb.draw_calls], primitives: [sa.primitives, sb.primitives] };
    const fa = sa.shot && join(dirA, sa.shot);
    const fb = sb.shot && join(dirB, sb.shot);
    if (fa && fb && existsSync(fa) && existsSync(fb)) {
      try {
        st.picture = diffShots(fa, fb);
        if (st.picture.comparable) worstVisual = Math.max(worstVisual, st.picture.changed_percent);
      } catch (e) {
        st.picture = { comparable: false, reason: String(e.message ?? e) };
      }
    }
    stations.push(st);
  }
  const hasPictures = stations.some((s) => s.picture?.comparable);
  const speed = rows.filter((r) => r.metric.startsWith("frame_ms p"));
  const worse = speed.filter((r) => r.verdict === "worse").length;
  const better = speed.filter((r) => r.verdict === "better").length;
  const performance = worse > 0 && better === 0 ? "worse" : better > 0 && worse === 0 ? "better" : worse > 0 ? "mixed" : "same";
  const visual = !hasPictures ? "not compared" : worstVisual <= visualLimit ? "same" : "changed";
  const sameSetup = a.renderer === b.renderer && JSON.stringify(a.resolution) === JSON.stringify(b.resolution) && a.adapter === b.adapter;
  return {
    baseline: baseLabel,
    run: newLabel,
    performance,
    visual,
    worst_picture_change_percent: hasPictures ? worstVisual : null,
    verdict: performance === "worse" ? "regression: undo the last step or tune it" : visual === "changed" ? "faster or equal, but the picture changed: look at the screenshots of the stations listed" : performance === "better" ? "improvement, picture unchanged" : "no measurable change",
    metrics: rows,
    stations,
    warnings: [...(sameSetup ? [] : ["The two runs differ in renderer, resolution or GPU: the numbers are not comparable."]), ...(/llvmpipe|lavapipe|swiftshader/i.test(String(b.adapter)) ? ["Software renderer: frame times show CPU-side and relative cost, not what a GPU will do. Draw calls, primitives, nodes and memory are exact."] : [])],
    shots: hasPictures ? { before: dirA, after: dirB } : null,
  };
}

const round = (v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v);
