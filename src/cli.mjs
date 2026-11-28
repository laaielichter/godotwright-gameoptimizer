// Command line: every tool as a command, JSON out with --json, readable text otherwise.
import { TOOLS, toolByName, FIXES } from "./tools.mjs";
import { OptimizerError } from "./project.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;

const HELP = `gameoptimizer ${VERSION}: the performance optimizer for Godot 4 games, built for coding agents

Usage: gameoptimizer <command> [project] [options]

  audit [project]              what holds the game back, and the plan to fix it       (no Godot needed)
  costmap [project]            predicted rendering cost across the world, hotspots    (no Godot needed)
  textures [project]           texture memory report                                  (no Godot needed)
  census [project]             count what the running game really holds (--pack game.pck for an exported game)
  fix <name> [project]         apply one fix: ${Object.keys(FIXES).join(", ")}
  undo [id] [project]          take a fix back (--list shows the journal)
  bench [project]              run the game and measure it (--label baseline first)
  compare <run> [project]      compare a run with the baseline, numbers and screenshots
  import [project]             import assets (works without a GPU)
  explain <topic>              why a finding costs performance and how the fix works
  demo <dir>                   write the heavy open-world demo project
  mcp                          start the MCP server on stdio (for Claude Code, Codex, Gemini CLI, Cursor, ...)
  tools                        list the MCP tools with their input schemas as JSON

Options are the tool's inputs: --scene world/world.tscn --dry-run --cell-size 64 --label baseline --tier high ...
  --json          print the full JSON result
  --project DIR   the project folder (also accepted as a positional argument)
`;

const COMMANDS = { census: "optimizer_census", audit: "optimizer_audit", costmap: "optimizer_costmap", textures: "optimizer_textures", fix: "optimizer_fix", undo: "optimizer_undo", bench: "optimizer_bench", compare: "optimizer_compare", import: "optimizer_import", explain: "optimizer_explain", demo: "optimizer_demo" };
const POSITIONAL = { fix: ["fix", "project"], undo: ["id", "project"], compare: ["run", "project"], explain: ["topic"], demo: ["dir"] };

function parseArgs(argv, tool, command) {
  const props = tool.inputSchema.properties ?? {};
  const args = {};
  const pos = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const raw = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replace(/-/g, "_");
      const no = raw.startsWith("no_") && props[raw.slice(3)]?.type === "boolean";
      const name = no ? raw.slice(3) : raw;
      const def = props[name];
      if (!def) throw new OptimizerError(`Unknown option --${raw.replace(/_/g, "-")} for ${command}.`, `Options: ${Object.keys(props).map((k) => "--" + k.replace(/_/g, "-")).join(" ")}`);
      if (def.type === "boolean") args[name] = no ? false : eq > 0 ? a.slice(eq + 1) !== "false" : true;
      else {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined) throw new OptimizerError(`Option --${raw} needs a value.`);
        args[name] = def.type === "number" ? Number(v) : def.type === "array" ? v.split(",") : v;
      }
    } else pos.push(a);
  }
  const names = POSITIONAL[command] ?? ["project"];
  pos.forEach((v, i) => {
    const name = names[i];
    if (!name) throw new OptimizerError(`Unexpected argument "${v}".`);
    if (name === "id" && !/^\d+$/.test(v)) args.project = v;
    else args[name] = props[name]?.type === "number" ? Number(v) : v;
  });
  return { args, json };
}

const sev = { high: "HIGH  ", medium: "MEDIUM", low: "LOW   ", info: "INFO  " };

