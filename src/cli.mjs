import path from "node:path";
import { checkpointTask, getTaskStatus, resetTask, startTask } from "./core.mjs";

function parseJson(value, name) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }
}

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const command = process.argv[2] ?? "status";
  const workspaceRoot = path.resolve(option("workspace", process.cwd()));
  let result;
  if (command === "start") {
    result = await startTask({
      workspaceRoot,
      profile: option("profile", "standard"),
      request: parseJson(option("request", "{}"), "--request")
    });
  } else if (command === "checkpoint") {
    result = await checkpointTask({
      workspaceRoot,
      taskId: option("task"),
      type: option("type"),
      payload: parseJson(option("payload", "{}"), "--payload")
    });
  } else if (command === "reset") {
    result = await resetTask({ workspaceRoot, taskId: option("task"), reason: option("reason", "Reset from CLI.") });
  } else if (command === "status") {
    result = await getTaskStatus({ workspaceRoot });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
