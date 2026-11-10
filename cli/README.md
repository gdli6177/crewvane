# Crewvane CLI

Crewvane 桌面应用在“设置”中安装自包含 CLI，管家和负责人通过它读取目标、写回进展并提交交付。CLI 与桌面使用同一个 `packages/core` 状态服务，不需要单独运行后台服务。

命令分为两类：

- **消息入口**：`ask`、`goal message`、`direct`。保存人的原话和附件；外部等待交回 Agent 处理时先恢复 `active`、清除旧等待与提醒，原下一步保留，由管家核实后重新安排。
- **Agent 状态协议**：`progress`、`wait`、`review`、`decide`、`risk`、`ship` 等。仅在明确事实发生后由管家、负责人或受信任适配器调用。

人的自由文本不会由 core 按关键词自动改变状态。管家收到消息后，只能在语义明确时调用当前目标的 `progress`、`wait`、`accept`、`complete`、`rework`、`drop`、`resolve` 或 `remind`；完成、放弃和决定必须把用户原话写入 `--note` / `--reason`。语义含糊时先追问，不能从顺承词或一般认可中猜测。

`waiting` 只表示等待用户和全部 Agent 之外的具名外部第三方。`goal wait --owner` 必填，写入 `waitingFor` 而不改变执行负责人；`goal update --status waiting` 也必须提供有效的 `--waiting-for`。需要用户选择、确认、提供信息或操作时用 `decide`，内部协调保持 `active`。`remind` 只设置提醒，不改变生命周期。

人在负责人 Herdr 现场直接答复时，负责人先用 `goal show ID --json` 读取 `attentionRequest.id`，再提交 `goal scene-reply ID --attention-id REQUEST_ID --quote "用户完整原话" --summary "实际结果与下一步"`。回执持久保存并交给唯一管家核对，本身不改变注意力。管家案卷自动绑定事项和回执编号，旧答复不能清除新问题；决定与结束命令必须保留回执中的原话。仅查看现场、Agent 空闲或普通进展都不视为已经处理。

```sh
crewvane --help
crewvane status --json
crewvane attention --json
crewvane board
crewvane ask "检查发布流程并补齐证据"
crewvane ask "按截图修复布局" --attachment /path/to/screenshot.png
crewvane capture "以后研究这件事" --attachment /path/to/reference.png
crewvane capture "我去办理手续" --self --remind-at 2030-01-01T09:30:00+08:00
crewvane goal start <ID> --by self
crewvane goal start <ID> --by concierge
crewvane goal list --json
crewvane goal show <ID> --json
crewvane goal message <ID> --text "增加回滚验证"
crewvane direct --current "补充背景，不改下一步"
crewvane goal risk <ID> --category delete-data --summary "删除生产数据库"
crewvane goal ship <ID> --operation deploy --checks passed
HERDR_PLUGIN_EVENT_JSON='…' crewvane event herdr --json
```

`capture` 默认保存到待办池的“先记下”，`--self` 保存到“我来做”。两者都不联系管家、
不创建 Herdr 会话；可附带项目、图片和明确提醒。`goal start` 复用同一目标，只有
`--by concierge` 才派发，重复调用不会重复创建请求。个人事项用
`goal complete ID --note "我已做完"` 直接完成；`goal drop` 保留移出记录，未绑定现场的
个人事项可用 `goal restore ID` 恢复到暂存。自由文本不会自动开始暂存事项。

受管管家在终端里收到明确的“先记下”或“我亲自做”的新事项时，使用
`direct --new --handling later|self "<原话>"`，记录不会被再次派发。已有事项的
`direct --current` 只补充原文，不能使用 `--handling` 改变状态。

指定工作区：

```sh
crewvane goal list --root /path/to/workspace --json
# 或
CREWVANE_WORKSPACE=/path/to/workspace crewvane goal list --json
```

