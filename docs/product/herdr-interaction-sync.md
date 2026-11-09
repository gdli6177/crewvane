# Herdr 人工交互与 Crewvane 同步

状态：当前实现与验收边界

## 结论

人在 Herdr 的 Pane 中直接操作 Agent，或在 Crewvane 内置终端里直接和 Agent CLI 对话时，Crewvane 可以可靠同步“现场是否还在、Agent 是谁、是否执行中、是否阻塞、Pane 是否移动或关闭”，但不能从终端画面可靠推断用户说了什么、Agent 得出了什么结论、任务是否真的完成。

因此同步分成两层：

1. Herdr 身份、生命周期和可达性由事件加周期对账自动同步。
2. 对话语义和目标状态必须由 Agent 通过 Crewvane CLI 显式写回。

两层之间没有“猜语义”的捷径。只要发生显式写回，桌面通过监听 `.crewvane/state.json` 立即刷新；没有写回时，界面最多显示“现场有新内容，尚未写回目标”，不能把它显示成新消息、完成或审批结果。

## 两类直接交互

### 人在 Herdr Pane 操作已有 Agent

Herdr 原生事件会报告 Agent 名称、Pane / Tab / Workspace 身份和 `working | idle | done | blocked | unknown` 状态。Crewvane 插件把这些事件送入 `crewvane event herdr`，只更新已经登记到目标或管家上的真实现场。

这能同步：

- Agent 是否仍占据原 Pane。
- Agent 是否正在工作、空闲或阻塞。
- Pane 移动后的新身份。
- Pane、Tab、Workspace 退出或关闭。
- 桌面是否应显示“现场有新内容”或“现场不可达”。

这不能同步：

- 用户刚输入的 prompt 原文。
- Agent 在终端里输出的完整回答。
- 用户是否批准了某个审批 UI。
- 目标是否达到完成标准。

`blocked` 是可靠的“需要交互”信号，但它不能说明问题是权限审批、Agent 提问还是普通 TUI 对话框；Crewvane 不应自动发送 Enter、Esc 或猜测答案。

### 人直接和 Agent CLI 聊天

CLI 的终端输出是原始终端流，不是稳定的消息协议。即使内置终端能显示同一 Pane 的字节，也不能可靠区分人工键盘输入、程序重绘、Agent 回复、工具调用和审批界面。屏幕出现“完成”、Herdr 显示 `done`，都不等于 Crewvane 目标已经验收。

语义同步依赖 Agent 遵守 Crewvane 写回协议：

```text
crewvane direct --current "用户刚说的话"
crewvane direct --new "用户在终端里新建的事项"
crewvane goal message GOAL_ID --text "用户的补充意见"
crewvane goal progress GOAL_ID --summary "Agent 的明确进展"
crewvane goal wait GOAL_ID --reason "真实等待对象"
crewvane goal decide GOAL_ID --question "需要人决定的问题"
crewvane goal review GOAL_ID --summary "交付与检查事实"
```

`direct`、`message` 和普通聊天只追加人的原话，不改变目标状态。`progress`、`wait`、`decide`、`review` 等是 Agent 在明确事实发生后提交的状态协议。批准、退回和验收仍使用独立命令，由人操作或管家依据明确的用户原话记录；core 不从聊天正文推断。

### 现场答复回执

每次请求决定、验收、介入都有独立的 `attentionRequest.id`；旧快照和到期提醒有稳定的兼容编号。负责人收到人的直接答复后先读取目标，再调用：

```sh
crewvane goal scene-reply GOAL_ID --attention-id REQUEST_ID \
  --quote "用户本轮完整原话" --summary "实际处理结果、未解决的问题与下一步" --json
```

回执保存用户原话和负责人说明，生成持久的 `scene_reply` 派发。界面显示“现场已答复，管家核对中”；尚未核对前不假装事项已解决。管家只读当前目标，核对事项和回执编号后调用对应状态命令，用户不用回 App 再说一遍。决定和结束命令必须保留回执原话；替换问题或更新答复后，旧案卷命令在同一存储事务内被拒绝。需要负责人继续时通知原现场，不重建负责人。

新负责人启动时总会携带现场回写协议，包括自定义 CLI。已有负责人通过安全补核对支持升级：打开现场仅记录访问；插件或对账观察到一次 `working → idle/done` 后，应用只向同名、同 Pane 且确认空闲的已识别 Agent 发送一次核对提示。提示要求它核对自己的真实对话，不携带整段终端历史，也不是用户答复或执行授权。持久原子领取避免并发或重启重复发送；系统核对本身不会形成核对循环。

仅打开现场不会触发核对或清除事项。`working`、`blocked`、`unknown`、已替换的进程和无可靠生命周期的自定义 CLI 不自动注入核对；后者依赖启动协议中的显式回写。核对失败或没有明确回执时保留原事项并显示重试入口；中断的核对超过 150 秒允许人工重试。核对成功仅表示提示送达，不代表已经完成、批准或验收。

随应用安装的 Crewvane Skill 负责把这条协议告知外部 Agent。它是行为契约，不是安全沙箱；第三方 Agent 仍可绕过 CLI 直接操作文件和系统。

## 事实源

