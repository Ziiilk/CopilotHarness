import assert from "node:assert/strict";
import test from "node:test";
import { authorizeTool } from "../src/policy.mjs";

function state(overrides = {}) {
  return {
    phase: "executing",
    workspaceRoot: "C:\\workspace",
    request: { writePaths: ["src/**"] },
    policy: { name: "standard", blockDestructiveCommands: true },
    ...overrides
  };
}

test("write tools are denied before execution", () => {
  const result = authorizeTool(state({ phase: "planned" }), {
    toolName: "replace_string_in_file",
    toolInput: { filePath: "src/app.ts" }
  });
  assert.equal(result.decision, "deny");
});

test("writes outside approved scope are denied", () => {
  const result = authorizeTool(state(), {
    toolName: "edit",
    toolInput: { filePath: "docs/readme.md" }
  });
  assert.equal(result.decision, "deny");
});

test("VS Code files arrays are checked against write scope", () => {
  const result = authorizeTool(state(), {
    toolName: "editFiles",
    toolInput: { files: ["src/app.ts", "docs/readme.md"] }
  });
  assert.equal(result.decision, "deny");
});

test("destructive terminal commands are denied", () => {
  const result = authorizeTool(state(), {
    toolName: "powershell",
    toolInput: { command: "Remove-Item -Recurse -Force C:\\workspace\\src" }
  });
  assert.equal(result.decision, "deny");
});

test("strict profile asks before undeclared terminal commands", () => {
  const result = authorizeTool(state({
    policy: { name: "strict", blockDestructiveCommands: true },
    request: { writePaths: ["src/**"], verificationCommands: ["npm test"] }
  }), {
    toolName: "powershell",
    toolInput: { command: "npm install example" }
  });
  assert.equal(result.decision, "ask");
});

test("strict profile allows declared verification commands", () => {
  const result = authorizeTool(state({
    policy: { name: "strict", blockDestructiveCommands: true },
    request: { writePaths: ["src/**"], verificationCommands: ["npm test"] }
  }), {
    toolName: "powershell",
    toolInput: { command: "npm test" }
  });
  assert.equal(result.decision, "allow");
});