`crewvane board` 是随应用的 Herdr 插件打开的注意力控制台。它显示决定、验收、到期跟进和介入，支持补充/决定、等待跟进、继续推进、人工接管、验收、退回、聚焦真实负责人现场，以及按 `g` 回到全局管家。`--once` 输出静态文本，适合诊断。桌面未运行时，`ask` 与补充意见仍会保存在同一个工作区，下一次启动桌面后自动派发。

用户直接在 Herdr 管家终端里追加要求时，管家必须先用 `crewvane direct "<原话>"`（当前案卷）、`crewvane direct --goal ID "<原话>"`，或以 `crewvane direct --new "<原话>"` 创建新目标，把输入写到共享状态，再继续协调。`direct` 只追加人的消息，不接受 `--next`，也不改变状态；确有状态变化时必须另用明确命令。新建成功后，管家的案卷 scope 会原子切到新目标，后续写回直接落在同一个 App 目标，不产生重复派发。Herdr 0.9.5 不向插件暴露用户提交的 prompt 文本，所以这条同步由管家通过 CLI 完成；没有执行这一步的普通终端聊天不会出现在桌面或注意力面板。

图片使用可重复的 `--attachment PATH` 传入：

```sh
crewvane ask "按图修复页面" --attachment ~/Desktop/before.png --attachment ~/Desktop/after.png
crewvane direct --current "再参考这张图" --attachment ~/Desktop/detail.jpg
crewvane direct --new "从终端新建并带图" --attachment ~/Desktop/context.png
```

CLI 只接受 PNG、JPEG、WebP、GIF；单张最多 10 MB，每个目标最多 8 张且总计不超过 30 MB。文件按魔数校验后复制到 `<workspace>/.crewvane/attachments/`，状态与分析事件只保存相对路径、大小和 SHA-256，不保存 Base64。`goal show` 的普通文本输出会列出可直接读取的绝对路径。目标结束 30 天后，桌面启动时清理原图；也可以在目标详情逐张删除，或永久删除整个已结束目标。完成或放弃目标时，应用会关闭对应负责人 Tab；关闭请求失败时保留现场引用，巡检恢复后自动重试。永久删除已结束目标前也会先关闭对应 Tab，Herdr 不可达时删除失败并保留目标，现场关闭后可再次删除。

管家首次派发目标时使用 `crewvane owner launch`。该命令只接受当前受管案卷，默认读取已保存的目标原文和下一步，创建独立 Herdr Tab，清除管家继承的协调者环境，按设置中的负责人启动命令与完整参数启动 Agent，绑定真实现场后再发送任务。长补充说明使用当前工作区内的 `--task-file`，避免受 Agent 终端约 1 KB 的单次命令行输入限制。已有负责人时直接复用原现场。

`crewvane event herdr` 是插件内部入口，读取 Herdr 注入的 `HERDR_PLUGIN_EVENT_JSON`。它把 `pane.agent_status_changed`、`pane.exited`、`pane.closed`、`pane.moved`、`tab.closed` 和 `workspace.closed` 同步到已经登记为对应现场的目标；Pane 移动时以 Herdr 返回的新 Pane、Tab 与 Workspace ID 原子替换旧现场。无关或跨目标现场不会串案。

## 管家案卷边界

管家由 Crewvane 启动时带有 `CREWVANE_COORDINATOR=1` 和当前案卷 scope。此时 CLI 只允许：

- `status`；
- `goal show <当前ID>`；
- 当前目标的 `goal update/progress/wait/decide/risk/ship/accept/complete/rework/drop/resolve/remind`；
- 当前目标的 `session set`。

`goal list`、`attention`、`ask`、`goal message` 以及任何跨目标读写都会被拒绝。每次通知也带唯一 `case_id`，同一工作区严格串行发送，避免多个目标在长期会话中串案；结束类状态命令还要求 `--note` 保留用户明确确认的原话。

