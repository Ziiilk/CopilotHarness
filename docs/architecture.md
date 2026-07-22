# Architecture

## 目标

`ReliableHarness` 是一个深模块。调用方只需要理解 task request、checkpoint 和 run status；context 选择、状态迁移、策略、工具审计和完成判定保留在 implementation 内。

```text
Copilot / CLI / future host
          │
          ▼
Host Adapter: MCP + hooks
          │
          ▼
ReliableHarness
  ├─ Task state machine
  ├─ Policy evaluator
  ├─ Evidence ledger
  ├─ Completion gate
  └─ JSON state store
```

## External seam

概念 Interface：

```ts
interface ReliableHarness {
  start(request: TaskRequest): TaskHandle
  checkpoint(handle: TaskHandle, event: TaskEvent): TaskStatus
  status(workspaceRoot: string): TaskStatus
}
```

MCP 为安装后的 Copilot host 提供 Adapter；CLI 为本地调试提供第二个 Adapter。两者使用同一个 core 和状态文件。

## 状态模型

```text
scoped
  └─ plan ─► planned
               └─ begin_execution ─► executing
                                         └─ begin_verification ─► verifying
                                                                      └─ begin_review ─► reviewing
                                                                                              ├─ fail ─► repairing
                                                                                              └─ pass ─► completed
```

任意非 terminal 阶段都可以显式进入 `blocked`。只有 completion gate 可以进入 `completed`。

## Context firewall

Harness 不把整个 Chat transcript 复制进状态。可信任务上下文只包含：

- goal；
- non-goals；
- constraints；
- acceptance criteria；
- write paths；
- verification commands；
- approved plan；
- acceptance evidence；
- independent review；
- unresolved tool failures。

这不能阻止宿主向模型提供额外上下文，但可以阻止额外上下文在没有证据的情况下改变 completion decision。

## Hook Adapter

`hooks.json` 使用 Copilot lower-camel event 名称，VS Code 会把它们映射为 PascalCase 事件。

- `preToolUse`：执行工具策略并返回 allow/ask/deny。
- `postToolUse`：记录工具成功或显式错误。
- `agentStop`：在 executing/verifying/reviewing 阶段执行 completion gate。
- `preCompact`：提醒模型从持久化状态恢复可信上下文。

Hook runner 同时输出 Copilot CLI 的直接字段和 VS Code 的 `hookSpecificOutput`，让两个 host Adapter 共用同一个 implementation。

## Completion gate

完成必须满足 active profile 的全部条件：

- 每个 acceptance criterion 都有最新的 passing evidence；
- 所需 plan 已记录；
- strict plan 已标记批准；
- 所需 review 为 pass；
- unresolved tool failures 不超过策略阈值；
- 当前阶段允许请求完成。

Gate 不评价自然语言答案是否“看起来正确”，只读取结构化状态。

## 扩展 seam

后续可以在出现第二个真实实现时引入以下 Adapter：

- `StateStore`：JSON、SQLite、remote store；
- `PolicyPack`：团队配置或签名策略；
- `Verifier`：本地命令、CI、测试报告 MCP；
- `HostAdapter`：Copilot、Codex、其他 agent host；
- `ApprovalProvider`：交互确认、组织审批或外部签名。

目前只有 Host Adapter 已有 MCP 与 CLI 两个真实实现。其余能力保持 core 内部，以免创建只有一个实现的假 seam。
