export const profileNames = ["fast", "standard", "strict"];

export const checkpointTypes = [
  "plan",
  "approve_plan",
  "begin_execution",
  "begin_verification",
  "evidence",
  "begin_review",
  "review",
  "resolve_failure",
  "complete",
  "block"
];

export const taskRequestSchema = {
  type: "object",
  required: ["goal", "acceptance"],
  additionalProperties: false,
  properties: {
    goal: { type: "string", minLength: 1 },
    nonGoals: { type: "array", items: { type: "string", minLength: 1 } },
    constraints: { type: "array", items: { type: "string", minLength: 1 } },
    acceptance: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    writePaths: { type: "array", items: { type: "string", minLength: 1 } },
    verificationCommands: { type: "array", items: { type: "string", minLength: 1 } }
  }
};
