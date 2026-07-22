import path from "node:path";

const writeToolPattern = /(apply[_-]?patch|create|edit|insert|replace|write)/i;
const terminalToolPattern = /(bash|powershell|terminal|shell|command)/i;
const destructiveCommandPatterns = [
  /\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/i,
  /\bRemove-Item\b[^\r\n]*(?:-Recurse|-Force)/i,
  /\b(?:git\s+reset\s+--hard|git\s+clean\s+-[^\s]*f)/i,
  /\b(?:DROP\s+(?:DATABASE|TABLE)|TRUNCATE\s+TABLE)\b/i,
  /\b(?:del|rmdir)\b[^\r\n]*(?:\/s|\/q)/i
];
const writePhases = new Set(["executing", "repairing"]);

function valuesForKeys(value, keys, results = []) {
  if (!value || typeof value !== "object") return results;
  if (Array.isArray(value)) {
    for (const item of value) valuesForKeys(item, keys, results);
    return results;
  }
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key.toLowerCase()) && typeof item === "string") results.push(item);
    else if (keys.has(key.toLowerCase()) && Array.isArray(item)) {
      for (const entry of item) if (typeof entry === "string") results.push(entry);
    }
    else valuesForKeys(item, keys, results);
  }
  return results;
}

export function extractCommand(toolInput) {
  const commands = valuesForKeys(toolInput, new Set(["command", "cmd", "script", "code"]));
  return commands.join("\n");
}

export function isWriteTool(toolName) {
  return writeToolPattern.test(String(toolName ?? ""));
}

export function normalizeCommand(command) {
  return String(command ?? "").trim().replace(/\s+/g, " ");
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function matchesWriteScope(workspaceRoot, candidate, scopes) {
  const absoluteCandidate = path.resolve(workspaceRoot, candidate);
  if (!isWithin(workspaceRoot, absoluteCandidate)) return false;
  if (!scopes.length) return true;
  return scopes.some((scope) => {
    const normalized = scope.replace(/\\/g, "/").replace(/\/\*\*.*$/, "").replace(/\/\*.*$/, "");
    if (normalized === "" || normalized === ".") return true;
    return isWithin(path.resolve(workspaceRoot, normalized), absoluteCandidate);
  });
}

export function authorizeTool(state, event) {
  if (!state || state.phase === "completed" || state.phase === "blocked") {
    return { decision: "allow" };
  }

  const toolName = String(event.toolName ?? "");
  const toolInput = event.toolInput ?? {};
  const command = terminalToolPattern.test(toolName) ? normalizeCommand(extractCommand(toolInput)) : "";

  if (state.policy.blockDestructiveCommands && destructiveCommandPatterns.some((pattern) => pattern.test(command))) {
    return { decision: "deny", reason: "The active harness policy blocks destructive commands." };
  }

  if (state.policy.name === "strict" && terminalToolPattern.test(toolName)) {
    const declaredVerification = state.request.verificationCommands.some((expected) => command === normalizeCommand(expected));
    if (!declaredVerification) {
      return { decision: "ask", reason: "The strict profile requires approval for undeclared terminal commands." };
    }
  }

  if (!isWriteTool(toolName)) return { decision: "allow" };

  if (!writePhases.has(state.phase)) {
    return { decision: "deny", reason: `File changes are not allowed during the ${state.phase} phase.` };
  }

  const paths = valuesForKeys(toolInput, new Set(["path", "filepath", "file_path", "files", "target", "targetpath"]));
  if (!paths.length) {
    return state.policy.name === "strict"
      ? { decision: "ask", reason: "The strict profile requires an inspectable target path for write tools." }
      : { decision: "allow" };
  }

  const rejected = paths.filter((candidate) => !matchesWriteScope(state.workspaceRoot, candidate, state.request.writePaths));
  if (rejected.length) {
    return { decision: "deny", reason: `Write target is outside the approved scope: ${rejected.join(", ")}` };
  }

  return { decision: "allow" };
}

export function normalizeHookEvent(input) {
  return {
    cwd: input.cwd ? path.resolve(input.cwd) : process.cwd(),
    toolName: input.tool_name ?? input.toolName ?? "",
    toolInput: input.tool_input ?? input.toolInput ?? {},
    error: input.error ?? null,
    stopHookActive: Boolean(input.stop_hook_active ?? input.stopHookActive),
    timestamp: input.timestamp ?? new Date().toISOString()
  };
}
