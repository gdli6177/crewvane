# Crewvane 自主目标规格

日期：2026-11-12
状态：已定稿，作为 Crewvane 0.9 的实现与验收基线。
适用范围：Crewvane 0.9 及后续版本。

Crewvane 0.8 已具备持久管家、协调收件箱、Agent Runtime Hooks、场景优先和
项目上线策略；本文在这些能力上增加自主目标闭环。新的续跑、自动验收和发布
权限只有在 v3 迁移、命令门禁和桌面验收都成立后才授予；不满足时继续沿用旧边界。

## 1. 结论

Crewvane 的核心承诺从“把所有事整理成清晰的下一步”推进为：

> 人交代目标和边界，Crewvane 持续推进、验证和恢复；只有需要改变委托边界、
> 批准生产发布，或核对发布后的真实结果时，才回来找人。

“自动验收”“自动合并”“自动发布”是三个独立权限，不能互相推导：

- 开发交付可在验收授权内自动完成。
- 合并遵守项目上线策略。
- 每次面向真实用户的生产发布都必须由人单独确认。

### 1.1 已确认的访谈决定

| 决定 | 结论 |
| --- | --- |
| 最终验收权 | 可以事先委托给系统，但人始终保留最终裁决权 |
| 授权复用 | 按项目复用，同时支持目标和全局覆盖 |
| 初始设置 | 首次使用时选择默认验收方式，不逐项目重复询问 |
| 完成与发布 | 交付完成不等于上线；生产发布是独立目标，每次由人批准，执行后仍由人确认结果 |
| 模糊需求 | 先自主调研、给出证据和选项，再由人确定方向 |
| 完成条件 | Agent 可补全验证方法；结果取舍必须有人或项目规则依据 |
| 边界变更 | 技术选择自主；结果或外部影响变化必须申请 |
| 重试收敛 | 没有新证据就停止自动尝试并整理交接 |
| 续跑 | 由 Crewvane 的持久事件驱动，不靠 Agent 长期驻留 |

这里的“委托”指人允许系统在明确边界内完成日常验收，而不是把责任转移给
模型。任何时候，人都可以查看证据、暂停授权、改为人工验收、要求重新复核或
重新打开目标；涉及真实用户的生产发布仍必须由人逐次批准。

### 1.2 完成不是上线

“完成”必须按层次判断，不能用代码已经写好、Agent 自称完成或代码已经合入主分支
代替上线确认：

| 层次 | 判断标准 | 是否可自动 |
| --- | --- | --- |
| 目标完成 | 委托摘要范围内的工作满足完成条件，证据与独立复核达到门禁 | 可在事先授权内自动验收 |
| 代码合并 | 候选通过检查，并符合项目上线策略和 `releaseOnMerge` 约束 | 按既有项目策略，不因自动验收自动放宽 |
| 生产发布批准 | 人针对精确环境、候选修订和摘要批准本次发布 | 必须由人逐次批准 |
| 发布后最终确认 | 人核对真实环境、候选版本和实际结果，确认发布目标完成 | 必须由人确认 |

因此，一个交付目标可以自动完成，但这只表示“目标边界内已交付”，不表示已经
合并或已经面向真实用户上线。任何触达真实用户的生产发布，都不能把自动验收当作
上线许可；发布执行前必须有一次针对该候选的人批准，执行后还必须有一次结果确认。

## 2. 目标与衡量

### 2.1 产品目标

1. 对边界明确的目标，人只需交代、决定真正的取舍、批准生产发布和查看结果。
2. Agent 的失败、等待、返工和交接形成可恢复闭环，不因会话结束而丢失。
3. 自动完成建立在真实证据和独立复核上，而不是 Agent 自称完成。
4. 人在任何时候都可以暂停自主推进、要求人工验收、打开现场和重新接手。
5. 外部 Bot 可以接入同一目标协议，但不能建立第二份事实源，也不能代替人批准发布。

### 2.2 衡量方式

试点至少记录以下指标，不使用“运行了多少次”作为成功标准：

- 每个已完成目标的真人介入次数与人工耗时。
- 自动验收比例、自动验收后的重新打开或返工比例。
- 因证据不足、重复失败、边界变更和发布审批而交回人的次数。
- 从交代到交付、从批准到发布完成的时间。
- 同一错误重复发生、超出租约或触发旧回执被拒绝的次数。

目标值在试点前由人设置，不把尚未验证的百分比写成产品承诺。

## 3. 非目标与硬约束

以下约束优先于效率和自动化程度：

- 不自动批准生产发布。
- 不自动执行九类高风险动作，除非人已针对当前动作明确批准。
- 不自动修改使用方规则、owner 文件、现有 hook 或项目上线策略。
- 不自动合并、部署、发送外部通知或激活经验；这些动作仍由明确协议和责任人执行。
- 不根据终端空闲、`idle`、`done`、屏幕文字或自然语言中的“可以”“完成”推断验收。
- 不读取凭据、登录状态或外部手册，不把密钥写入工作区状态。
- 不提供无限重试、常驻 Agent 内循环或通用 cron 调度器。
- 不把“人保留最终裁决权”解释为每个目标都要经过同步人工确认。
- 不把 Crewvane 的应用层校验宣称为操作系统沙箱。

