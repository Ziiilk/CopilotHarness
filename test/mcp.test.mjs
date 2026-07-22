import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("MCP server initializes and lists the harness interface", async () => {
  const child = spawn(process.execPath, ["src/mcp-server.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) messages.push(JSON.parse(line));
  });

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);

  await assert.doesNotReject(async () => {
    const deadline = Date.now() + 3000;
    while (messages.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(messages.length, 2);
  });
  child.kill();

  const listed = messages.find((message) => message.id === 2).result.tools.map((tool) => tool.name);
  assert.deepEqual(listed, ["harness_start", "harness_checkpoint", "harness_status", "harness_reset"]);
});
