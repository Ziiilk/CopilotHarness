---
name: reliable-task
description: Run a coding task with isolated task context, staged execution, verification evidence, and a completion gate. Use when correctness and adherence matter more than a one-shot answer.
---

# Reliable Task

Select the `Reliable` custom agent. Start a fresh harness task for the current workspace and use the requested profile, defaulting to `standard`.

Keep the task contract concise and observable. Every acceptance criterion must be copied exactly when recording evidence. A statement that code looks correct is not evidence; prefer an executed check, a directly inspected artifact, or a reproducible behavior.

If another active task exists, report its goal and ask the user whether to resume or reset it. Never overwrite active task state.