### 3.1 信任边界

本规格的权限约束面向遵守协议的 Agent、Bot 和适配器，属于应用层治理，不是
密码学认证或操作系统隔离。与 Crewvane 共用本机账户、且能直接修改状态文件或
调用生产凭据的恶意程序，仍可绕过 CLI。

因此：

- 自动验收记录必须标明来源，不能冒充人的操作。
- 生产发布凭据应只授予发布执行器，不应交给普通开发 Agent。
- 需要对抗恶意本机 Agent 时，必须引入独立 OS 用户、权限隔离或远程审批服务；
  这不在本规格的首期范围。

## 4. 领域模型

### 4.1 新增或收紧的术语

**委托摘要 / Goal brief**：
从人的原话、项目规则和必要调查得到的结构化边界，包含结果、范围、完成条件、
外部影响、验证方式和尝试预算；它是 Agent 的执行依据，不是新的冻结合同。

**交付目标 / Delivery goal**：
以形成可验收成果为目标的目标；完成不代表已经面向真实用户发布。

**探索目标 / Discovery goal**：
为尚未明确的需求收集证据、提出候选方向和取舍建议的目标；交付不代替人确定方向。

**发布目标 / Release goal**：
将具体候选版本面向真实用户启用的独立目标；必须绑定明确环境、候选版本和人的发布批准。

**完成条件 / Acceptance criteria**：
判断目标自身边界内工作是否达到要求的可核对条件；涉及结果取舍的条件必须有人的
原话或项目规则作为依据。

**独立复核 / Independent verification**：
由未提交该交付的执行者，逐项核对完成条件与真实证据的活动；它不是执行者的自检。

**自动验收 / Automatic acceptance**：
系统在人的事先授权范围内，根据完成条件、真实证据和独立复核确认目标完成的验收方式。

**验收记录 / Acceptance record**：
记录人工或自动验收、时间、授权修订号、复核记录和依据的事实；不属于项目决定账本。

**边界变更 / Boundary change**：
改变目标结果、完成条件或外部影响范围的申请；提交申请不等于获得批准。

**续跑 / Continuation**：
Crewvane 在 Agent 会话之外持久保存、到期后唤醒下一个短回合的触发记录。

**尝试预算 / Attempt budget**：
人允许系统自主恢复目标的有限资源；预算只约束自动恢复，不限制目标本身的正常阶段。

**租约 / Lease**：
一次续跑被某个 Crewvane 进程临时领取的有效期；租约过期后可由新进程安全接手。

### 4.2 目标种类

`Goal.kind` 取值：

- `delivery`：默认类型，产出可验收成果。
- `discovery`：探索尚不明确的需求，输出证据和选项。
- `release`：把一个或多个交付目标的具体候选版本发布到指定环境。

`Goal.mode` 继续表示由管家统筹还是人工记录，与 `kind` 正交。

### 4.3 生命周期

继续使用 `active | waiting | review | completed | dropped`：

| 状态 | 自主目标中的含义 |
| --- | --- |
| `active` | 可以推进，或有待处理决定、边界变更或发布审批 |
| `waiting` | 等待外部对象或未来时间；到点后由续跑唤醒 |
| `review` | 已提交交付，正在独立复核或等待人工验收 |
| `completed` | 目标边界内已完成，不表示已发布 |
| `dropped` | 人明确放弃 |

自动推进的运行状态单独放在 `goal.autonomy`，不得新增第二套与 `status` 冲突的目标状态。

## 5. 目标定界

### 5.1 定界来源

目标边界来自三层，优先级从高到低：

1. 人的原话、后续消息和明确决定。
2. 项目已有的说明、规则和既定兼容要求。
3. Agent 的调查、复现和验证方法。

Agent 可以补全“怎样证明做对了”，不能发明“牺牲什么换取什么”。

### 5.2 委托摘要

管家或负责人必须在执行前提交 `GoalBrief`。没有有效摘要的目标不得自动验收。

```ts
interface GoalBrief {
  revision: number;
  outcome: string;
  inScope: string[];
  outOfScope: string[];
  criteria: AcceptanceCriterion[];
  constraints: string[];
  externalEffects: string[];
  verificationPlan: {
    requiredEvidenceKinds: ("command" | "artifact" | "url" | "attachment" | "inspection")[];
    independentReviewer: true;
  };
  attemptBudget: {
    maxRecoveryAttempts: number;
  };
  source: {
    activityIds: string[];
    ruleRefs: string[];
  };
  setBy: string;
  setAt: string;
}

interface AcceptanceCriterion {
  id: string;
  statement: string;
  required: boolean;
  provenance:
    | { kind: "user-message"; activityId: string }
    | { kind: "project-rule"; ref: string }
    | { kind: "verification-method"; rationale: string };
}
```

