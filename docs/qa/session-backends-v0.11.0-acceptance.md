# Crewvane 0.11.0 双后端选择：开发验收合同

日期：2026-11-13。规格：[设置切换 Herdr / Orca](../product/session-backends-v0.11.0.md)。

本清单保留开发验收合同，末尾记录实际结果与未验证项。没有任何条目因本文存在而自动算通过。每条必选项必须记录结果、命令/操作、环境和证据路径；mock、真实后端、真实模型和公开下载包分别标注。

## 1. 验收环境与隔离

- 开发基线是 `v0.10.0` 或包含它的 main；记录被测 commit。
- 平台为当前正式支持的 macOS Apple Silicon，至少两台机器验证，其中一台没有开发依赖。
- Herdr 和 Orca 各记录真实二进制路径、版本、runtime 身份、Agent CLI 和 shell 版本；Orca 第一批使用 G0 冻结的已验证版本。
- 使用命名测试工作区、隔离控制目录和配置；绝不停止用户 `default` 或其他未拥有的 Session，不修改用户现有 Hook/alias/凭据。
- 至少一条真实 Codex 端到端目标、一条 OMP 或另一已安装 Agent、一条 shell 自定义 alias/函数；未安装的其他 Agent 用 fixture 验证，不能冒称实机通过。
- 正式权限模式由测试者明确设置。不得通过给 Agent 偷加免确认参数使试验通过。

证据目录必须包含 `manifest.json`（commit、版本、OS、测试 ID、结果）、截图、脱敏命令回执和必要的生成工件。不能保存 token、完整环境变量、真实业务日志或普通无关聊天。

## 2. 核心不变量测试

| ID | 场景 | 必须满足 |
| --- | --- | --- |
| INV01 | 设置选择 Herdr / Orca | 只有一个 selected；不能按目标/项目覆盖 |
| INV02 | 切换两方向 | 所有旧受管执行进程先确认停止，才出现新 backend 的首个业务 Agent |
| INV03 | 新目标、关注、状态写回 | 目标、attention、决定和验收只有 Crewvane 一份；Orca Task 不参与 |
| INV04 | 旧 backendEpoch/attempt 事件迟到 | 不能改当前状态、结束目标、解掉新问题或启动旧 backend |
| INV05 | 终端 idle/completed/blocked/unread | 运行事实与业务状态分开，不能自动验收 |
| INV06 | 目标消息已经被接受但返回超时 | 保留 unconfirmed；原 ID/正文不被换新后自动重放 |
| INV07 | 按钮点多次、CLI/Desktop 同时发起 | 同一目标操作有唯一 receipt；管家唯一，负责人不重复 |
| INV08 | 用户自建 Orca/Herdr 现场存在 | 不认领、不关闭、不改用户全局设置 |
| INV09 | 结束/放弃、待办、manual、外部等待 | 保持各自语义；切换不会把记录项变成执行任务 |
| INV10 | 应用窗口关闭或 focus 失败 | 不推断目标失败，不静默创建新现场 |

## 3. 单元与契约测试矩阵

### 3.1 中性状态与升级

| ID | 输入 | 断言 |
| --- | --- | --- |
| DATA01 | 真实结构的 v3，含所有状态、附件、决定、委托、复核、方法与 bot | 备份先于 v4 写入；ID、业务事实与通知去重身份不丢失 |
| DATA02 | 迁移备份失败/空间不足 | 不覆盖原状态，不归档重建，不启动 Agent |
| DATA03 | v4 重复打开 | 幂等；不重复迁移、发消息或创建工作区 |
| DATA04 | Herdr/Orca scene discriminator 与 locator 不匹配 | 校验拒绝 |
| DATA05 | 旧 runtime、同 PID 新进程、同标题不同 handle | 拒绝发送/关闭/认领 |
| DATA06 | completed/dropped/backlog/manual 的切换 | 零自动创建/发送；原历史完整 |
| DATA07 | 旧 snapshot/default 配置 | 默认 Herdr；不因安装 Orca 自动改选择 |
| DATA08 | v4 新消息后尝试恢复 v3 备份 | 阻止覆盖式降级并给出备份说明 |
| DATA09 | 离线迁移缺少runtime身份的v3引用 | 保留unverified legacyScene；scene留空，不编造runtimeId/generation；重连核实后才取得受管操作权 |

