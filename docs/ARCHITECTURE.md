# Crewvane 架构

产品基线见 [全局管家与注意力中心开发说明](product/attention-center-development.md)。

## 边界

```text
Electron 主进程      可信文件选择、Herdr、系统通知、受约束 IPC
React 渲染进程       注意力、目标详情、设置；无 Node 或任意命令能力
packages/core        目标、消息、附件、注意力、决定、状态命令、锁与原子存储
cli                  人用消息入口与受信任 Agent 状态协议，调用同一个 core 服务
Herdr                Session、Tab、Pane、Agent 生命周期与消息
Herdr 插件           注意力 Pane、新目标与回到管家动作；不是安全边界或状态副本
```

Crewvane 不运行模型，不扫描或适配 Agent 协议，不管理模型凭据。应用内用 xterm.js 显示 Herdr 的 TUI，用独立 Electron utility process 中的 node-pty 提供真实 TTY；会话、Agent 管理与通信由 Herdr 负责。任意已经能在 Herdr 中运行的 CLI Agent 都可以使用。

## 状态

工作区由用户选择，状态位于 `<workspace>/.crewvane/`。`state.json` 是完整快照，`events.jsonl` 是追加事件记录，工作区根目录的 `.crewvane-lock/` 串行化桌面和 CLI 的读取、恢复与并发写入，确保旧状态被整体归档时不会与写入交错。每次修改先写临时文件，再原子替换快照。`decisions.md` 与 `rejected.md` 由结构化决定记录派生，供 Agent 和人直接阅读。图片原图位于 `.crewvane/attachments/`，状态只保存相对路径、MIME、大小和 SHA-256；导入校验真实文件魔数并限制数量与体积。已结束目标保留图片 30 天，应用启动时清理，也支持逐张或随目标永久删除。

`WorkspaceState.version = 2` 当前包含项目及项目上线策略、目标、决定账本与唯一管家引用。旧状态中的 `workflows` / `steps` 字段只作为结构兼容占位读取，不再暴露产品或协议入口。打开工作区时，core 先验证快照版本和顶层结构；有效 v2 原样读取。发现 v1、未来版本、损坏 JSON、缺字段快照或只有旧事件日志时，在 workspace 根目录取得恢复锁，先在相邻临时目录完整生成 v2 数据，再把整个 `.crewvane` 原子归档为 `.crewvane.backup-*` 并切换新目录。归档保留附件与旧事件，不猜测迁移执行状态或 Herdr 现场；新状态写入 `recovery` 标记，桌面显示备份原因和打开入口。细节见 [工作区兼容检查与自动恢复](product/workspace-recovery.md)。

目标内容与状态命令分离：

- `goal.message` / `goal.direct` 只追加人的原话和附件，不按正文改变 `status`、`next` 或等待对象。等待提醒被回复时，消息入口会清除已经处理的到期注意力与旧提醒，再交给管家判断下一步；目标仍保持等待，直到管家提交结构化状态命令。
- `goal.progress`、`goal.wait`、`goal.review`、`goal.decide` 等是 Agent 或受信任适配器提交的明确状态事实。
- `goal.accept`、`goal.complete`、`goal.rework`、`goal.drop`、`goal.resolve` 由人通过明确操作触发，或由当前案卷管家在用户明确说完成后执行；结束与决定必须保存用户原话，不从“可以”“继续”等顺承词自动推断。
- 活动记录按 `goalId` 隔离，原始 Agent 内容保持不透明；UI 不要求固定摘要模板。

注意力是独立派生：

| 来源 | 进入注意力 |
| --- | --- |
| 人工或管家请求决定 | 是 |
| 项目上线策略要求审批，或命中九类高风险动作 | 是；决定账本已有记录时直接沿用 |
| 提交了带真实检查的交付 | 是，等待验收 |
| 等待事项到达提醒时间 | 是 |
| Herdr Agent 为 `blocked` / 不可达，或目标长期无进展 | 先请管家核查；联系失败或未恢复再提示人介入 |
| Herdr `idle` / `done` / `unknown` 或普通进展 | 否 |

