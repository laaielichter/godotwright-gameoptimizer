// MCP server over stdio (JSON-RPC 2.0, newline-delimited). No dependencies: any MCP client can start it with
// `npx -y github:laaielichter/godotwright-gameoptimizer mcp`.
import { createInterface } from "node:readline";
import { TOOLS, toolByName } from "./tools.mjs";
import { OptimizerError } from "./project.mjs";
import { VERSION } from "./cli.mjs";

const INSTRUCTIONS = `Performance optimizer for Godot 4 games. Loop: optimizer_audit (findings and a plan, no Godot needed) -> optimizer_bench label "baseline" -> one optimizer_fix at a time in the plan's order -> optimizer_bench with a new label -> optimizer_compare. Keep a fix when the verdict is an improvement with the picture unchanged; optimizer_undo it when it is a regression. optimizer_explain says why a finding costs performance. Every fix is journaled and reversible; dry_run shows what would change.`;

export async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize":
      return reply({ protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "godotwright-gameoptimizer", title: "Godotwright Game Optimizer", version: VERSION }, instructions: INSTRUCTIONS });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
    case "tools/call": {
      const tool = toolByName.get(params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
      try {
        const args = params.arguments ?? {};
        for (const req of tool.inputSchema.required ?? []) if (args[req] === undefined) throw new OptimizerError(`Missing required input "${req}".`);
        const result = await tool.handler(args);
        return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 1) }], structuredContent: result });
      } catch (e) {
        const message = e instanceof OptimizerError ? `${e.message}${e.hint ? `\n${e.hint}` : ""}` : `Internal error: ${e?.stack ?? e}`;
        return reply({ content: [{ type: "text", text: message }], isError: true });
      }
    }
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      return id === undefined ? null : fail(-32601, `Method not found: ${method}`);
  }
}

export function serve(input = process.stdin, output = process.stdout) {
  return new Promise((done) => {
    const rl = createInterface({ input, crlfDelay: Infinity });
    let pending = 0;
    let closed = false;
    const finish = () => closed && pending === 0 && done();
    rl.on("line", async (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
        return;
      }
      pending++;
      try {
        const res = await handle(msg);
        if (res) output.write(JSON.stringify(res) + "\n");
      } finally {
        pending--;
        finish();
      }
    });
    rl.on("close", () => {
      closed = true;
      finish();
    });
  });
}