约束：

- `user-message` 必须指向当前目标真实存在的活动。
- `project-rule` 只记录引用和摘要，不复制或改写使用方规则。
- `verification-method` 只能补全检查方式，不能包装结果取舍。
- 结果、完成条件或外部影响的实质变化必须走边界变更。
- 修订摘要时使用 `expectedRevision` 防止覆盖并发更新。

### 5.3 需求入口

管家先判断目标属于明确实现还是探索：

1. **明确需求**：形成 `delivery` 目标，补全摘要，在授权内推进。
2. **结果取舍不清**：转为 `discovery`，调查、复现或比较方案。
3. **方向不清**：先探索，再由人确定方向，之后建立新的交付目标。
4. **发布风险不清**：默认按需要人工发布处理，不假设可自动上线。

探索目标可以自动完成“证据充分、选项完整”的交付，但不能自动据此批准产品方向。

### 5.4 何时需要人

只有满足以下任一条件时才进入决定注意力：

- 必须改变结果、完成条件或外部影响范围。
- 存在没有人的原话或项目规则依据的结果取舍。
- 需要批准生产发布。
- 自动恢复预算耗尽，或同一失败没有新证据。
- 独立复核无法完成，或现有证据互相矛盾。

技术栈、文件布局、算法选择、测试补充、代码重构等执行选择不占用人的决定。

## 6. 验收授权

### 6.1 授权层级

验收方式只有两种：

- `human-review`：人工验收。
- `auto-with-verification`：必须独立复核通过的自动验收。

`auto-with-verification` 不允许退化成“执行者自检后自动通过”。

解析优先级：

```text
目标覆盖 > 项目设置 > 工作区默认
```

只有人可以创建、修改或扩大授权。受管 Agent 和外部 Bot 只能读取生效策略和提出建议。

### 6.2 首次设置

首次使用自主目标时，桌面要求人选择工作区默认验收方式：

- 推荐选项：`auto-with-verification`。
- 保守选项：`human-review`。

跳过或关闭设置时使用 `human-review`，不得静默开启自动验收。设置可随项目细化，
但不需要在每个项目首次交付时重复询问。

### 6.3 暂停与覆盖

人可以在工作区、项目或目标层：

- 暂停新的续跑。
- 把自动验收改为人工验收。
- 恢复自动推进。
- 调整尝试预算。

暂停只阻止下一次续跑，不强杀当前 Agent 回合。需要立即停止时，沿用现有现场终止
或人工接管能力。策略在交付提交时解析，并在真正自动验收前重新检查；期间任何
人工覆盖、暂停或边界变更都会阻止自动通过。

## 7. 自主推进闭环

### 7.1 结构

```text
目标与委托摘要
      │
      ▼
管家安排负责人 ──► 负责人执行一个短回合
      ▲                    │
      │                    ├─ checkpoint：还有下一动作
      │                    ├─ wait：等待外部对象或时间
      │                    ├─ boundary：请求改变边界
      │                    └─ delivery：提交成果与证据
      │
      └──── Crewvane 持久续跑 ◄──── 到期 / 复核失败 / 决定完成
                                   │
                                   ├─ 自动复核通过 ─► 自动验收
                                   └─ 无新证据/超预算 ─► 整理交接
```

续跑属于 Crewvane 控制面，不属于某个 Agent 的长期进程。管家继续使用现有案卷隔离：
一次通知只带一个目标，处理、分发或写回后结束当前回合。

### 7.2 触发来源

允许产生续跑的事实：

- 负责人提交 `checkpoint`，声明仍有下一动作。
- 交付已提交，需要独立复核。
- 独立复核失败，且仍有尝试预算。
- 等待对象解除，或 `remindAt` 到期。
- 人批准边界变更、发布审批或给出其他决定。
- 可信集成报告外部依赖完成。
- Crewvane 启动时发现已到期的持久续跑。

以下事实不产生续跑：

- Herdr `idle`、`done`、`unknown`。
- 普通状态变化、终端输出或模型回复。
- 一次新的巡检，除非巡检确认需要恢复或预算耗尽。
- 已结束、已暂停、正在等待人工决定的目标。

### 7.3 持久记录

```ts
interface Continuation {
  id: string;
  trigger:
    | "checkpoint"
    | "verification"
    | "recovery"
    | "wait-due"
    | "decision-resolved"
    | "dependency";
  status: "scheduled" | "claimed" | "sent" | "settled" | "cancelled" | "failed";
  dueAt: string;
  attempt: number;
  basisRevision: string;
  idempotencyKey: string;
  claimedAt?: string;
  leaseUntil?: string;
  sentAt?: string;
  settledAt?: string;
  lastError?: string;
}
```

每个目标最多保留一条当前续跑。新的有效触发替换旧的未领取记录；历史写入活动记录。

### 7.4 调度与并发

