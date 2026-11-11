# Agent Runtime Hooks 与即时事件

Crewvane 0.7 将 Agent 生命周期观测统一到一个受管的 Agent Runtime Adapter 层。它解决的是“会话发生了什么”的可见性问题，不替代 Crewvane 的目标语义协议。

## 边界

Hook 只证明如下事实：

- Agent 会话开始或结束；
- 一个 turn 开始、结束或被中断；
- Agent 正在等待输入、批准或其他阻塞；
- Agent 原生 Hook 实际提供了本轮回复正文。

Hook 不证明目标已完成、交付可验收、第三方正在等待、需要人决定或安全风险已经消失。这些业务事实仍只能由 `crewvane goal progress / wait / review / decide / risk / ship / accept / ...` 写入。

Crewvane 不解析终端画面，不根据 `idle`、`done` 或自然语言猜测状态，也不把工具调用参数、工具结果或终端滚动全文存入目标。

## 组件

```text
Agent lifecycle event
        |
        v
official Adapter Hook / OMP Extension
        |
        v
crewvane hook ingest --adapter <id>
        |
        +--> local Socket (500 ms fail-open)
        |        |
        |        v
        |   Electron AgentRuntimeBroker
        |
        +--> private spool (app offline)
                 |
                 v
            drain on restart
```

`AgentAttempt` 每次由 `crewvane owner launch` 启动、重启或恢复负责人时新建，绑定 `goalId`、`attemptId`、Agent 类型、Adapter、启动时间、当前 turn 和真实现场。负责人环境同时获得目标 ID、attempt ID、一次性 Hook token 与 Agent 名称。

`AgentRuntimeEventV1` 只接受版本、事件 ID、单调序号、时间、来源、Agent、Adapter、目标、attempt、turn、类型和受限内容。事件 ID 与 `attemptId + sequence` 用于去重和排序。旧 attempt、旧 turn 和迟到事件只能进入诊断日志，不能覆盖当前目标。

## Adapter 能力矩阵

| Agent | 接入方式 | 生命周期事件 | 配置位置 | 降级或信任 |
| --- | --- | --- | --- | --- |
| Codex | 官方 command Hooks | SessionStart、UserPromptSubmit、PermissionRequest、Stop、Interrupt、SessionEnd | `~/.codex/hooks.json` | 需要在 `/hooks` 中信任 Crewvane 条目 |
| Claude Code | 官方 command Hooks | SessionStart、UserPromptSubmit、Notification、Stop、SessionEnd | `~/.claude/settings.json` | 保留用户已有 Hook；Stop 可提供回复正文 |
| Cursor | 官方 v1 Hooks | sessionStart、beforeSubmitPrompt、afterAgentResponse、stop、sessionEnd | `~/.cursor/hooks.json` | v2 或未知格式显示“版本不支持” |
| Qoder | 官方 command Hooks | SessionStart、UserPromptSubmit、Notification/Permission、Stop、SessionEnd | `~/.qoder/settings.json` | 兼容 Claude 式 grouped config |
| OMP | 官方 Extension API | session、turn、agent、approval 生命周期 | `~/.omp/agent/extensions/crewvane.js` | 不覆盖同名用户 extension |

v1 不安装 PreToolUse / PostToolUse Hook。工具级事件每次启动进程并在高并发下重复写盘，对本版目标没有足够收益；Herdr 的工作心跳和 Hook 的 turn 生命周期已经覆盖主要需求。

配置安装采用 marker、首次备份、JSON 解析合并与原子替换。重复安装幂等；“停用”和“卸载”只移除 Crewvane 管理条目。损坏 JSON、未来 schema、同名 OMP extension 或无法识别的版本会停止自动更新并保留原文件。

自动安装、手动安装、停用、卸载与信任记录按同一修改队列串行执行，临时文件使用唯一名称，避免首次启动与设置操作并发时相互覆盖。

Agent 启动停在 Hook 或目录信任提示时保留真实现场，不自动确认、不重复启动，也不向对话框发送任务。用户可以“回到现场”审核；完成确认后，由管家把任务交给同一负责人。

## 归并优先级

状态解释使用固定优先级：

1. 当前目标的结构化 Crewvane CLI 写回；
2. 当前 attempt 的原生 Hook 事件；
3. Herdr 生命周期；
4. Watchdog。

Hook heartbeat 不写入 `Goal.activities`，因此不会重置工作区配置的业务无进展计时（默认 30 分钟）。`working` 等 Herdr 心跳可以证明阻塞状态已恢复，但不能证明目标完成。