`done` 只是 Agent 空闲，Crewvane 只有在交付检查记录通过且人验收后才把目标设为完成。

活跃目标的负责人持续 `idle` / `done` 90 秒且仍未写回结果时，巡检请管家核对该负责人是否遗漏结果、真实等待或交付。核对期间界面显示“待管家核对”，而不是把业务上的 `active` 当作终端一直在执行；恢复 `working` 或提交新的结构化决定、交付后清除旧核对提示。`active` 只表示目标仍需跟进。终端空闲不自动改变业务状态，也不会直接产生人的注意力事项或自动验收。

负责人现场答复通过 `goal.scene-reply` 保存原话和实际结果，再由唯一管家提交状态命令。注意力与回执分别具有独立编号；管家 scope 绑定二者并在状态事务内校验，防止迟到回复清除新问题。现场访问和工作回合仅触发空闲时的一次协议补核对，不构成审批事实；失败保持事项和重试入口。细节见 [人工交互同步](product/herdr-interaction-sync.md)。

待办池复用 `Goal`，通过 `backlog` 生命周期和 `manual` 执行归属区分暂存与本人执行，不建立第二个存储。`goal.intake.handling` 明确选择 `later`、`self` 或默认 `concierge`；前两者没有派发请求。暂存不巡检、不能登记现场或通过进展命令变相启动。人工提醒到期与等待提醒共用稳定 attention ID，但保留原生命周期；只有明确交给管家才建立派发。完成个人事项无需 Agent 交付；移出保留历史，可恢复到暂存。见 [待办池开发说明](product/task-pool-proposal.md)。

### 场景优先导航

注意力中的真实现场介入与有真实引用的普通活动目标直接打开 Herdr；决定、验收、到期跟进与派发失败使用轻量动作卡。已完成和已放弃目标只打开历史记录。完整记录继续承担附件、消息历史和目标管理，现场条仅展示结构化目标事实并提供回到注意力的入口。

入口策略集中在 `apps/desktop/src/features/goals/goalEntry.ts`，动作卡复用 `GoalActionDock` 与 core 命令。Electron 的 `terminal-open` 事件携带当前 `goalId`，渲染进程只从同一份工作区快照派生现场上下文，不维护终端内容副本，也不把滚动历史注入 Agent 上下文。

## Herdr 管家

`Executables` 将 Finder 的精简 PATH 与用户登录 shell 的 PATH、常见安装目录合并，保留可执行入口的符号链接名称。安装包在构建时从 Herdr 官方 GitHub Release 获取当前平台二进制，校验 SHA-256 后再连同应用签名；用户首次启动不依赖 Homebrew、网络或系统 PATH。`HerdrInstallation` 启动时先探测应用内置、userData/runtime 或本机已有版本，有效二进制立即可用；随后通过轻量 GitHub Releases API 在后台检查最新版，发现更新时把官方资产下载到 userData/runtime/herdr，再次校验 SHA-256 与实际版本后原子替换。安装请求去重，不修改用户已有安装。更新检查失败时继续使用内置或本机 CLI，并显示可重试提示；安装失败不丢目标。

已识别的 CLI 使用 Herdr Agent 通信；任意自定义交互式 CLI 通过真实 Pane 启动，原样保留可执行文件与参数，用 `transport=pane` 与前台 `processId` 记录并复用。每次发送文本前核对该进程仍在前台，退出或换进程时拒绝发送；没有 Agent 生命周期信息时只报告 unknown。不把任意程序“成功启动”当作理解任务或完成任务。用户复杂 shell 表达式通过自己的启动脚本承载。