- Electron 主进程负责调度；`packages/core` 只做确定性校验和状态变更。
- 状态文件变化立即触发一次检查，10 秒巡检作为断线补偿。
- 同一工作区同一时间只允许一个管家案卷回合；其他续跑保留在队列中，不丢弃。
- 每目标只允许一个有效租约，默认租约 10 分钟，可由实现配置。
- 领取时核对 `basisRevision`、目标状态、暂停状态和人工接管状态。
- 发送使用稳定 `idempotencyKey`；旧租约回执在目标已更新、暂停或接管后必须丢弃。
- 崩溃后租约到期可重领；重领前重新读取最新目标，不重放旧快照。
- 应用未运行时不启动隐藏守护进程。到期记录保留，下次启动合并为一次最新续跑，
  不补发历史积压消息。

### 7.5 回合协议

负责人每回合结束前必须选择明确事实：

- `checkpoint`：仍有下一动作，并给出下一步和可选时间。
- `wait`：等待外部对象或时间。
- `boundary`：需要改变边界。
- `delivery`：当前成果可供复核。
- `blocked`：当前无法继续，附带失败证据。

只发送“收到”“继续处理中”而不产生下一动作，不构成 checkpoint，也不会触发无限续跑。

## 8. 收敛与停止

### 8.1 尝试预算

- 默认 `maxRecoveryAttempts = 3`，沿用现有三轮审查上限。
- 正常阶段推进不消耗恢复次数；只有同一失败再次出现、复核退回或恢复动作失败才计数。
- 默认不设置硬性总时长；人可以为目标增加最长运行时间。
- 人可降低或提高预算，但不能由 Agent 自动增加。

### 8.2 新证据要求

每次恢复必须至少带来一项新事实：

- 新复现或检查结果。
- 新假设及可证伪的验证。
- 新的实现版本、工件或依赖状态。
- 已排除的路径和原因。

以下情况视为“没有新证据”：

- 重复同一失败摘要。
- 换措辞但没有新命令、工件或观察。
- 重跑相同检查得到相同结果。
- 再次声称“已完成”但没有交付版本变化。

失败指纹至少包含失败检查、错误类别、候选版本和失败阶段。指纹未变化时不得
把新一轮执行写成实质进展。

### 8.3 立即停止条件

- 同一失败指纹连续出现且没有新证据。
- 恢复次数达到预算。
- 人暂停自主推进或要求人工接手。
- 需要边界变更。
- 独立复核判定失败且预算耗尽。
- 审查轮次达到上限。
- 关键依赖不可达且无授权内的替代路径。
- 涉及未批准的高风险动作或生产发布。

### 8.4 交接内容

停止后形成一条 `intervention` 注意力，并在目标活动中留下可恢复的交接：

1. 已完成的工作和当前可访问成果。
2. 失败证据、实际命令或观察结果。
3. 已尝试路径和已排除假设。
4. 需要改变的最小边界。
5. 可执行选项、代价、风险和推荐方案。

不使用“卡住了，请看一下”作为交接摘要。

## 9. 边界变更

### 9.1 判定

以下变化属于边界变更：

- 改变结果或完成条件。
- 扩大或缩小承诺范围。
- 改变登录、认证、数据语义等用户可感知行为。
- 迁移、删除或对外发送数据。
- 增加费用、权限、凭据或新的外部服务。
- 把局部修复扩大为架构替换。
- 改变发布环境或候选版本。

以下变化不属于边界变更：

- 选择实现模式、文件拆分或内部接口。
- 补测试、补日志、补错误处理。
- 在已授权范围内调整执行顺序。
- 依据既有规则消除不影响结果的重复代码。

### 9.2 协议

```ts
interface BoundaryChange {
  id: string;
  reason: string;
  proposedOutcome?: string;
  proposedCriteria?: AcceptanceCriterion[];
  proposedExternalEffects?: string[];
  evidence: string[];
  alternatives: string[];
  recommendation: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt?: string;
}
```

提出后：

1. 暂停受影响目标的续跑。
2. 放下只读调查、分析和新方案草稿。
3. 以 `decision` 注意力请人批准或拒绝。
4. 批准后增加摘要修订号、重置本次恢复计数、保留既有成果并续跑。
5. 拒绝后不自动寻找“绕过拒绝”的替代实现；按人的新指示或结束目标处理。

边界变更决定绑定当前目标和摘要修订号，不作为其他目标的通用批准复用。

## 10. 证据与独立复核

### 10.1 交付记录

`Delivery` 在现有字段上增加候选版本、证据和稳定 ID：

```ts
interface Delivery {
  id: string;
  summary: string;
  location?: string;
  url?: string;
  candidate?: {
    revision: string;
    digest?: string;
    version?: string;
  };
  checks: DeliveryCheck[];
  evidence: Evidence[];
  submittedAt: string;
  submittedBy: string;
}

interface Evidence {
  id: string;
  kind: "command" | "artifact" | "url" | "attachment" | "inspection";
  label: string;
  result: "observed" | "passed" | "failed";
  observedAt: string;
  command?: string;
  location?: string;
  sourceRevision?: string;
  sha256?: string;
  note?: string;
}
```