## Stop 回执状态机

`turn.settled` 不改变目标状态，只启动一次回执检查：

1. 等待 5 秒，给 Agent 的延迟 CLI 写回留出时间；
2. 当前 turn 已有 `progress / wait / review / decide / risk / ship` 等语义写回时取消；
3. 仍无写回时，先核实同一负责人名称与 Pane 仍对应，再发送一个以唯一标记开头的单行提醒，并使用 `agent prompt --wait --until working` 确认负责人实际开始处理；负责人正在工作、终端未恢复输入、状态未知或 Pane 已更换时不插入竞争输入，直接交给管家；
4. 再等 30 秒仍缺失时标记 `protocol_missing`，交给唯一管家核对；
5. 新输入、新 turn、目标结束或重启会取消旧计时器；
6. 有可信 Stop Hook 的 Agent 使用 5 + 30 秒路径；没有 Hook 时继续使用既有 90 秒 Herdr 巡检。

自动提醒失败会保存错误并继续交给管家，不把提醒发送成功误当成语义写回。每个 turn 最多提醒一次。

提醒使用与 attempt、原 turn 绑定的协议 marker。提醒本身产生的 Agent 回合沿用原回执，不再触发下一次提醒；真正的新用户输入仍取消旧回执。发送前先持久记录 reservation，若应用在发送期间退出，恢复后把送达视为未知，等待管家核对，不再次发送。

OMP 的模型与工具循环共用一个用户逻辑回合，不把每次 `turn_start` 当作新用户输入。离线队列按 attempt 与 sequence 补处理，而不是按带随机后缀的文件名排序。应用关闭期间发生的真实 CLI 写回会与补发回合的时间关联，避免恢复后误催办。

## 隐私、可靠性与性能

- 只有具备完整 `CREWVANE_GOAL_ID / ATTEMPT_ID / HOOK_TOKEN / AGENT_NAME / WORKSPACE` 的进程才会被接收；普通 Agent 会话为 no-op。
- Prompt 和最新回复每项最多保存 12,000 个 Unicode 字符；截断时同时保存原文 SHA-256。
- 工具参数、工具输出和终端全文不入库。
- Socket 连接失败或 500 ms 内不可用时不阻塞 Agent，转为私有离线队列。
- 离线队列最多 200 条、保留 7 天；诊断日志达到 1 MB 后轮换一份。
- Hook 本地生命周期传递 p95 目标低于 250 ms；应用不可用时 fail-open 目标低于 500 ms。

设置中的“Agent 接入”显示检测结果、版本、能力、状态、Codex 信任、兼容问题和最近事件。目标详情的运行状态条只显示最近生命周期事件与可用回复，不引入第二套目标状态或复杂表单。

后台事件或派发结果替换注意力事项时，正在编辑的普通留言与图片保留；批准、拒绝等明确状态操作仍按注意力编号隔离，不能沿用上一事项的决定草稿。
Hook 更新只广播当前工作区快照，不发送重置工作区的刷新事件，因此不会关闭或重建正在使用的内嵌现场。

## 失败与降级

Hook 未安装、用户停用、Agent 不支持、配置冲突、应用未运行或本地网关故障时，`owner launch`、Agent 执行和退出均不受影响。Herdr 继续提供现场和工作状态，Watchdog 继续处理阻塞、不可达和无进展；现有目标创建、消息、等待、注意力、验收与恢复流程保持不变。

停用或卸载还会在 Broker 停止接收该 Adapter 的事件，并取消尚未结束的回执计时；已运行的 OMP 等扩展即使缓存了旧配置，也不会继续写入目标。人工接管目标同样会停止自动回执提醒。

## 开发与真实验收

`./scripts/workspace-verify full` 覆盖类型检查、五类官方事件夹具、配置合并、OMP 扩展实际加载、事件隔离、离线排序、停用和回执恢复。`pnpm test:agent-hooks` 是需要本机 Codex 登录的显式真实模型试用，使用独立 HOME、工作区、userData 和命名 Herdr Session；登录文件只以临时符号链接供 Codex 使用，不复制或输出。

真实试用故意让首轮遗漏写回，验证一次提醒后实际执行 CLI、重启应用补处理离线事件，并测量打包 CLI 到真实 Broker 的 25 次传输 p95。仅在此隔离夹具内使用测试启动参数，生产启动命令与 Codex 信任流程保持由用户控制。其他 Agent 的生命周期夹具通过不等于各型号真实模型均已试用。