Crewvane 不向 Codex 或其他 Agent CLI 注入运行时专属的 `workspace-write`、网络开关、审批参数或额外目录。设置中的启动命令是可执行文件与原生 argv；支持哪些模型、沙箱和权限选项由该 CLI 自己决定。Electron renderer 的 `sandbox: true` 是应用安全边界，与 Agent 执行权限无关。

应用打开工作区后使用按路径派生的命名 Session，也可以通过 `CREWVANE_HERDR_SESSION` 固定名称。准备管家会检查 CLI 和 Server，优先复用实时 `concierge`，检查登记的 Pane，再显式设置工作区、Session 和 CLI `PATH`，最后启动默认的 Codex 管家。Session 未运行时，应用内 PTY 启动 `herdr session attach <session>` 并等待 Server 就绪，不打开系统 Terminal。同一工作区复用一个连接；收起面板不终止会话，重启应用重新 attach。输入和尺寸 IPC 只允许访问当前工作区的连接，不接受渲染器指定的可执行文件。

管家通过 `crewvane` 读取和写回目标，只负责分发、协调跟进与向人交接。所有实际执行，包括简单任务、返工和检查，都交给独立负责人；管家不得在阻塞时接手执行。负责人使用 Herdr Tab、Pane 和 Agent 消息，但 Crewvane 不预设任务图、分配算法或固定层级拓扑。

Herdr 0.9.5 的插件事件不暴露用户提交的 prompt 文本。用户直接在管家终端追加入口时，管家先调用 `crewvane direct` 写回原始消息：带当前案卷时追加活动，明确的新事项创建新目标并标记为已经从终端送达，避免桌面再次派发同一文本。`direct --new` 成功后会把管家的案卷 scope 原子切到新目标，允许同一回合继续读取、整理和派发新案卷。桌面监听 `.crewvane/state.json`，外部 CLI 写入后立即刷新，不需要等待 10 秒巡检。这个同步依赖管家执行协议；未经 CLI 写回的终端聊天仍只是终端内容。

职责边界通过初始身份说明、每次目标通知与巡检消息传达。身份初始化是一个没有案卷的独立回合，只确认长期职责后结束，不得读取或猜测目标。每次目标与巡检通知只包含一个 `case_id` 和一个目标的快照，并以案子标记包裹；同一工作区的通知由队列严格串行，必须等当前管家回合进入 `idle` / `done` / `blocked` 后再发送下一案卷，不同工作区可以并行。处理案卷的回合不得创建后台任务、循环轮询或等待负责人完成，否则旧案卷会悬挂并污染下一条通知的 scope。每次应用启动后首次恢复已有管家时，只有 Herdr 状态为 `idle` / `done` 才刷新身份说明，同一运行中按实际管家引用去重；`working` / `blocked` / `unknown` 只保留并聚焦真实现场，不发送身份 prompt。“找管家”直接打开已登记的 Tab/Pane，让用户处理阻塞 UI；已知 blocked 时派发返回可操作状态，不自动发送 Enter、Esc 或其他输入。它是 Agent 行为契约，不是操作系统权限隔离；Crewvane 无法拦截任意第三方 CLI 内部的工具调用。

管家进程从 `<workspace>/.crewvane` 启动，并继承 `CREWVANE_COORDINATOR=1` 与当前案卷 scope 文件。受管 Crewvane CLI 只允许读取当前目标的详情和 status，以及更新该目标的 update、progress、wait、decide、risk、ship、accept、complete、rework、drop、resolve、remind 和 session；`goal list`、attention、ask、message 和跨目标读写会被拒绝。结束或放弃时 CLI 要求 `--note` / `--reason` 保留用户明确说出的原话。该边界保护 Crewvane 数据 API，不能阻止 Agent 直接读取文件或绕过 CLI。