要求：

- 至少一项完成条件，至少一项真实检查或观察。
- 检查必须对应实际命令、操作或可见工件，并能定位到候选版本。
- 失败检查不得被摘要掩盖；修复后产生新的候选版本或新的证据。
- 核心校验结构、版本和引用完整性，不宣称自己证明了外部事实。

### 10.2 独立复核

```ts
interface Verification {
  id: string;
  deliveryId: string;
  outcome: "passed" | "failed";
  summary: string;
  criteria: Array<{
    criterionId: string;
    result: "passed" | "failed";
    evidenceIds: string[];
    note?: string;
  }>;
  reviewer: string;
  reviewerHerdr?: HerdrReference;
  verifiedAt: string;
}
```

核心要求：

- 复核人不得等于 `delivery.submittedBy` 或目标当前负责人。
- 复核站点不得复用交付执行者的 Pane；无法确认时标记为协议风险。
- 所有必选完成条件都有结论。
- 总体通过时，不允许任何必选条件失败。
- 复核绑定 `deliveryId` 和候选版本；新的交付使旧复核失效。

独立复核属于应用层协议。人和桌面必须能看到复核人、站点、条件和证据；不能把
“另一个同名 Agent”自动视为独立性已得到密码学证明。

由 Crewvane 启动的复核进程只获得当前目标范围内的精简 `status`、`goal show` 和
`goal verify`。它不能更新其他目标、提交交付、调用验收或发布命令，也不能用
`--reviewer` 冒用另一身份；复核署名来自启动时登记且不能被普通参数覆盖的
`CREWVANE_AGENT_NAME`。该限制用于避免协议误用，不冒充操作系统身份认证。

### 10.3 审查轮次

- 每次提交交付计入一轮审查。
- 默认最多三轮；达到上限后进入人工介入，Agent 不得自行提高。
- 自动复核失败可在预算内返工，但不得跳过审查上限。
- 复核通过后仍需满足自动验收门禁，复核本身不等于验收。

## 11. 自动验收

### 11.1 门禁

系统只有在以下条件全部成立时才可自动完成目标：

1. 验收方式解析为 `auto-with-verification`。
2. 目标未被暂停，没有未解决的边界变更或人工决定。
3. 委托摘要有效，完成条件有来源，结果取舍有依据。
4. 交付与证据完整，检查通过，候选版本明确。
5. 独立复核通过并覆盖全部必选条件。
6. 复核人、负责人和交付提交者满足独立性要求。
7. 审查轮次未超限。
8. 当前状态未发生人工接管、新的交付或摘要修订。
9. 若目标为发布目标，人的发布批准仍有效且绑定同一候选版本；执行结果仍须回到
   人作最后确认。

任一条件不成立时，不得自动验收；根据原因进入人工验收、返工、决定或介入。

### 11.2 验收记录

```ts
interface AcceptanceRecord {
  id: string;
  kind: "automatic" | "human";
  at: string;
  by: string;
  mandateRevision: number;
  verificationId?: string;
  note?: string;
}
```

约束：

- 自动验收记录不能伪装成人的原话或批准。
- 验收记录与项目决定账本分开保存；验收不是上线批准。
- 目标完成后保留交付、复核、证据和验收记录。
- 默认不产生“请验收”注意力；只产生可订阅的完成状态事件。

### 11.3 人的最终裁决

人始终可以：

- 查看所有自动验收的成果与证据。
- 暂停或永久关闭自动验收。
- 把某个目标改为人工验收。
- 重新打开自动完成的目标，附带原因并恢复推进。
- 要求新的独立复核。

重新打开保留原验收记录，不删除历史。若发布已经发生，重新打开只修复目标记录和
后续工作，不能宣称已撤销外部发布。

## 12. 发布

### 12.1 独立发布目标

发布目标必须包含：

```ts
interface ReleaseTarget {
  sourceGoalIds: string[];
  environment: string;
  candidate: {
    revision: string;
    digest?: string;
    version?: string;
  };
  status:
    | "drafting"
    | "awaiting-authorization"
    | "authorized"
    | "executing"
    | "verifying"
    | "succeeded"
    | "failed"
    | "cancelled";
  authorization?: {
    id: string;
    approvedAt: string;
    approvedBy: "你";
    candidateRevision: string;
    candidateDigest?: string;
    note: string;
  };
  result?: {
    outcome: "succeeded" | "failed";
    evidence: string[];
    reportedAt: string;
  };
}
```

生产发布目标不能继承交付目标的自动验收结果作为发布许可。

### 12.2 每次发布由人批准

- 每个发布目标单独审批，不写入可跨目标复用的批准账本。
- 批准必须绑定环境、候选修订和可选摘要。
- 候选变化、重新构建或新提交会使批准失效。
- 长期项目策略、历史批准或交付自动验收都不能代替该次批准。
- 发布执行器报告真实结果；Crewvane 不伪造执行，也不自行回滚。
- 发布失败进入 `intervention`，附带环境、候选、失败证据和可选恢复方案。
- 执行器报告成功后，目标进入最终人工确认；只有人核对环境、候选和真实结果后才
  记为完成。发布批准是执行许可，不替代对实际结果的最后验收。