### 3.2 两个 Adapter 复用同一份 contract suite

每个 Adapter 都必须覆盖：检测、连接、创建、查找、inspect、send、focus、关闭、恢复、能力不支持；不能 Herdr 用真实身份校验而 Orca 只判断有个字符串。

| ID | 故障或输入 | 断言 |
| --- | --- | --- |
| API01 | 正确/未知/损坏 JSON、stdout 有额外行 | 用明确 schema 解析，未知结果不误报成功；stderr 不当业务字段 |
| API02 | create 成功但 stdout 丢失/timeout | discover 找回同一请求或保留 unknown；不第二次 create |
| API03 | send accepted，但未观测 turn started | receipt 区分 accepted/started；不能重发或当作任务已完成 |
| API04 | 原 request 安全重试 | payload hash、上游 requestId、incarnation 一致；变化则拒绝 |
| API05 | shell 已回到提示符、终端被换 Agent | 不把业务消息打进 shell 或错误 Agent |
| API06 | focus 返回非 navigated、窗口不存在 | focus_failed；不创建终端 |
| API07 | close exit=0 但无停止事实/timeout | unknown，阻塞停旧启新；只关闭可核实的受管身份 |
| API08 | 同路径多项目、同目录多目标、不同工作区同名目标 | 显式 ID 与 installation/binding 组合去歧义 |
| API09 | 不支持 native-resume | 明确 unsupported；使用案卷恢复，不伪造原会话 ID |

### 3.3 切换与并发故障注入

| ID | 场景 | 断言 |
| --- | --- | --- |
| SW01 | preflight 取消或目标 backend 不可用 | 旧选择不变，原现场不关闭，冻结解除 |
| SW02 | 一个目标 working/blocked/unknown | 异步等待最多30秒，未静止则 backend_busy；不强杀、不启新 |
| SW03 | idle 但回执缺失 | 准备结束解除冻结，再在原backend核对；冻结期间没有偷偷发核对消息；不能idle直接视作安全交接 |
| SW04 | 新目标/新消息与切换同时发生 | 消息持久保存；业务现场操作看到屏障，不漏发不双发 |
| SW05 | launch/send 租约未结束就切换 | 等待或未确认阻塞，晚返回后重查 epoch，不写陈旧绑定 |
| SW06 | 关闭第一目标成功，第二目标关闭 unknown | recovery_required；第三目标/新 backend 不启动 |
| SW07 | 每个阶段落盘后强制退出，再启动 | 从日志恢复；不把多工作区半提交当作 ready |
| SW08 | 工作区A已迁移、B磁盘写入失败 | 屏障仍关闭，日志列出A/B，恢复后不重复副作用 |
| SW09 | 提交新选择后 Orca 连接失败 | 不自动启动 Herdr；展示重连/显式恢复入口 |
| SW10 | 恢复原 backend | 新 epoch；不复用被撤销 token；未确认投递不重放 |
| SW11 | 旧管家/负责人关掉前发来迟到 write/Hook | 新状态和新 attention 不被覆盖；只记有界诊断 |
| SW12 | 多个工作区后台有受管 Agent | 一个选择覆盖所有已登记资源，不能只切当前显示的工作区 |
| SW13 | 注册的工作区不存在或不可读 | 不全盘扫描；列出阻塞，不绕过未知资源 |
| SW14 | 并发切换/CLI启动/跨工作区锁竞争 | 同一 operation；无死锁；锁超时有明确错误 |
| SW15 | 普通CLI伪造operationId或在resuming调用launch | 无内部授权则拒绝；只允许已验证SwitchAuthority清单内的恢复操作 |
| SW16 | 切换冻结时旧现场要关闭，resuming时要恢复 | 内部阶段权限可完成合法动作；普通队列始终冻结，不因全局屏障把切换自身锁死 |
| SW17 | prepared后人追加消息/结束目标/解决决定 | resuming读取最新revision；不丢新消息，不重开已结束目标，不重发旧attention |
| SW18 | resuming中当前授权新Agent提交progress/decide及运行登记，且执行任务仍未结束 | 按原Core权限接受自身案卷写回；旧epoch和越界请求被拒绝；ready不等待整项目标结束 |