function text(command, r) {
  const L = [];
  if (command === "audit") {
    L.push(`${r.project.name || r.project.root}  (Godot ${r.project.engine ?? "?"}, ${r.project.renderer}, ${r.project.files} files, ${r.project.scripts} scripts)`);
    for (const s of r.scenes) {
      const m = s.summary;
      L.push(`  ${s.scene}: ${m.nodes} nodes, ${m.meshInstances} mesh instances (${m.uniqueMeshes} unique), ${m.multimeshInstances} multimesh instances, ${Math.round(m.triangles / 1000)}k triangles, ${m.surfaces} surfaces in about ${m.batches} batches, ${m.lights} lights (${m.shadowLights} shadowed), ${m.bodies} bodies${m.extent ? `, ${m.extent[0]} x ${m.extent[2]} m` : ""}`);
      if (s.costmap.totals) L.push(`    worst view: ${Math.round(s.costmap.totals.viewTrianglesMax / 1000)}k triangles, ${s.costmap.totals.viewDrawsMax} surfaces in range (cells of ${s.costmap.cellSize} m)`);
    }
    L.push(`  textures: ${r.textures.count}, about ${r.textures.vram_mb} MB of VRAM`);
    L.push(`  score ${r.score}/100   high ${r.counts.high}  medium ${r.counts.medium}  low ${r.counts.low}`, "");
    for (const f of r.findings) {
      L.push(`${sev[f.severity]} ${f.title}   [${f.id}]`);
      L.push(`       ${f.detail}`);
      for (const e of f.evidence ?? []) L.push(`       - ${Object.entries(e).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ")}`);
      if (f.fix) L.push(`       fix: gameoptimizer fix ${f.fix.fix}${f.fix.scene ? ` --scene ${f.fix.scene}` : ""}`);
      L.push("");
    }
    if (r.plan.steps.length) {
      L.push("Plan:");
      for (const s of r.plan.steps) L.push(`  ${s.step}. ${s.optional ? "(optional) " : ""}${s.title}\n     ${s.cli}   (${s.risk})`);
      L.push("", "Measure first: gameoptimizer bench --label baseline. After each step: bench --label <name>, compare <name>.");
    }
    return L.join("\n");
  }
  if (command === "costmap") {
    L.push(`${r.scene}: cells of ${r.cell_size} m (${r.columns} x ${r.rows}), view distance ${r.view_distance} m`);
    L.push(`worst view ${Math.round(r.totals.viewTrianglesMax / 1000)}k triangles / ${r.totals.viewDrawsMax} surfaces in range; median ${Math.round(r.totals.viewTrianglesMedian / 1000)}k / ${r.totals.viewDrawsMedian}`, "", r.picture.map, "", "Hotspots:");
    for (const h of r.hotspots) L.push(`  (${Math.round(h.center[0])}, ${Math.round(h.center[1])}): ${Math.round(h.viewTriangles / 1000)}k triangles, ${h.viewDraws} surfaces in range; ${h.objects} objects in the cell; load ${Math.round(h.load / 1000)}k`);
    return L.join("\n");
  }
  if (command === "compare") {
    L.push(`${r.run} against ${r.baseline}: ${r.verdict}`, `performance: ${r.performance}   picture: ${r.visual}${r.worst_picture_change_percent != null ? ` (worst station ${r.worst_picture_change_percent}% of pixels changed)` : ""}`, "");
    for (const m of r.metrics) L.push(`  ${m.metric.padEnd(26)} ${String(m.before).padStart(12)} -> ${String(m.after).padStart(12)}  ${(m.change_percent > 0 ? "+" : "") + m.change_percent}%  ${m.verdict}`);
    for (const w of r.warnings) L.push("", `note: ${w}`);
    return L.join("\n");
  }
  if (command === "census") {
    const t = r.totals;
    L.push(`${r.scene}  (Godot ${r.engine}, ${r.renderer}${r.headless ? ", headless" : ""}, counted after ${r.seconds} s)`);
    L.push(`  ${t.nodes} nodes (${t.processing} process, ${t.physics_processing} physics-process), ${t.mesh_instances} mesh instances, ${Math.round(t.triangles / 1000)}k triangles, ${t.unique_meshes} meshes, ${t.unique_materials} materials, ${t.multimesh_instances} multimesh instances, ${t.textures_mb} MB textures`, "");
    for (const f of r.findings) {
      L.push(`${sev[f.severity]} ${f.title}   [${f.id}]`, `       ${f.detail}`);
      for (const e of f.evidence ?? []) L.push(`       - ${Object.entries(e).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ")}`);
      if (f.fix) L.push(`       fix: gameoptimizer fix ${f.fix.fix}`);
      L.push("");
    }
    if (r.built_by.length) L.push("Built by (nodes below the nearest script):", ...r.built_by.map((x) => `  ${String(x.count).padStart(7)}  ${x.name}`));
    for (const e of r.errors) L.push(`error: ${e}`);
    return L.join("\n");
  }
  if (command === "explain" && r.text) return `${r.title}\n\n${r.text}\n\nCheck: ${r.check}`;
  return JSON.stringify(r, null, 2);
}

/** The help for one command, built from the descriptions in its tool's inputSchema. */
export function commandHelp(command, tool) {
  const props = tool.inputSchema.properties ?? {};
  const pos = POSITIONAL[command] ?? ["project"];
  const usage = `gameoptimizer ${command}${pos.map((n) => ` [${n}]`).join("")}`;
  const L = [`${usage}   ${tool.title}`, "", tool.description, "", "Options:"];
  const rows = Object.entries(props).map(([k, v]) => [`--${k.replace(/_/g, "-")}${v.type === "boolean" ? "" : " " + (v.type === "number" ? "N" : v.type === "array" ? "A,B" : "VALUE")}`, v.description ?? ""]);
  rows.push(["--json", "print the full JSON result"]);
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [flag, d] of rows) L.push(`  ${flag.padEnd(w)}  ${d}`.trimEnd());
  return L.join("\n");
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "--version" || command === "version") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (command === "mcp") {
    const { serve } = await import("./mcp.mjs");
    await serve();
    return 0;
  }
  if (command === "tools") {
    process.stdout.write(JSON.stringify(TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })), null, 2) + "\n");
    return 0;
  }
  const tool = toolByName.get(COMMANDS[command]);
  if (!tool) {
    process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(commandHelp(command, tool) + "\n");
    return 0;
  }
  try {
    const { args, json } = parseArgs(rest, tool, command);
    for (const req of tool.inputSchema.required ?? []) if (args[req] === undefined) throw new OptimizerError(`${command} needs <${req}>.`, HELP.split("\n").find((l) => l.trim().startsWith(command)) ?? "");
    const result = await tool.handler(args);
    process.stdout.write((json ? JSON.stringify(result, null, 2) : text(command, result)) + "\n");
    if (command === "compare" && result.performance === "worse") return 1;
    return 0;
  } catch (e) {
    if (e instanceof OptimizerError) {
      process.stderr.write(`error: ${e.message}${e.hint ? `\n${e.hint}` : ""}\n`);
      return 2;
    }
    throw e;
  }
}
