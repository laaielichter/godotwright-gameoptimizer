// Library entry: everything the CLI and the MCP server use.
export { Project, OptimizerError, findProjectRoot } from "./project.mjs";
export { World, summarize } from "./world.mjs";
export { audit, plan } from "./audit.mjs";
export { buildCostMap, routeFromCostMap, renderCostMap } from "./costmap.mjs";
export { Transaction, undo, journalEntries } from "./journal.mjs";
export { bench, compare, importProject, findGodot, diffShots } from "./bench.mjs";
export { writeDemoWorld } from "./demo.mjs";
export { TOOLS } from "./tools.mjs";
export { handle as handleMcp, serve as serveMcp } from "./mcp.mjs";
