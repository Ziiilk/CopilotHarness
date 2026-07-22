import { checkpointTask, evaluateCompletion, recordToolEvent } from "./core.mjs";
import { authorizeTool, normalizeHookEvent } from "./policy.mjs";
import { loadState } from "./state-store.mjs";

const maximumInputBytes = 1024 * 1024;

async function readStandardInput() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input, "utf8") > maximumInputBytes) throw new Error("Hook input exceeds 1 MiB.");
  }
  return input.trim() ? JSON.parse(input) : {};
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function run() {
  const action = process.argv[2];
  const event = normalizeHookEvent(await readStandardInput());

  if (action === "post-tool") {
    await recordToolEvent(event.cwd, event);
    emit({});
    return;
  }

  const state = await loadState(event.cwd);

  if (!state || new Set(["completed", "blocked"]).has(state.phase)) {
    emit({});
    return;
  }

  if (action === "pre-tool") {
    const authorization = authorizeTool(state, event);
    const hookSpecificOutput = {
      hookEventName: "PreToolUse",
      permissionDecision: authorization.decision,
      ...(authorization.reason ? { permissionDecisionReason: authorization.reason } : {})
    };
    emit({
      permissionDecision: authorization.decision,
      ...(authorization.reason ? { permissionDecisionReason: authorization.reason } : {}),
      hookSpecificOutput
    });
    return;
  }

  if (action === "pre-compact") {
    emit({
      additionalContext: `Harness task ${state.id} is in ${state.phase}. Reload .copilot-harness/state.json after compaction.`,
      systemMessage: `Harness state for task ${state.id} is persisted in .copilot-harness/state.json.`
    });
    return;
  }

  if (action === "stop") {
    if (event.stopHookActive) {
      emit({ decision: "allow", hookSpecificOutput: { hookEventName: "Stop", decision: "allow" } });
      return;
    }
    if (state.policy.name === "strict" && state.phase === "planned" && !state.plan?.approved) {
      emit({ decision: "allow", hookSpecificOutput: { hookEventName: "Stop", decision: "allow" } });
      return;
    }
    const gate = evaluateCompletion(state);
    if (!gate.accepted) {
      const reason = `The harness completion gate is not satisfied:\n- ${gate.reasons.join("\n- ")}\nContinue the task or explicitly mark it blocked through the harness.`;
      emit({
        decision: "block",
        reason,
        hookSpecificOutput: { hookEventName: "Stop", decision: "block", reason }
      });
      return;
    }
    await checkpointTask({ workspaceRoot: event.cwd, taskId: state.id, type: "complete" });
    emit({ decision: "allow", hookSpecificOutput: { hookEventName: "Stop", decision: "allow" } });
    return;
  }

  emit({});
}

run().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