### 3.4 Orca 检测与安装

这些用例必须使用公开安装包、隔离 HOME 和无开发依赖的测试机执行。自动安装用例要保留下载来源、预期与实际的 SHA-256、应用签名结果、重新检测结果和最终 selected backend；不能以安装器退出码代替可用性。

| ID | 场景 | 必须满足 |
| --- | --- | --- |
| ORC01 | 全新用户环境没有 Orca，打开设置并选择 Orca | 显示 `missing`、`安装 Orca`、`选择已有 Orca`、`稍后`；选择稍后后 Herdr 保持 selected，已有目标不变 |
| ORC02 | 从 `安装 Orca` 下载、校验并完成标准安装 | 只下载冻结的官方 Apple Silicon 版本；SHA-256、应用身份和签名通过；由用户完成正常安装；重新检测到 `compatible` 后才切换为 Orca |
| ORC03 | 用户取消下载、关闭系统安装器或拒绝安装 | 不激活 Orca，不创建 Orca session；原后端成为当前后端；重新打开设置可继续，但不会自动重复弹窗 |
| ORC04 | 离线、下载被阻断或磁盘空间不足 | 显示具体失败与官方手动下载/选择已有入口；旧选择和现场不变；不伪造安装成功 |
| ORC05 | 安装包损坏或 SHA-256 不匹配 | 拒绝执行临时包，不覆盖已有应用，不激活 Orca；错误可重试或改用手动安装 |
| ORC06 | 应用身份、代码签名或完整性校验失败 | 标记 `incompatible`，不执行、不激活、不关闭旧后端；不能提示用户清除 quarantine 来绕过 |
| ORC07 | 用户通过 `选择已有 Orca` 选中已安装应用 | 验证 bundle、官方 CLI/runtime、版本和能力；兼容时复用已运行 runtime 并激活，不启动第二份 server |
| ORC08 | 找到 Orca 应用但 CLI/runtime 缺失，或版本不在兼容表 | 分别为 `unverified` / `incompatible`；引导修复或官方升级并支持 `重新检测`；修复前保持不可选 |
| ORC09 | 用户已有 Orca、运行中的工程和自定义全局设置 | Crewvane 不静默覆盖、降级或替换应用，不启动第二份 runtime，不改工程和全局设置 |
| ORC10 | 设置点击检查更新/更新 Orca，并取消、离线或发现未验证新版 | 展示已装与已验证版本；仅开放已验证官方包，安装后重检，失败/取消保留选择，更新期间不重复派发或误认旧现场 |

## 4. 打包应用真实端到端试用

必须让管家自己创建独立负责人，不能测试脚本预建两个 Agent 后宣称委派成功。新旧后台进程时间线用于证明互斥，截图只证明可见界面，不能代替进程与派发证据。