### 12.3 合并与发布耦合

项目可声明：

```ts
type ReleaseOnMerge = "never" | "production" | "unknown";
```

- `never`：合并不会触发生产发布。
- `production`：合并会触发生产发布。
- `unknown`：尚未确认。

对新自主目标：

- `releaseOnMerge=production` 时，合并前必须存在有效发布批准，且候选可被精确绑定。
- `releaseOnMerge=unknown` 时，不得自动执行可能触发生产发布的合并。
- 无法在合并前确定最终发布候选时，系统暂停自动合并，交由人处理。
- 普通非自主目标继续遵守现有上线策略，不因本规格静默改变。

## 13. 注意力与界面

### 13.1 进入注意力

自动推进期间只在这些情况进入注意力：

- 需要批准或拒绝边界变更。
- 自动复核失败且无法在预算内继续。
- 尝试预算或审查上限耗尽。
- 需要批准生产发布。
- 发布执行成功，等待人核对环境、候选和真实结果并作最终确认。
- 关键证据矛盾或现场不可达。
- 目标被暂停但存在未完成的外部影响。

正常进展、成功续跑和自动验收不进入“需要你处理”。

### 13.2 目标详情

必须展示：

- 目标种类、当前状态和是否处于自主推进。
- 委托摘要及修订记录。
- 生效的验收方式、来源和人工覆盖。
- 下一次续跑的时间、原因和尝试次数。
- 交付、证据、独立复核和验收记录。
- 发布候选、批准状态及批准失效原因。
- 暂停、恢复、转为人工、重新打开和打开现场入口。

### 13.3 设置

增加“自主目标”设置：

- 工作区默认验收方式。
- 全局暂停开关。
- 默认恢复次数。
- 无进展检测时间。
- 项目 `releaseOnMerge` 声明。
- 各项目的验收覆盖。

设置只能由人修改。恢复默认值时使用保守设置，不继承最高风险的旧授权。

## 14. 协议与数据

### 14.1 新增命令

Agent 协议：

```text
crewvane goal brief ID --file PATH [--expected-revision N]
crewvane goal checkpoint ID --summary TEXT --next TEXT [--due-at ISO]
crewvane goal verify ID --delivery ID --outcome passed|failed
  --summary TEXT --criterion ID::passed|failed::EVIDENCE_ID [--criteria-file PATH]
crewvane goal boundary ID --file PATH
```

人用协议：

```text
crewvane goal autonomy pause ID
crewvane goal autonomy resume ID
crewvane goal autonomy acceptance ID
  --acceptance inherit|human-review|auto-with-verification
crewvane goal reopen ID --note TEXT
crewvane release create --from GOAL_ID --environment production
  --revision REV [--digest SHA256] [--version VERSION]
crewvane release approve ID --note TEXT
crewvane release reject ID --note TEXT
crewvane release result ID --outcome succeeded|failed --evidence-file PATH
```

兼容命令：

- `goal review` 继续提交交付；增加可选 `--candidate-revision` 和
  `--evidence-file`，自主目标在此后调度独立复核。
- `goal accept` 继续表示人工验收。
- `goal create --kind delivery|discovery` 在建立目标时分类；
  `goal kind ID --kind delivery|discovery` 由管家在明确事实变化后切换。`release`
  只能通过 `release create` 建立，不能由普通类型切换产生。
- `goal autonomy acceptance` 只由人调用，写入当前目标覆盖；`inherit` 删除目标层覆盖。
- `goal complete` 对自主目标只接受人的可信入口；进入 `review` 的成果不能绕过验收。
- `goal risk`、`goal ship` 和上线策略判断保持独立，不因自动验收放宽。
- `goal message`、`direct` 仍只追加人的原话。

所有写命令带 `requestId`，服务端按目标修订号拒绝过期写回。人类操作不会因为
`actor` 字符串被自动信任。

### 14.2 人机命令隔离

桌面 IPC 和可信注意力界面是人用入口。受管 Agent、Bot 和第三方插件不得调用：

```text
goal.accept
goal.reopen
goal.autonomy.*
release.approve
release.reject
project.policy.set
workspace.autonomy.set
```

CLI 进程本身不能可靠证明调用者是人。实现必须：

- 明确区分人用界面与 Agent 协议，不靠 `actor` 原文授权。
- 依赖 Electron 主进程的受约束 IPC 或受信任人用界面提交上述命令。
- 继续声明这是应用层约束，不是操作系统身份认证。
- 装饰性命令或环境变量不能替代来源校验；`actor` 只用于审计署名。

受管负责人和独立复核者仍共享操作系统账户，因此 CLI 按角色和目标环境变量做
最小权限约束：负责人不能冒用其他复核人，复核者只能读取当前目标并写复核结果。
这些约束是明确的协议边界，不是操作系统沙箱或密码学身份证明。

