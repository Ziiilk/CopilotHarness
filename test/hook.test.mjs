import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkpointTask, startTask } from "../src/core.mjs";

function invokeHook(action, input) {
  const result = spawnSync(process.execPath, ["src/hook.mjs", action], {
    cwd: process.cwd(),
    input: JSON.stringify(input),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("hook adapter denies an out-of-scope edit and blocks premature stop", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copilot-harness-hook-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = await startTask({
    workspaceRoot: root,
    profile: "standard",
    request: { goal: "Edit source", acceptance: ["Change verified"], writePaths: ["src/**"] }
  });
  await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "plan", payload: { steps: ["Edit source"] } });

  const plannedStop = invokeHook("stop", { hook_event_name: "Stop", cwd: root, stop_hook_active: false });
  assert.equal(plannedStop.decision, "block");

  await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "begin_execution" });

  const denied = invokeHook("pre-tool", {
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_name: "editFiles",
    tool_input: { files: ["docs/readme.md"] }
  });
  assert.equal(denied.permissionDecision, "deny");
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");

  const stopped = invokeHook("stop", { hook_event_name: "Stop", cwd: root, stop_hook_active: false });
  assert.equal(stopped.decision, "block");
  assert.equal(stopped.hookSpecificOutput.decision, "block");
});