首次创建负责人统一调用受管的 `crewvane owner launch`。这个 CLI 流程原子地创建独立 Herdr Tab、在 Pane 内清除管家的 `CREWVANE_COORDINATOR*` 环境、显式导出负责人署名、目标 ID、Crewvane 工作区与真实 workspace/tab/pane 上下文、启动设置中保存的完整 Agent argv、记录真实现场并发送任务。即使执行目录是另一个项目，子进程也必须继续写回原 Crewvane 工作区。默认任务正文直接读取已保存的目标原文与下一步，避免受 CLI 终端约 1 KB 的单次命令输入上限影响；环境初始化和自定义 CLI 输入均按 Unicode 码点拆成不超过 768 字节的短行，长 PATH 分组导出而不丢弃目录。长补充说明只能通过当前工作区内受校验的 `--task-file` 传入。它避免模型手工串联多个 Herdr 命令时漏掉环境隔离；任一阶段失败会关闭尚未绑定的 Tab 或用结构化错误保留已绑定现场供核对。自定义 CLI 仍通过真实前台 PID 记录为 pane transport。

## 上线策略与决定账本

`Project.policy` 包含 `shipPolicy`、可选审批人、修订号与更新时间。默认 `external-approval`；`auto` 允许检查通过后合并和部署，`auto-merge-manual-deploy` 只自动放行合并。审批人只用于展示，不参与身份校验。策略设置命令要求 `actor="你"`，桌面设置是唯一提供的入口，受管 CLI 不提供参数。这个校验是应用层约束，不是操作系统账户认证。

`goal ship` 先拒绝未通过检查。需要审批时只建立 `decision` 注意力，不会执行外部动作；人批准后写入账本，再次调用才返回 `allowed=true`。`goal risk` 覆盖删除数据、停服、花钱、外部发消息、产品方向、新建或轮换密钥、修改权限和修改上线策略，九类动作无论项目策略为何都先问人。

决定账本按项目与稳定动作键查找，批准和拒绝都保存原话、时间、来源、目标。命中已有决定时 `goal decide` / `goal risk` 不再产生注意力。`goal review` 对每个目标最多接受三轮，第四轮只建立 `intervention`；人在注意力面板允许后才提高一轮上限。

## Herdr 插件

应用包内包含一个本地 Herdr 插件 `dev.crewvane`。Herdr 可用后，应用把插件原子部署到 `userData/herdr-plugin`，通过固定 ID 注册或更新，并在设置中显示就绪状态。插件随 Crewvane 安装和升级，不需要用户另装 Node、从 GitHub 再下载或手工执行 `plugin link`；应用只使用打包内的固定源码，不静默更新远程代码。插件源码摘要变化时即使应用版本未变也会重新登记，避免新增动作或事件钩子停留在旧清单。

插件提供三个动作与两个 terminal Pane：打开注意力控制台、直接进入一行新建目标，以及按真实 Agent 名称回到全局管家。控制台直接调用内置 `crewvane board`，读取 `.crewvane/state.json` 的同一份 core 数据，展示需要决定、验收、到期跟进和介入的事项。它支持补充意见、提交决定、请求跟进、等待事项交给管家或人工接管、验收通过、退回修改、聚焦真实负责人 Tab，以及 `g` 回到管家；新建入口调用同一 `crewvane ask`。这些入口都不维护第二份状态，也不自行执行目标。

Herdr 的 `pane.agent_status_changed`、`pane.exited`、`pane.closed`、`pane.moved`、`tab.closed` 和 `workspace.closed` 事件由插件脚本送入内部 `crewvane event herdr`。CLI 兼容 Herdr 原生的 `{ event, data }` envelope，再按真实 Pane、Tab 或 Workspace ID 查找已登记负责人现场，只有命中目标时才执行 core 的 `live.event`。Pane 移动时用 Herdr 返回的新 Pane、Tab、Workspace 与 Agent 身份原子更新目标，旧 ID 立即停止匹配，避免后续关闭或状态事件落到失效引用。事件是桌面 10 秒 Agent 列表轮询的即时通道和断线补偿，不改变 `idle` / `done` 不等于完成的规则。