本地 Bot 首期只通过独立的 `crewvane bot` 子协议接入，不继承人的 CLI 能力。
即使 Bot 与桌面登录同一操作系统账户，它也只能执行绑定中列出的操作。

### 14.3 状态版本

`WorkspaceState.version = 3`，新增：

- `workspace.autonomy`
- `project.autonomy` / `project.releaseOnMerge`
- `goal.kind`
- `goal.brief`
- `goal.autonomy`
- `goal.delivery`
- `goal.release`

核心类型：

```ts
type AcceptanceMode = "human-review" | "auto-with-verification";

interface WorkspaceAutonomy {
  acceptance: AcceptanceMode;
  initializedAt?: string;
  paused: boolean;
  maxRecoveryAttempts: number;
  noProgressMinutes: number;
  revision: number;
  updatedAt: string;
}

interface ProjectAutonomy {
  acceptance: "inherit" | AcceptanceMode;
  releaseOnMerge: ReleaseOnMerge;
  revision: number;
  updatedAt: string;
}

interface GoalAutonomy {
  override?: AcceptanceMode;
  paused?: boolean;
  attempts: {
    used: number;
    limit: number;
    failureFingerprint?: string;
  };
  continuation?: Continuation;
  lastVerification?: Verification;
  acceptance?: AcceptanceRecord;
  boundaryChange?: BoundaryChange;
}
```

从 2 迁移到 3：

1. 写入前备份原状态为 `.crewvane/state.v2.backup.json`。
2. 现有目标默认 `kind = "delivery"`，不自动开启自主推进。
3. 工作区默认验收方式为 `human-review`。
4. `releaseOnMerge = "unknown"`。
5. 不把旧目标批量转为自动验收；用户明确选择的项目或目标才启用。
6. 迁移失败保留原文件并只读打开，不猜测或丢弃目标。

### 14.4 内部调度命令

```ts
autonomy.inspect { at }
autonomy.claim { goalId, continuationId, at }
autonomy.report {
  goalId,
  continuationId,
  outcome: "sent" | "failed" | "settled",
  detail?
}
```

- `inspect` 只返回候选，不修改目标。
- `claim` 在锁内验证状态、修订号和租约。
- `report` 只接受当前有效租约的匹配回执。
- 调度器不直接写 `state.json`。

## 15. Bot 接入

### 15.1 原则

- Crewvane 是目标状态的唯一事实源，Bot 不维护第二份任务数据库。
- Bot 的长期记忆和聊天上下文归 Bot；目标、边界、证据、续跑和验收归 Crewvane。
- Bot 可以发起、执行和查询受权范围内的目标，但不能代替人批准发布或决定边界。
- Bot 的自主执行仍受完成条件、独立复核、尝试预算和注意力规则约束。

### 15.2 Bot 绑定

人在桌面创建 `BotBinding`：

```ts
interface BotBinding {
  id: string;
  name: string;
  role: "initiator" | "executor";
  projectIds: string[];
  operations: Array<
    | "goal.submit"
    | "goal.read"
    | "goal.message"
    | "goal.checkpoint"
    | "goal.boundary"
    | "delivery.submit"
  >;
  expiresAt: string;
  status: "active" | "revoked";
}
```

约束：

- 绑定由人创建、撤销。0.9 的本地发起方不发放独立网络密钥；进入远程连接器
  阶段后，密钥只能存操作系统钥匙串。
- 不把令牌、Cookie 或登录状态写入目标、事件、通知或仓库。
- 外部网络入口必须作为显式 `integration` 适配器启用，默认关闭。
- 0.9 只开放 `initiator`，且只能提交、读取和追加消息；`executor` 仅为后续
  执行方协议预留，当前绑定会被拒绝。
- 首期外部 Bot 不得提交复核、验收、发布批准或策略修改。

### 15.3 协作协议

外部 Bot 使用统一 envelope，而不是另造任务状态：

```json
{
  "schema": "crewvane.bot.v1",
  "requestId": "stable-idempotency-key",
  "operation": "goal.submit",
  "botId": "bot_...",
  "payload": {}
}
```

首期操作：

```text
goal.submit
goal.read
goal.message
goal.checkpoint
goal.boundary
delivery.submit
```

所有操作按 `(botId, requestId)` 幂等，只允许绑定项目内的目标。Bot 接收的事件使用
现有 `crewvane.notification.v1` 或显式连接器，不通过读取工作区文件推断状态。
`delivery.submit` 映射到同一 core 交付事实，不允许 Bot 自行标记验收。

### 15.4 Bot 与验收

- Bot 可作为独立执行者提交交付，但不能复核自己的交付。
- 后续阶段可把经过独立安全评审的 Bot 绑定为其他目标的复核适配器；首期不开放该能力。
- 自动验收始终由 Crewvane core 依据门禁作出，Bot 返回的“通过”只是复核事实。
- 生产发布批准不通过 Bot 协议暴露。

### 15.5 分阶段

