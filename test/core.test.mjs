import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkpointTask, getTaskStatus, recordToolEvent, startTask } from "../src/core.mjs";
import { loadState } from "../src/state-store.mjs";

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "copilot-harness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("standard workflow cannot complete without evidence and review", async (t) => {
  const root = await workspace(t);
  const task = await startTask({
    workspaceRoot: root,
    profile: "standard",
    request: {
      goal: "Implement a feature",
      acceptance: ["Tests pass"],
      writePaths: ["src/**"],
      verificationCommands: ["npm test"]
    }
  });

  await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "plan", payload: { steps: ["Change src"] } });
  await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "begin_execution" });
  await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "begin_verification" });
  const incomplete = await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "complete" });

  assert.equal(incomplete.gate.accepted, false);
  assert.match(incomplete.gate.reasons.join("\n"), /Missing passing evidence/);
  assert.match(incomplete.gate.reasons.join("\n"), /review/i);
});

test("strict workflow completes only after approval, evidence, and review", async (t) => {
  const root = await workspace(t);
  const task = await startTask({
    workspaceRoot: root,
    profile: "strict",
    request: {
      goal: "Implement a feature",
      acceptance: ["Behavior is verified"],
      writePaths: ["src/**"]
    }
  });

  await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "plan", payload: { steps: ["Inspect", "Change", "Test"] } });
  await assert.rejects(
    checkpointTask({ workspaceRoot: root, taskId: task.id, type: "begin_execution" }),
    /approval/
  );
  await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "approve_plan" });
  await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "begin_execution" });
  await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "begin_verification" });
  await checkpointTask({
    workspaceRoot: root,
    taskId: task.id,
    type: "evidence",
    payload: { criterion: "Behavior is verified", status: "pass", detail: "node --test passed", command: "node --test" }
  });
  await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "begin_review" });
  await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "review", payload: { status: "pass", summary: "No findings" } });
  const completed = await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "complete" });

  assert.equal(completed.gate.accepted, true);
  assert.equal(completed.state.phase, "completed");
  const status = await getTaskStatus({ workspaceRoot: root });
  assert.equal(status.active, false);
});

test("an active workspace rejects a second task", async (t) => {
  const root = await workspace(t);
  const request = { goal: "First", acceptance: ["Done"], writePaths: ["src/**"] };
  await startTask({ workspaceRoot: root, profile: "standard", request });
  await assert.rejects(startTask({ workspaceRoot: root, profile: "standard", request }), /already active/);
});

test("concurrent starts admit exactly one task", async (t) => {
  const root = await workspace(t);
  const request = { goal: "Only one", acceptance: ["Done"], writePaths: ["src/**"] };
  const results = await Promise.allSettled([
    startTask({ workspaceRoot: root, profile: "standard", request }),
    startTask({ workspaceRoot: root, profile: "standard", request })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("checkpoint transitions cannot skip or rewind phases", async (t) => {
  const root = await workspace(t);
  const task = await startTask({
    workspaceRoot: root,
    profile: "standard",
    request: { goal: "Ordered task", acceptance: ["Done"], writePaths: ["src/**"] }
  });
  await assert.rejects(checkpointTask({
    workspaceRoot: root,
    taskId: task.id,
    type: "plan",
    payload: { steps: ["Implement"], approved: true }
  }), /approve_plan/);
  const planned = await checkpointTask({
    workspaceRoot: root,
    taskId: task.id,
    type: "plan",
    payload: { steps: ["Implement"] }
  });
  assert.equal(planned.state.plan.approved, false);
  await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "begin_execution" });
  await assert.rejects(
    checkpointTask({ workspaceRoot: root, taskId: task.id, type: "plan", payload: { steps: ["Rewind"] } }),
    /not allowed/
  );
  await assert.rejects(
    checkpointTask({ workspaceRoot: root, taskId: task.id, type: "review", payload: { status: "pass" } }),
    /not allowed/
  );
});

test("declared verification commands must be observed through tool events", async (t) => {
  const root = await workspace(t);
  const task = await startTask({
    workspaceRoot: root,
    profile: "fast",
    request: {
      goal: "Verify a change",
      acceptance: ["Checks pass"],
      verificationCommands: ["npm test"]
    }
  });
  await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "begin_execution" });
  await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "begin_verification" });
  await checkpointTask({
    workspaceRoot: root,
    taskId: task.id,
    type: "evidence",
    payload: { criterion: "Checks pass", status: "pass", detail: "Reported passing", command: "npm test" }
  });

  const before = await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "complete" });
  assert.match(before.gate.reasons.join("\n"), /not observed/);

  await recordToolEvent(root, {
    toolName: "powershell",
    toolInput: { command: "echo npm test" },
    error: null,
    timestamp: new Date().toISOString()
  });
  const spoofed = await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "complete" });
  assert.match(spoofed.gate.reasons.join("\n"), /not observed/);

  await recordToolEvent(root, {
    toolName: "powershell",
    toolInput: { command: "npm test" },
    error: null,
    timestamp: new Date().toISOString()
  });
  const after = await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "complete" });
  assert.equal(after.gate.accepted, true);
});

test("a later write invalidates earlier evidence", async (t) => {
  const root = await workspace(t);
  const task = await startTask({
    workspaceRoot: root,
    profile: "fast",
    request: { goal: "Revise code", acceptance: ["Current code is verified"] }
  });
  await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "begin_execution" });
  await recordToolEvent(root, {
    toolName: "editFiles",
    toolInput: { files: ["src/a.js"] },
    error: null,
    timestamp: new Date().toISOString()
  });
  await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "begin_verification" });
  await checkpointTask({
    workspaceRoot: root,
    taskId: task.id,
    type: "evidence",
    payload: { criterion: "Current code is verified", status: "pass", detail: "Verified revision one" }
  });
  await recordToolEvent(root, {
    toolName: "editFiles",
    toolInput: { files: ["src/a.js"] },
    error: null,
    timestamp: new Date().toISOString()
  });
  const result = await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "complete" });
  assert.equal(result.gate.accepted, false);
  assert.match(result.gate.reasons.join("\n"), /Missing passing evidence/);
});

test("concurrent tool events are not lost", async (t) => {
  const root = await workspace(t);
  const task = await startTask({
    workspaceRoot: root,
    profile: "fast",
    request: { goal: "Collect events", acceptance: ["Events collected"] }
  });
  await checkpointTask({ workspaceRoot: root, taskId: task.id, type: "begin_execution" });
  await Promise.all(Array.from({ length: 20 }, (_, index) => recordToolEvent(root, {
    toolName: "powershell",
    toolInput: { command: `command-${index}` },
    error: null,
    timestamp: new Date().toISOString()
  })));
  const state = await loadState(root);
  assert.equal(state.toolEvents.length, 20);
  assert.equal(state.observedCommands.length, 0);
});
