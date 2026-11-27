// Installs the runtime kit (addons/gameoptimizer) and registers its autoloads.
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { editProjectSettings } from "./settings.mjs";

export const RUNTIME_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "runtime", "addons", "gameoptimizer");
const AUTOLOADS = [
  ["GOQuality", "go_quality.gd"],
  ["GOGovernor", "go_governor.gd"],
  ["GOSpawnQueue", "go_spawn_queue.gd"],
  ["GOProbe", "go_probe.gd"],
];

export function fixInstall(project, tx) {
  const files = [];
  const walk = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(abs, e.name), `${rel}${e.name}/`);
      else if (!e.name.endsWith(".uid") && !e.name.endsWith(".import")) files.push(rel + e.name);
    }
  };
  walk(RUNTIME_DIR, "");
  let written = 0;
  for (const f of files) {
    const content = readFileSync(join(RUNTIME_DIR, f));
    const target = `addons/gameoptimizer/${f}`;
    // A tier file the project has tuned is the project's: never overwrite it.
    if (f === "quality_tiers.json" && project.exists(target)) continue;
    const now = project.exists(target) ? readFileSync(project.abs(target)) : null;
    if (!now || !now.equals(content)) {
      tx.write(target, content);
      written++;
    }
  }
  const values = {};
  const added = [];
  for (const [name, file] of AUTOLOADS) {
    const want = `*res://addons/gameoptimizer/${file}`;
    if (project.setting(`autoload/${name}`) !== want) {
      values[`autoload/${name}`] = want;
      added.push(name);
    }
  }
  if (added.length) tx.write("project.godot", editProjectSettings(tx.writes.get("project.godot") ?? project.text("project.godot"), values));
  return {
    files_written: written,
    autoloads_added: added,
    usage: {
      quality: 'GOQuality.apply_tier("high")  # low, medium, high, ultra, cinematic; GOQuality.auto_detect() picks one',
      governor: "GOGovernor.start(60)  # holds 60 fps by moving the 3D resolution scale, then a degrade ladder",
      spawn: "GOSpawnQueue.instantiate_async(path, parent)  # threaded load, attached within a frame budget",
      prewarm: "await GOPrewarm.new().run(scene_paths)  # compile pipelines behind the loading screen",
      streamer: "GOStreamer nodes are created by fix `partition`",
      probe: "inert unless the game is started by optimizer_bench",
    },
  };
}