1. **本地发起方**：本地 Bot 通过 CLI 或本地 gateway 提交、读取、追加消息。
2. **本地执行方**：可信执行 Bot 领取负责人回合，提交 checkpoint、边界变更和交付。
3. **远程连接器**：显式安装的 integration 适配器提供认证、回调、限流和撤销。

首期规格只要求第 1 阶段；第 2、3 阶段必须有独立的安全评审，不能仅靠 `botId` 字符串授权。
0.9 实现只开放 `goal.submit`、`goal.read` 和 `goal.message`；其余操作是后续阶段
的协议预留，不对本地 Bot 暴露。

## 16. 可观测性与审计

每个目标至少记录：

- 摘要创建、修订和来源。
- 每次续跑的触发、领取、发送、租约过期和结算。
- 每次恢复尝试及新证据。
- 边界变更申请与人的决定。
- 交付版本、证据、复核和验收。
- 项目策略、验收授权和发布批准的有效修订号。

禁止在事件和指标中写入：

- 凭据、Cookie、访问令牌。
- 未脱敏的外部数据。
- 与目标无关的终端全文。

指标只使用聚合计数和耗时；目标正文、附件和外部内容不进入指标标签。

## 17. 测试与验收

### 17.1 Core

- 授权层级解析、首次默认值和人工覆盖。
- 摘要来源校验、并发修订冲突和无效完成条件。
- 自动验收门禁的全部正反分支。
- 复核人独立性、条件覆盖、旧复核失效和审查上限。
- 边界变更暂停、批准恢复、拒绝不绕过。
- 尝试预算、失败指纹、无新证据停止和交接内容。
- 续跑创建、领取、租约、过期、幂等和旧回执丢弃。
- 目标暂停、人工接管、重新打开和结束状态保护。
- 发布候选绑定、批准失效和 `releaseOnMerge` 三态。
- v2 到 v3 迁移、备份、默认保守值和损坏状态拒绝。

### 17.2 CLI

使用真实子进程覆盖：

- `goal brief`、`goal checkpoint`、`goal verify`、`goal boundary`。
- `release create/approve/reject/result` 的人机边界。
- JSON 输出、参数校验、目标作用域和并发冲突。
- 受管 Agent 无法调用验收、重新打开、授权和发布批准。
- 旧版 `review`、`accept`、`ship` 命令的兼容行为。

### 17.3 桌面与 Herdr

- 首次验收设置、项目覆盖、全局暂停。
- 自动验收完成的目标不进入“需要你处理”。
- 预算耗尽、边界变更和发布审批进入正确注意力。
- 打开现场、暂停、恢复、人工验收和重新打开。
- Herdr 事件不会单独触发续跑；只有显式 checkpoint、交付、等待到期和决定完成才触发。
- 应用重启、租约过期、并发窗口和旧回执不会重复派发。

### 17.4 真实试用

至少在隔离工作区和命名 Herdr Session 中完成：

1. 明确缺陷修复目标自动推进，经历一次失败恢复、独立复核和自动验收。
2. 模糊需求先完成探索，不自动确定产品方向。
3. 执行中提出边界变更，批准后从既有成果继续。
4. 同一失败无新证据，到达预算后停止并形成可行动交接。
5. 生产发布每次单独审批；候选变化使批准失效。
6. 自动完成后人重新打开目标，历史与证据保留。
7. 本地 Bot 提交目标并读取状态，不能调用人工验收或发布批准。

## 18. 实施阶段

### 阶段 1：边界与数据

- 状态 v3、迁移、验收设置、委托摘要、目标种类。
- 人工验收继续保持默认，先验证数据与界面。

### 阶段 2：持久续跑与收敛

- 续跑记录、租约、调度、checkpoint、恢复预算和交接。
- 先只续跑人工验收目标，不启用自动验收。

### 阶段 3：证据与自动验收

- 候选版本、证据绑定、独立复核、自动验收门禁和重新打开。
- 默认关闭，由人完成首次设置后逐项目启用。

### 阶段 4：发布目标

- 独立发布目标、精确候选批准、合并发布耦合和结果核实。
- 生产发布始终人工批准。

### 阶段 5：Bot 接入

- 先做本地发起方，再做本地执行方。
- 远程连接器单独立项和威胁建模，不阻塞核心闭环。

## 19. 完成定义

本规格实现的完成条件：

- 人能选择默认验收方式，并在项目或目标上收紧授权。
- 边界明确的目标可在应用运行期间持久续跑，应用重启后安全恢复。
- 自动验收只在委托摘要、证据和独立复核都满足时发生。
- 面向真实用户的生产发布在每次执行前都由人批准，候选变化会使批准失效；执行
  成功后仍由人核对实际结果并作最终确认。
- 重复失败、无新证据和预算耗尽会停止并形成可行动交接。
- 人可随时暂停、人工验收、重新打开和查看完整证据。
- 外部 Bot 使用同一目标协议，不能建立第二份状态或绕过发布审批。
- v2 工作区迁移安全，未明确选择的旧目标不会自动开启自主推进。
