import { checkpointTask, getTaskStatus, resetTask, startTask } from "./core.mjs";
import { checkpointTypes, profileNames, taskRequestSchema } from "./contracts.mjs";

const maximumMessageBytes = 1024 * 1024;

const tools = [
  {
    name: "harness_start",
    description: "Start one isolated reliability-harness task in a workspace. The request becomes the only trusted task contract.",
    inputSchema: {
      type: "object",
      required: ["workspaceRoot", "request"],
      properties: {
        workspaceRoot: { type: "string", description: "Absolute workspace root." },
        profile: { type: "string", enum: profileNames, default: "standard" },
        request: taskRequestSchema
      }
    }
  },
  {
    name: "harness_checkpoint",
    description: "Advance a harness task, record exact acceptance evidence, submit review results, resolve failures, or request completion.",
    inputSchema: {
      type: "object",
      required: ["workspaceRoot", "taskId", "type"],
      properties: {
        workspaceRoot: { type: "string" },
        taskId: { type: "string" },
        type: {
          type: "string",
          enum: checkpointTypes
        },
        payload: { type: "object" }
      }
    }
  },
  {
    name: "harness_status",
    description: "Return the trusted task contract, current phase, evidence, review, and completion-gate result for a workspace.",
    inputSchema: {
      type: "object",
      required: ["workspaceRoot"],
      properties: { workspaceRoot: { type: "string" } }
    }
  },
  {
    name: "harness_reset",
    description: "Terminate the active harness task without declaring success.",
    inputSchema: {
      type: "object",
      required: ["workspaceRoot"],
      properties: {
        workspaceRoot: { type: "string" },
        taskId: { type: "string" },
        reason: { type: "string" }
      }
    }
  }
];

async function callTool(name, args) {
  if (name === "harness_start") return startTask(args);
  if (name === "harness_checkpoint") return checkpointTask(args);
  if (name === "harness_status") return getTaskStatus(args);
  if (name === "harness_reset") return resetTask(args);
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  if (!Object.hasOwn(message, "id")) return;
  const response = { jsonrpc: "2.0", id: message.id };
  try {
    if (message.method === "initialize") {
      response.result = {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "reliable-copilot-harness", version: "0.1.0" }
      };
    } else if (message.method === "ping") {
      response.result = {};
    } else if (message.method === "tools/list") {
      response.result = { tools };
    } else if (message.method === "tools/call") {
      const result = await callTool(message.params?.name, message.params?.arguments ?? {});
      response.result = {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result
      };
    } else {
      response.error = { code: -32601, message: `Method not found: ${message.method}` };
    }
  } catch (error) {
    response.error = { code: -32000, message: error.message };
  }
  send(response);
}

process.stdin.setEncoding("utf8");
let buffer = "";
let processing = Promise.resolve();
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf8") > maximumMessageBytes) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP message exceeds 1 MiB." } });
      process.exitCode = 1;
      process.stdin.pause();
      return;
    }
    try {
      const message = JSON.parse(line);
      processing = processing.then(() => handle(message));
    } catch (error) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } });
    }
  }
  if (Buffer.byteLength(buffer, "utf8") > maximumMessageBytes) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "MCP message exceeds 1 MiB." } });
    process.exitCode = 1;
    process.stdin.pause();
  }
});