| ID | 操作步骤 | 预期结果 |
| --- | --- | --- |
| E2E01 | 从 Finder 打开包 → 默认 Herdr → 一句话同时提出两个目标，分别生成阶段工件并progress回报 | 一个管家、两个负责人；两目标都保持active且有明确下一步，不提前进入review；工件断言通过，互不串目标 |
| E2E02 | 两个负责人均已回报 → 设置确认切 Orca | 旧受管 Agent 停止；创建一个新管家；两个目标依据案卷继续，无重复产物/副作用 |
| E2E03 | 切回 Herdr | 同样的互斥与恢复保证；Orca 不再接收 Crewvane 新业务任务 |
| E2E04 | Orca 选中、Herdr 二进制不可用 | 新目标、管家、负责人、语义写回、人工决定、验收、结束完整通过 |
| E2E05 | 新配置没有 Orca | ORC01–ORC09通过；安装前选择不生效，不要求用户敲 brew/Node 命令 |
| E2E06 | 保持用户自己开的 Orca 工程和 Herdr default | 两方向切换后它们仍存在且内容/全局配置未被 Crewvane 改写 |
| E2E07 | 同普通目录、跨两个项目、无 Git 的个人事项 | 创建与精确聚焦正确；没有额外 git init、分支或 worktree |
| E2E08 | 连续20次从不同目标“回到现场”，再关闭 Orca 窗口重开 | 定位对应真实 terminal，不新建20个现场或Agent |
| E2E09 | `.zshrc` alias 和函数 cursor-2；中文/空格 cwd；长 PATH | 启动的真实程序、argv、cwd、Crewvane root 正确；不替换成 cursor-agent |
| E2E10 | 提交20,000字单段目标、长补充与图片 | 目标不因首行超长失败；任务正文不截断，图片文件可读取 |
| E2E11 | 原生 Orca 现场复制/粘贴文本、粘贴图片、输入法、Agent快捷键 | 使用与单独 Orca 相同路径；Crewvane不吞键；Agent实际识别图片内容 |
| E2E12 | 在负责人现场回答 attention 问题，执行CLI写回 | 解决当前问题，app及时更新；旧attention的迟到答案不能解除新问题 |
| E2E13 | Stop 无写回 → 提醒 → 写回 | 只提醒一次；及时回报取消旧计时器；仍缺失先找管家 |
| E2E14 | 外部等待、到期提醒、人为验收、已放弃、待办池混合后切换 | 不自动推进等待/暂停/待验收/记录项；同条通知不再发送 |
| E2E15 | 目标结束后重启目标 | 使用当前backend；有native-resume才标原会话恢复，否则按案卷继续 |
| E2E16 | 关闭 UI、退出 runtime、重启电脑分别测试 | 区分存活和重建；重新核实身份；不把旧历史当活进程，不重复任务 |
| E2E17 | 待人决定/待验收/暂停目标切换后，点“恢复并进入现场” | 当前backend新attempt只接收问题与证据后等待人；原attention/验收/暂停状态不变，不自动实现/验收；再点击只聚焦 |

验收工件建议用真实小任务：负责人写入唯一 operationId/attemptId 的结果文件，实际运行断言；第二回合追加结果，断言首回合标记出现一次且文件没有重复生成。不要用“Agent 自称完成”的文本代替检查。

## 5. 隐私、性能与 UX

| ID | 测量方法 | 发布阈值 |
| --- | --- | --- |
| PERF01 | 同一包、同机各模式三目标运行，自动点击导航/打开新目标 | 输入到下一帧 p95 <200ms；不因后端调用产生>200ms主线程长任务 |
| PERF02 | 关闭外部现场后立刻连续操作Crewvane | 无旧窗口探测造成的秒级点击阻塞；新目标表单正常输入 |
| PERF03 | 记录两模式各10分钟的CLI进程次数 | 一个runtime每10秒最多一组常规采集；不按目标放大spawn；失败退避 |
| PERF04 | 选 Orca 10 分钟 | 未调用Herdr server/attach/plugin/update；Herdr专项后台轮询为零 |
| PERF05 | 两种模式100个目标的synthetic状态与10000条重复生命周期事件 | 相同观测不反复写快照；重复事件不增加Activity；日志轮转有界 |
| PERF06 | 对比0.10.0同机三次空载、三次三目标 | 记录CPU/RSS与启动时间；Crewvane自身RSS/CPU相对基线退化>20%需定位修复或提出明确评审，不用包体大小冒充性能数据 |
| UX01 | 900×700、1440×960；深浅主题 | 设置完整可达，标签不歪斜；无按钮被现场遮挡；顶部固定 |
| UX02 | 键盘操作选择/确认/取消/恢复、屏幕阅读标签 | 焦点可见并返回正确入口；loading、成功、失败不能只靠颜色 |
| PRIV01 | 不含Crewvane目标env的普通Agent对话 | 不进入Crewvane目标、日志或上下文 |
| PRIV02 | token、凭据、工具输出、终端全文 | 不在receipt/diagnostic/fixture中出现；只保留被允许的有界事件 |
| PRIV03 | 双方已有Hook、同名用户Skill、Orca已有配置 | 内容被保护，卸载Crewvane管理条目不删除其他配置 |