插件适合 Herdr 内的快捷入口，不承担持久化、案卷隔离、Agent 权限或系统文件沙箱。插件 v1 的代码继承用户权限并可使用完整 Herdr CLI；Herdr 不沙箱插件。因此权限判断和状态写入继续留在受约束的 Electron IPC 与 Crewvane core，插件只作为表现和动作层。事件钩子只有在能提供明确增益且不会产生双写竞争时才引入。

通知送达与负责人现场登记是两个独立事实。系统通知和可选 Webhook 消费明确的目标状态变化与只读注意力；状态变化可按各状态分别订阅，Webhook 配置保存在应用数据目录且不回传令牌；普通 HTTP 2xx 记为送达，飞书 / Lark 和企业微信还要求响应业务码为 0，失败按 5 分钟退避，稳定投递键跨重启去重，投递失败不回滚目标。未登记现场的活动目标在一分钟启动宽限期后交由管家巡检，不把通知成功显示成已经执行。`session.set` 拒绝把管家现场或其他未结束目标的现场登记成当前目标负责人；真实连接仍由 Herdr presence 核实，包括自定义 CLI 的前台 PID。Webhook 载荷与适配器边界见 [消息通知](product/notifications.md)。

`goal.accept`、`goal.complete`、`goal.drop` 和已结束目标的永久删除会释放负责人现场。桌面立即关闭对应 Herdr Tab，并通过 `session.release` 清理已结束目标的引用；关闭请求失败时保留引用，巡检恢复后继续重试。永久删除会先尝试关闭现场，关闭失败时不执行删除。目标删除只开放给 `completed` / `dropped`，同时删除附件文件；项目决定账本不随目标删除。

## 桌面 IPC

渲染进程通过 preload 暴露的有限接口选择工作区与项目、导入与预览受校验的图片、执行目标命令、管理 Herdr 和 CLI、打开 HTTPS 链接。`BrowserWindow` 使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，拒绝窗口跳转和权限请求。IPC 校验发送方 URL，项目路径必须先由文件选择器选中；附件导入接受字节而不是任意目标路径，预览与打开只接受当前状态中的附件 ID。

目标详情位于 `apps/desktop/src/features/goals/`，拆分为展示状态映射、消息历史、回复编辑器、附件区、状态操作区和组合层。它只依赖显式的 `GoalDetailService`：提交 core 命令、导入和打开附件、打开 Herdr 或 URL、重试派发。模块不直接读取 Electron API，也不从自然语言推断状态。

模块化与插件化约束见 [插件架构](product/plugin-architecture.md)。扩展按 `storage`、`execution`、`terminal`、`agent-discovery`、`notification`、`automation`、`view` 和 `integration` 能力接入；第一方 Herdr、通知和 Agent 发现与第三方实现遵守同一协议。可选适配器失效时，目标的创建、查看、消息、等待和验收仍应可用。

应用内 CLI 使用随包分发的独立 Node 可执行文件，CLI bundle 位于 ASAR unpack 目录，脚本和 Node runtime 都在 `.app` 内。打开工作区时自动安装或刷新 `~/.local/bin/crewvane`，并把它默认绑定到当前工作区。该入口只是应用内脚本的符号链接，因此移动应用后 CLI 会失败并提示重新安装，可避免悄悄执行旧版本。

## 安装和签名

发布产物包含 DMG、ZIP 和 SHA256SUMS。构建后按 Electron 嵌套代码顺序完成 ad-hoc 或 Developer ID 签名，再制作附件；测试在 ZIP 解压和 DMG 复制后验证严格签名，然后启动安装应用、安装 CLI、真实创建目标，并在隔离 Herdr 中验证插件注册和注意力 Pane。

代码签名证明包内完整性，不等于 Apple 公证。没有 Developer ID 时仍可能出现“无法验证开发者”；只有已核对 GitHub 来源与 SHA-256 的应用才应按系统提示打开。