这是 Crewvane CLI 的应用层数据边界，不是操作系统文件沙箱，也不能阻止第三方 Agent 绕过 CLI 直接访问文件。Agent CLI 的模型、沙箱和权限参数完全使用用户配置的原生 argv；Crewvane 不会自动添加 Codex 专属 `workspace-write` 或其他运行时参数。

## 写回目标

人的消息：

```sh
crewvane goal message <ID> --text "预算已经批了，按方案 A 继续"
crewvane direct --current "再参考这张图" --attachment ~/Desktop/detail.jpg
```

这两条命令只保存原话和附件，并通知管家读取；目标状态和下一步不变。

Agent 在明确事实发生后使用结构化协议：

```sh
crewvane goal progress <ID> --summary "已完成方案" --next "开始实现"
crewvane goal wait <ID> --reason "等待审批" --owner YR --remind-at 2026-11-05T10:00:00+08:00
crewvane goal decide <ID> --question "是否保留旧接口？" --next "等待你的决定"
crewvane goal risk <ID> --category external-message --summary "向全部客户发送公告"
crewvane goal ship <ID> --operation merge --checks passed
crewvane goal review <ID> --summary "功能已实现" \
  --location /path/to/result \
  --check "单元测试::pnpm test::passed::全部通过"
crewvane goal rework <ID> --note "补充边界场景"
crewvane goal accept <ID> --note "已查看实际成果"
crewvane goal complete <ID> --note "方案没问题，结束这个目标"
crewvane goal resolve <ID> --note "批准今天发布" --outcome approved
crewvane goal resolve <ID> --note "拒绝删除旧数据" --outcome rejected
crewvane goal drop <ID> --reason "不再需要"
```

`goal review` 至少接受一项真实检查记录，且检查结果必须为 `passed`。`goal ship` 只按项目策略返回是否放行或需要人审批，不替负责人执行 Git 或部署。

`goal complete` 用于没有待验收交付、但用户已经明确要求结束的事项；`goal accept` 仍要求目标已经提交带检查记录的成果。两者都由 core 记录执行者与原话，人工按钮和管家聊天走同一份审计记录。

## 上线策略、决定账本与高风险动作

- 新项目默认 `external-approval`。项目可在桌面设置中改为 `auto` 或 `auto-merge-manual-deploy`；策略只能由人修改，受管管家 CLI 没有修改入口。
- `goal ship` 先要求检查通过。`external-approval` 的合并与部署、`auto-merge-manual-deploy` 的部署会产生人类审批；有审批记录后再次判断会放行。
- 人批准或拒绝决定后写入 `.crewvane/decisions.md` 或 `.crewvane/rejected.md`，保存原话、时间、来源、项目、目标与稳定动作键。`goal decide` 自动查账本，命中后不再重复进入注意力。
- `delete-data`、`stop-service`、`spend-money`、`external-message`、`product-direction`、`create-secret`、`rotate-secret`、`change-permissions`、`change-ship-policy` 九类动作始终通过 `goal risk` 升级；这条规则不受项目上线策略影响。它由 core 的应用层协议判定，不是操作系统沙箱；第三方 Agent 的文件与网络权限仍由其自身 CLI 决定。
- 同一目标的审查最多三轮，轮次按目标累计；第四次提交被拦截并升级，人在注意力面板明确允许后才增加一轮。审查只报告会导致错误的问题，风格建议不占用轮次。

Herdr 现场由 Agent 使用真实 ID 关联：

```sh
crewvane session set <ID> --session "$HERDR_SESSION" --workspace <实际ID> --tab <实际ID> --pane <实际ID> --agent <实际名称>
```

默认输出简洁中文，追加 `--json` 输出结构化记录。所有写入使用工作区锁和原子快照；桌面和 CLI 可以并发操作不同目标。

## 本地构建

```sh
pnpm --dir cli test
pnpm --dir cli typecheck
pnpm --dir cli build
node cli/bin/crewvane.js --help
```

桌面打包会把同一份 CLI bundle 和独立 Node runtime 嵌入应用；发布用户不需要安装 Node，也不需要保持桌面窗口打开。
