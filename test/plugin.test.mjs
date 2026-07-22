import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("plugin manifests remain aligned and use valid names", async () => {
  const root = await json("plugin.json");
  const openPlugin = await json(".plugin/plugin.json");
  assert.deepEqual(openPlugin, root);
  assert.match(root.name, /^[a-z0-9-]{1,64}$/);
  assert.equal(root.hooks, "hooks.json");
  assert.equal(root.mcpServers, ".mcp.json");
});

test("plugin hook commands and MCP server use the OpenPlugin root token", async () => {
  const hooks = await json("hooks.json");
  const mcp = await json(".mcp.json");
  const commands = Object.values(hooks.hooks).flat().map((hook) => hook.command);
  assert.ok(commands.every((command) => command.includes("${PLUGIN_ROOT}")));
  assert.ok(mcp.mcpServers["reliable-harness"].args[0].includes("${PLUGIN_ROOT}"));
});
