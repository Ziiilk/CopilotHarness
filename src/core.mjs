import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkpointTypes, profileNames, taskRequestSchema } from "./contracts.mjs";
import { extractCommand, isWriteTool, normalizeCommand } from "./policy.mjs";
import { loadState, updateState } from "./state-store.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.dirname(sourceDirectory);
const terminalPhases = new Set(["completed", "blocked"]);
const completionPhases = new Set(["verifying", "reviewing"]);
const transitionSources = new Map([
  ["plan", new Set(["scoped", "planned"])],
  ["approve_plan", new Set(["planned"])],
  ["begin_execution", new Set(["scoped", "planned"])],
  ["begin_verification", new Set(["executing", "repairing"])],
  ["evidence", new Set(["verifying"])],
  ["begin_review", new Set(["verifying"])],
  ["review", new Set(["reviewing"])],
  ["resolve_failure", new Set(["scoped", "planned", "executing", "verifying", "reviewing", "repairing"])],
  ["complete", completionPhases],
  ["block", new Set(["scoped", "planned", "executing", "verifying", "reviewing", "repairing"])]
]);

function arrayOfStrings(value, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings.`);
  }
  if (!allowEmpty && value.length === 0) throw new Error(`${field} must not be empty.`);
  return value.map((item) => item.trim());
}

async function loadProfile(name) {
  if (!profileNames.includes(name)) throw new Error(`Unknown profile: ${name}`);
  const content = await readFile(path.join(pluginRoot, "profiles", `${name}.json`), "utf8");
  return JSON.parse(content);
}

function validateRequest(request, policy) {
  if (!request || typeof request !== "object") throw new Error("request must be an object.");
  const extraFields = Object.keys(request).filter((field) => !Object.hasOwn(taskRequestSchema.properties, field));
  if (extraFields.length) throw new Error(`Unknown request fields: ${extraFields.join(", ")}`);
  if (typeof request.goal !== "string" || !request.goal.trim()) throw new Error("request.goal is required.");
  const normalized = {
    goal: request.goal.trim(),
    nonGoals: arrayOfStrings(request.nonGoals ?? [], "request.nonGoals"),
    constraints: arrayOfStrings(request.constraints ?? [], "request.constraints"),
    acceptance: arrayOfStrings(request.acceptance ?? [], "request.acceptance", { allowEmpty: false }),
    writePaths: arrayOfStrings(request.writePaths ?? [], "request.writePaths"),
    verificationCommands: arrayOfStrings(request.verificationCommands ?? [], "request.verificationCommands")
  };
  if (policy.requireWriteScope && normalized.writePaths.length === 0) {
    throw new Error(`The ${policy.name} profile requires at least one request.writePaths entry.`);
  }
  return normalized;
}

function unresolvedFailures(state) {
  return state.failures.length;
}

export function evaluateCompletion(state) {
  const reasons = [];
  const evidenceByCriterion = new Map(
    state.evidence.filter((item) => item.revision === state.revision).map((item) => [item.criterion, item])
  );

  for (const criterion of state.request.acceptance) {
    const evidence = evidenceByCriterion.get(criterion);
    if (!evidence || evidence.status !== "pass") reasons.push(`Missing passing evidence: ${criterion}`);
  }
  for (const command of state.request.verificationCommands) {
    const expected = normalizeCommand(command);
    const executed = state.observedCommands.some(
      (observation) => observation.revision === state.revision && observation.command === expected
    );
    if (!executed) reasons.push(`Required verification command was not observed: ${command}`);
  }
  if (state.policy.requirePlan && !state.plan) reasons.push("A plan is required.");
  if (state.policy.requirePlanApproval && !state.plan?.approved) reasons.push("The plan requires explicit approval.");
  if (state.policy.requireReview && (state.review?.status !== "pass" || state.review.revision !== state.revision)) {
    reasons.push("An independent passing review is required for the current revision.");
  }
  if (unresolvedFailures(state) > state.policy.maxUnresolvedToolFailures) reasons.push("Unresolved tool failures exceed the active policy.");
  if (!completionPhases.has(state.phase) && state.phase !== "completed") {
    reasons.push(`Completion cannot be requested from the ${state.phase} phase.`);
  }

  return { accepted: reasons.length === 0, reasons };
}

function requireTransition(state, type) {
  if (!checkpointTypes.includes(type)) throw new Error(`Unknown checkpoint type: ${type}`);
  const allowed = transitionSources.get(type);
  if (!allowed.has(state.phase)) throw new Error(`${type} is not allowed during the ${state.phase} phase.`);
}

function requireActiveState(state, taskId) {
  if (!state) throw new Error("No active harness task exists in this workspace.");
  if (taskId && state.id !== taskId) throw new Error(`Task ${taskId} is not active.`);
  if (terminalPhases.has(state.phase)) throw new Error(`Task is already ${state.phase}.`);
}

export async function startTask({ workspaceRoot, profile = "standard", request }) {
  const root = path.resolve(workspaceRoot);
  const policy = await loadProfile(profile);
  const normalizedRequest = validateRequest(request, policy);
  const now = new Date().toISOString();
  const state = await updateState(root, (existing) => {
    if (existing && !terminalPhases.has(existing.phase)) {
      throw new Error(`Task ${existing.id} is already active in ${root}. Reset or complete it first.`);
    }
    return {
      version: 1,
      id: randomUUID(),
      workspaceRoot: root,
      policy,
      phase: "scoped",
      revision: 0,
      request: normalizedRequest,
      plan: null,
      evidence: [],
      observedCommands: [],
      failures: [],
      review: null,
      toolEvents: [],
      createdAt: now,
      updatedAt: now
    };
  });
  return publicState(state);
}

export async function checkpointTask({ workspaceRoot, taskId, type, payload = {} }) {
  const root = path.resolve(workspaceRoot);
  const state = await updateState(root, (current) => {
    requireActiveState(current, taskId);
    requireTransition(current, type);

    switch (type) {
    case "plan": {
      if (Object.hasOwn(payload, "approved")) throw new Error("Use the approve_plan checkpoint to approve a plan.");
      const steps = arrayOfStrings(payload.steps, "payload.steps", { allowEmpty: false });
      current.plan = { steps, approved: false, recordedAt: new Date().toISOString() };
      current.phase = "planned";
      break;
    }
    case "approve_plan": {
      if (!current.plan) throw new Error("Record a plan before approving it.");
      current.plan.approved = true;
      current.plan.approvedAt = new Date().toISOString();
      break;
    }
    case "begin_execution": {
      if (current.policy.requirePlan && !current.plan) throw new Error("The active profile requires a plan before execution.");
      if (current.policy.requirePlanApproval && !current.plan?.approved) throw new Error("The active profile requires plan approval before execution.");
      current.phase = "executing";
      break;
    }
    case "begin_verification": {
      current.phase = "verifying";
      break;
    }
    case "evidence": {
      if (!current.request.acceptance.includes(payload.criterion)) throw new Error("Evidence criterion must exactly match an acceptance criterion.");
      if (!new Set(["pass", "fail"]).has(payload.status)) throw new Error("Evidence status must be pass or fail.");
      if (typeof payload.detail !== "string" || !payload.detail.trim()) throw new Error("Evidence detail is required.");
      const evidence = {
        criterion: payload.criterion,
        status: payload.status,
        detail: payload.detail.trim(),
        command: typeof payload.command === "string" ? payload.command : null,
        revision: current.revision,
        recordedAt: new Date().toISOString()
      };
      current.evidence = current.evidence.filter(
        (item) => item.criterion !== evidence.criterion || item.revision !== current.revision
      );
      current.evidence.push(evidence);
      break;
    }
    case "begin_review": {
      current.phase = "reviewing";
      break;
    }
    case "review": {
      if (!new Set(["pass", "fail"]).has(payload.status)) throw new Error("Review status must be pass or fail.");
      current.review = {
        status: payload.status,
        summary: typeof payload.summary === "string" ? payload.summary.trim() : "",
        revision: current.revision,
        recordedAt: new Date().toISOString()
      };
      if (payload.status === "fail") current.phase = "repairing";
      break;
    }
    case "resolve_failure": {
      const failureIndex = current.failures.findIndex((item) => item.id === payload.eventId);
      if (failureIndex < 0) throw new Error("A matching failed tool event is required.");
      current.failures.splice(failureIndex, 1);
      break;
    }
    case "complete": {
      const result = evaluateCompletion(current);
      if (result.accepted) {
        current.phase = "completed";
        current.completedAt = new Date().toISOString();
      }
      break;
    }
    case "block": {
      if (typeof payload.reason !== "string" || !payload.reason.trim()) throw new Error("A non-empty block reason is required.");
      current.phase = "blocked";
      current.blockedReason = payload.reason.trim();
      break;
    }
    }

    current.updatedAt = new Date().toISOString();
    return current;
  });
  return { state: publicState(state), gate: evaluateCompletion(state) };
}

export async function recordToolEvent(workspaceRoot, event) {
  const root = path.resolve(workspaceRoot);
  return updateState(root, (state) => {
    if (!state || terminalPhases.has(state.phase)) return undefined;
    const id = randomUUID();
    const command = normalizeCommand(extractCommand(event.toolInput));
    if (!event.error && isWriteTool(event.toolName)) {
      state.revision += 1;
      state.evidence = [];
      state.observedCommands = [];
      state.review = null;
    }
    if (event.error) {
      state.failures.push({ id, toolName: event.toolName, error: event.error, timestamp: event.timestamp });
    } else if (command && state.request.verificationCommands.some((expected) => normalizeCommand(expected) === command)) {
      state.observedCommands = state.observedCommands.filter((observation) => observation.command !== command);
      state.observedCommands.push({ command, revision: state.revision, timestamp: event.timestamp });
    }
    state.toolEvents.push({ id, toolName: event.toolName, command, status: event.error ? "failure" : "success", timestamp: event.timestamp });
    if (state.toolEvents.length > 200) state.toolEvents = state.toolEvents.slice(-200);
    state.updatedAt = new Date().toISOString();
    return state;
  });
}

export async function getTaskStatus({ workspaceRoot }) {
  const state = await loadState(path.resolve(workspaceRoot));
  if (!state) return { active: false };
  return { active: !terminalPhases.has(state.phase), state: publicState(state), gate: evaluateCompletion(state) };
}

export async function resetTask({ workspaceRoot, taskId, reason = "Reset by user." }) {
  const root = path.resolve(workspaceRoot);
  const state = await updateState(root, (current) => {
    if (!current || terminalPhases.has(current.phase)) return undefined;
    if (taskId && current.id !== taskId) throw new Error(`Task ${taskId} is not active.`);
    current.phase = "blocked";
    current.blockedReason = reason;
    current.updatedAt = new Date().toISOString();
    return current;
  });
  if (!state) return { active: false };
  return { active: false, state: publicState(state) };
}

export function publicState(state) {
  return {
    id: state.id,
    workspaceRoot: state.workspaceRoot,
    profile: state.policy.name,
    phase: state.phase,
    revision: state.revision,
    request: state.request,
    plan: state.plan,
    evidence: state.evidence,
    review: state.review,
    failures: state.failures,
    unresolvedToolFailures: unresolvedFailures(state),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt ?? null,
    blockedReason: state.blockedReason ?? null
  };
}