一次性切换操作的进程调用单独计数，不混入常规采集预算。单次读查询超时≤5秒，UI立即有进度反馈；创建/发送/关闭按G0确定的上游时限执行，但必须可取消观察并保留unknown结果，不能由取消按钮假装副作用撤销。

## 6. 已有门禁与新增脚本

以下现有命令必须通过；出现环境缺依赖或网络失败时记录实际失败，不能打勾：

```sh
./scripts/workspace-verify full
pnpm test:desktop
pnpm test:terminal
pnpm test:onboarding
pnpm test:delegation
pnpm test:scene-sync
pnpm test:settled-watchdog
pnpm test:agent-hooks
pnpm test:methods
pnpm test:task-pool
pnpm test:external-wait
pnpm test:coordinator
pnpm desktop:dist
pnpm test:installers
```

成员外的工作区门禁：从 `gd-workspace` 执行 `./bin/gdw verify --member agent-ship-kit --mode fast`；若开发在独立 worktree，还要在那里执行成员门禁，不能误把原仓通过当作新worktree通过。

本版新增并已在 package scripts 注册：

- `pnpm test:session-contract`：两个Adapter同一contract suite + parser fixtures。
- `pnpm test:backend-switch`：故障注入、锁、epoch、消息去重、多工作区事务。
- `pnpm test:orca`：隔离真实Orca、shell/身份/聚焦/生命周期，无模型与真实模型证据分别输出。
- `pnpm test:backend-e2e`：打包应用双向切换，包含至少一轮真实模型执行。

CI跑纯contract、core和故障注入；需要图形登录/已认证Agent的试验在受控本机/测试机执行并附证据，不能往CI注入个人凭据。真实GUI试用失败时不能只用fixture把整版标绿。

## 7. Release与签收

交付签收表至少包括：INV、DATA、API、SW、E2E、PERF、UX、PRIV各项结果；未通过项写原因、用户影响和阻塞等级。G0、互斥、身份、无重复投递、数据保留、任一完整后端链路失败均阻塞发布。

实际发布前按当次授权处理PR与Release；公开下载后使用公开Assets重新验收：

1. DMG/ZIP 的 SHA-256、quarantine、严格代码签名与安装启动。
2. 正确版本、内置CLI、Skills与Herdr插件版本；CLI真实写入同一目标库。
3. 新安装默认Herdr，升级保留原目标；设置选择Orca后重启仍是Orca。
4. 公共下载包完成两方向切换与一次真实任务，不使用源码dev server代替。
5. 无开发依赖的另一台Mac验证安装路径、Orca连接/安装引导、窗口复用和恢复。

证据齐备后发布说明只能宣称实测通过的Agent、Orca版本和恢复方式。没有原生恢复证据就写“根据目标记录继续”；没有Developer ID/公证就明确签名实际情况。

## 8. 实际验收记录

开发基线 `ddf9cc268150e9b1c449449d42e7700587a7cc38`；待发布版本
`0.11.0`；本机 macOS Apple Silicon。测试只使用独立工作区、测试 HOME、
私有控制目录和命名 Session。下表区分 fixture、真实后端、真实模型与公开包，
没有把所有规格条目一律标为通过。

