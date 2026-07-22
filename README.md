# Reliable Copilot Harness

一个可安装的 GitHub Copilot Agent Plugin，用模型外的任务状态、工具策略、证据记录和完成门提高 Copilot agent 的执行可靠性。

它不替换 Copilot 的宿主循环或 system prompt。插件把当前任务压缩成一个显式可信契约，并通过 MCP、hooks 和隔离角色约束 Copilot 的执行过程。

## 提供的能力

- `Reliable` orchestrator，以及只读的 `Harness Planner`、`Harness Verifier`。
- `fast`、`standard`、`strict` 三个策略包。
- 每个 workspace 一个持久化任务状态机。
- 写入阶段和写入路径限制。
- 破坏性 terminal command 拦截。
- 每条 acceptance criterion 的显式验证证据。
- review 和 completion gate。
- context compact 前的状态持久化提醒。
- 无第三方运行时依赖的 MCP server 和 hook runner。

## 运行要求

- Node.js 20 或更高版本。
- 支持 Agent Plugins、MCP 和 hooks 的当前 VS Code/GitHub Copilot，或 GitHub Copilot CLI。
- VS Code Agent Plugins 和 hooks 当前仍可能受 Preview 或组织策略限制。

## 在 VS Code 中本地启用

在 VS Code `settings.json` 中注册插件目录：

```json
{
  "chat.plugins.enabled": true,
  "chat.pluginLocations": {
    "C:\\path\\to\\CopilotHarness": true
  }
}
```

重载 VS Code，然后打开 Agent Customizations：

1. 确认 `reliable-copilot-harness` 已启用。
2. 确认 `reliable-harness` MCP server 已启动。
3. 确认 `Reliable`、`Harness Planner`、`Harness Verifier` 可见。
4. 在新 Chat session 中选择 `Reliable` agent。

如果组织策略禁用了 `chat.plugins.enabled`、MCP 或 hooks，插件不能提供完整控制。

## 在 Copilot CLI 中安装

```powershell
copilot plugin install C:\path\to\CopilotHarness
```

检查安装：

```powershell
copilot plugin list
```

当前开发环境未安装 `copilot` CLI，因此仓库验证覆盖 manifest、MCP JSON-RPC、harness core 和 hook policy，不包含真实 CLI 安装冒烟测试。

## 使用

为每个任务新建 Chat session，选择 `Reliable`，然后给出结果和边界：

```text
使用 standard harness 修复登录超时问题。
不要修改公开 API；只允许改 src/auth 和对应测试。
完成条件：回归测试覆盖超时路径，并且 npm test 通过。
```

执行过程：

```text
scope
  → plan
  → execution
  → verification + evidence
  → independent review
  → completion gate
```

任务状态写入目标 workspace 的 `.copilot-harness/state.json`，该目录应保持 gitignored。状态文件是当前任务的可信事实集；旧 Chat 内容和 Copilot Memory 不能替代其中的 acceptance evidence。

## 策略包

| Profile | Plan | 人工确认 Plan | Review | Write scope | 适用场景 |
| --- | --- | --- | --- | --- | --- |
| `fast` | 否 | 否 | 否 | 可选 | 小型、低风险、单点修改 |
| `standard` | 是 | 否 | 是 | 必需 | 默认开发任务 |
| `strict` | 是 | 是 | 是 | 必需 | 跨模块、高风险或高价值任务 |

`strict` 的 plan approval 由 custom agent 工作流要求用户确认后提交。当前 Copilot Plugin interface 不能提供不可伪造的人类签名，因此它不是加密意义上的审批凭证。

`strict` 还会自动允许已声明的 verification commands，对其他 terminal commands 返回 `ask`。Copilot cloud agent 没有交互审批时会把 `ask` 当作拒绝。

## MCP Interface

Harness 对宿主只暴露四个工具：

- `harness_start`：创建可信 `TaskRequest`。
- `harness_checkpoint`：推进阶段、记录证据、review、完成或阻塞。
- `harness_status`：读取当前可信状态和 completion gate。
- `harness_reset`：终止任务但不声明成功。

完整设计见 [docs/architecture.md](docs/architecture.md)。

## 本地 CLI

Harness core 可以脱离 Copilot 调试：

```powershell
npm run harness -- status --workspace D:\path\to\repo
```

开始任务：

```powershell
npm run harness -- start --workspace D:\path\to\repo --profile standard --request '{"goal":"Implement X","acceptance":["Tests pass"],"writePaths":["src/**"]}'
```

## 验证

```powershell
npm test
npm run check
```

## 已知约束

- 当前每个 workspace 只允许一个活动任务。并行任务应使用不同 Git worktree。
- 插件不能删除 Copilot 宿主已经装配的对话或平台上下文；它只把 harness state 设为可信任务契约。
- 工具名称和 tool input 由宿主决定。未知写工具如果名称不包含 create/edit/write/replace/apply-patch，需要在 policy 中补充识别规则。
- Path policy 当前支持 workspace 内路径和以目录前缀为主的 glob；它不是完整 glob engine。
- Hook timeout 按 Copilot 规则可能 fail-open，因此真正的生产保护仍需要 CI、branch protection 和操作系统隔离。
- Plugin hooks 会作用于启用插件后的 agent session；没有活动 harness task 时返回空决定，不改变普通工作流。