| 事实 | 首选事实源 | 同步方式 | 可靠性 | Crewvane 用途 |
| --- | --- | --- | --- | --- |
| Agent 名称与 Pane / Tab / Workspace 身份 | Herdr `agent list` | 周期对账，10 秒兜底 | 高 | 找回真实现场，拒绝复用已替换进程 |
| 自定义 CLI 的真实进程 | `pane process-info` 的前台 PID | 派发前核对，恢复时核对 | 高 | 防止向 shell 或无关注入任务 |
| `working / idle / done / blocked / unknown` | `pane.agent_status_changed` | 插件事件即时写回，`agent list` 补偿 | 高；只代表 Herdr 分类，不代表业务完成 | 显示现场状态和阻塞介入 |
| Pane 移动、退出、关闭 | `pane.moved`、`pane.exited`、`pane.closed`、`tab.closed`、`workspace.closed` | 插件事件 | 高 | 立即标记不可达，更新或清理引用 |
| 终端有新输出 | Pane 输出 revision，正文需 `pane read` | 可选现场提示 | 中 | 只提示“有新内容，尚未写回目标” |
| Pane 原始字节 | 内置 PTY / `pane read` | 同 Session 现场显示 | 中，仅供人阅读 | 镜像终端、复制粘贴、人工排障 |
| Agent / 用户聊天语义 | Agent 显式 Crewvane CLI 写回 | 状态文件监听 | 高，前提是写回 | 消息历史、目标说明、下一步、决定与验收上下文 |
| Agent transcript | 特定 CLI 的可选 adapter | 仅在有稳定 session / transcript 引用时启用 | 依 CLI 而异，不能作为通用协议 | 补充阅读与检索，不直接驱动状态 |

## 同步触发

1. **Herdr 插件事件**：Agent 状态和 Pane 生命周期变化后即时送入 Crewvane core，按真实身份匹配。
2. **周期对账**：每 10 秒读取 `agent list`，补偿插件故障、服务暂停或事件丢失。
3. **前台 PID 校验**：准备、恢复或派发前，用 `pane process-info` 确认登记进程仍在前台。
4. **状态文件监听**：Agent 调用 Crewvane CLI 后，桌面监听 `.crewvane/state.json` 并立即刷新。
5. **内置终端 PTY**：人在 Crewvane 内直接操作 Herdr Session 时，用原始字节流显示现场；它不创建第二份业务状态。
6. **可选 transcript adapter**：只有某个 Agent 提供稳定、可验证的会话标识和读取接口时才接入，并按 Agent 能力单独开关。

## 保存内容与边界

| 内容 | 保存位置 | 是否权威 |
| --- | --- | --- |
| Workspace / Tab / Pane / Agent 名称 | 目标或管家的 Herdr 引用 | 是，但属于定位信息 |
| 前台 PID | Herdr 引用 | 是，属于进程身份 |
| 生命周期与可达性 | 目标的 `live` / 管家状态 | 是，来源于 Herdr |
| 显式写回的用户原话与 Agent 状态事实 | `packages/core` 目标事件记录 | 是 |
| 内置终端原始输出 | xterm 当前内存与 Herdr Pane | 否，仅现场显示 |
| 未写回的目标语义摘要 | 不持久化为目标消息 | 否 |

原始输出不得自动转成 prompt 或 reply，也不得因为出现关键词“完成”“批准”“yes”等就执行状态命令。图片只有在终端能提供真实本地文件时才能通过 `--attachment` 写回；无法取得文件时要求用户回到桌面附件入口，不能静默丢弃。

## 失败与回退

| 失败 | 回退 |
| --- | --- |
| 插件事件丢失 | 10 秒 `agent list` 对账 |
| Agent 引用失效 | 使用真实 Agent 名称和 PID 查找；找不到则标记不可达，要求人工恢复 |
| 原 Pane 被其他程序占用 | 保留该程序，不复用 Pane；在独立 Pane 恢复管家或负责人 |
| Pane 已移动 | 用新身份原子替换旧 Pane / Tab / Workspace，旧 ID 停止匹配 |
| Agent 没有写回 | 目标状态保持不变；UI 明确提示现场有新内容但尚未同步 |
| Agent 写回失败 | 保留目标与错误，可重试；不从终端文本自动补写 |
| transcript adapter 不可用 | 退回 Herdr 生命周期同步加显式 CLI，不阻塞目标管理 |

## 实施阶段

### 当前版本

- Herdr 事件同步 Agent 身份、状态、移动、退出和关闭。
- 周期对账和前台 PID 校验。
- 内置终端显示真实 Herdr Session，支持拖动、全屏、隐藏和系统剪贴板复制粘贴。
- `direct`、目标消息和显式状态 CLI。
- 随应用安装 Crewvane Skill，指导外部 Agent 使用写回协议。
- 未写回时只提示现场有新内容，不猜测目标语义。

### 后续可选

- 为少数具备稳定会话 API 的 Agent 提供 transcript adapter。
- 为 Pane 输出 revision 增加轻量“有新内容”提示和已读游标。
- 在 Terminal Profile 中按 Agent 类型配置可选的 session / transcript 集成。

### 当前不做

- 解析 ANSI 屏幕并自动识别 Agent 回答、批准或完成。
- 对任意 CLI 注入统一消息协议。
- 把 `idle`、`done` 或终端关键词当作业务完成。
- 在用户不知情时切换 Pane、向阻塞审批自动输入，或关闭用户手工启动的会话。
- 为所有 Agent 维护一套 Crewvane 私有的聊天记录副本。