| 范围 | 方式与结果 | 证据 |
| --- | --- | --- |
| 数据、身份、幂等、切换故障 | core / sessions / desktop 自动测试，含旧 epoch、响应丢失、恢复屏障、未知结果不重放 | `/tmp/crewvane-v011-full-release.log`；最终检查结果随 PR |
| Codex / Claude Code / Cursor / Qoder 配置 | 隔离 HOME fixture；原有与后来增加的第三方 Hook、matcher、空分组、设置均保留；重复安装、更新、停用与卸载通过 | `apps/desktop/test/agent-hook-manager.test.ts` |
| OMP 扩展保护 | 隔离 HOME fixture；其他扩展、同名用户文件与后文含 marker 的用户文件均保留 | 同上 |
| Hook 配置写入故障 | 并发 manager 串行，损坏/未来格式/符号链接停止写入；无受管条目的卸载逐字节 no-op | 同上 |
| 真实 Herdr 0.9.5 | alias、中文 argv/cwd、42,001 字节单次投递、幂等创建、精确聚焦与停止通过 | `/private/tmp/cv-hc-6q6Ly3/manifest.json` |
| 真实 Orca 1.4.258 | alias、中文路径、1,044 项 PATH、48,001 字节单次投递、20 次聚焦、停止通过 | `/private/var/folders/rn/g5lv0lln5xs50nhkrc2w0lyr0000gn/T/cv-orca-contract-ZCJWxB/manifest.json` |
| OMP 多行案卷 | 真实 OMP 18.15：120 行且小于 12 KB 的案卷经私有文件完整交付，唯一工件校验通过 | `/private/tmp/cv-omp-transport-lGKEl5` |
| 案卷隔离回归 | 管家仍在上一回合时不发布下一 scope；忙碌超时不改案卷；等待期间新增决定或结束目标不会派发 | `apps/desktop/test/backend-handoff-case.test.ts` |
| 受限 Agent 的启动通道 | 真实 CLI 在禁止执行 `/bin/ps` 的 macOS 隔离策略下通过桌面 Host 启动；旧 attempt/epoch/角色/跨目标与切换期请求均拒绝；重启后发现新端点 | `apps/desktop/test/session-command-host.test.ts` |
| 完整双向交接 | 打包应用 + 真实 OMP：管家创建两个独立负责人，Herdr → Orca → Herdr 后两个工件均严格为 `[1,2,3]`；原注意力 ID 保留；显式恢复咨询现场只聚焦同一绑定；现场答复经管家解决后迟到回执被拒；结束目标关闭对应现场 | `/private/tmp/cv-backend-e2e-Dkt3lK/manifest.json` |
| 自然语言现场答复 | 真实 OMP：只向负责人发送人的普通原话，不由脚本代写状态；负责人保存 scene-reply，管家写决定账本，原注意力消失且负责人现场复用 | `/private/tmp/cv-scene-nURfAs/verified-state.json` |
| 测试资源回收 | 完整交接退出后测试进程为零；项目删除后重查；清理器保留进程出生身份，覆盖子进程被系统接管和 PID 复用，并保护用户 Orca 与调用者 | `scripts/lib/backend-trial-cleanup.mjs`；`apps/desktop/test/backend-trial-cleanup.test.ts` |
| 管家复用状态 | 回归先复现已初始化管家被留在 `not_ready`，再验证复用恢复就绪、保留 presence，且不新建现场、不重复发身份 Prompt | `packages/sessions/test/runtime.test.ts` |
| 最终本地门禁 | CLI 59、Core 149、Sessions 68、Desktop 184，合计 460 项通过；类型检查与桌面构建通过 | `/tmp/crewvane-v011-final-gate.log` |
| 最终安装与首次启动 | 最终包通过首次启动、自定义 CLI 与管家重启复用；ZIP / DMG 的 SHA-256、quarantine 后严格签名、安装启动与包内 CLI 的 v4 真实写入通过 | `/tmp/crewvane-v011-onboarding-final-check.log`；`/tmp/crewvane-v011-installers-final.log` |

真实 Codex Hook 验收在临时 HOME 中先断言安装为 `waiting-trust`，随后由测试者
显式配置一次性的 `--dangerously-bypass-hook-trust` 运行已审核的隔离 Hook。
这不是用户启动命令的隐式参数；产品不添加此选项，用户仍需在 Codex `/hooks`
中审核。真实模型测试与普通 Agent fixture 结果分别记录，未安装的 Claude Code、
Cursor、Qoder 不宣称本机模型实测通过。

### 已知验收限制

- 没有第二台无开发依赖 Mac；无法声称跨机器的首次授权、窗口复用和 Orca 安装
  已通过。发布时保留此项限制，不用本机隔离 HOME 冒充第二台设备。
- 未验证 Orca 原生 Agent 会话 resume、远程 host、全量快捷键与终端历史迁移。
- 没有执行两模式各 10 分钟的长期空载 CPU / RSS 与 `v0.10.0` 对照；
  单元测试验证轮询批次预算与失败退避，桌面试验只报告实测交互延迟。
- 当前包只有完整 ad-hoc 签名，没有 Apple Developer ID 与公证。quarantine
  验收验证签名完整性和启动能力，不代表第二台 Mac 无需首次系统授权。
