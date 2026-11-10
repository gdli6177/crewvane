# 品牌 UI 原则与原语入口

状态：0.6.6 逐页 UI/UX 复核后的落地说明。视觉基线仍是 `DESIGN.md`，本文只解释
这次为什么这样收敛，以及后续 agent 从哪里改。

## 方向

Crewvane 的品牌不是“更花”，而是“更少打扰、更可核对”。界面只抬升真正需要人的
决定、验收、到期跟进和现场介入；其余推进留在后台。对应的 UI 判断：

1. **先回答状态，再给动作**：页面标题/首句说明“现在需不需要你”，需要时只留一个主 CTA。
2. **层级来自 token**：标题、正文、元信息严格落在 `--fs-title` / `--fs-body` /
   `--fs-caption` 等语义档；正文不用 `--muted`，减少“灰一片”。
3. **状态是第二信号**：`accent`、`mint`、`warm`、`danger` 必须和文字标签同时出现。
4. **4pt 呼吸**：卡片内 16/20，区块间 24/32；设置项不再用密集表单堆叠。
5. **像素只留给品牌图形**：界面控件保持平滑圆角与线性图标，像素画按最近邻渲染。

当前主题采用 UI/UX Pro Max 为 AI 生产力工具匹配的“Teal focus + warm action”
方向，但降低饱和度以保持 Crewvane 自己的气质：墨青工作台承载长时间阅读，海沫青
只表示主动作、选中和需要人处理，暖琥珀承载外部等待与恢复，绿色独立表示完成。
深浅主题分别校准对比度，深色不再是默认主题之外的粗略反转。

## 原语入口

`apps/desktop/src/ui/index.ts`：

- `Button` / `IconButton`：primary / secondary / danger / ghost，高度 32 / 36。
- `Badge` / `StatusPill`：neutral / accent / mint / warm / danger，始终带文字。
- `Card` / `SettingsSection` / `SectionHeading`：分组、标题、说明与右侧动作。
- `EmptyState` / `LoadingState`：空态与加载态的统一语气和布局。
- `Modal`：Radix Dialog 的统一壳，含标题、说明、错误位与关闭按钮。
- `Field` + `TextInput` / `TextArea` / `Select` / `Toggle` / `Checkbox`：标签、说明、
  错误态与控件对齐统一；不引入独立表单组件库。

## 本次落地

- 全局壳层：加入跳到主要内容入口、可见键盘焦点、`aria-current`、上下文明确的计数
  标签和整行可操作的管家长状态；右上角状态标签使用独立类名命名空间并固定 36px
  高度，与“新目标”保持同一垂直中心。
- 注意力首页：卡片增加状态侧线、项目来源、简洁交接摘要和清晰入口；装饰不再使用
  文本星星，统一为 Lucide 图标与像素魔法师。
- 待办池：顶部显示“待安排 / 由你推进”计数，冻结状态筛选，目标行同时展示提醒、
  项目、负责人与更新时间。
- 全部目标：状态筛选固定在滚动区顶部；行级信息按“标题 → 下一步 → 项目 / 负责人 /
  更新时间 → 状态”排列，深浅主题均保持可读。
- 设置页：重组为“工作方式 / 连接与环境 / 提醒与外观”三组，标题层级统一为
  `h1 → h2 → h3`，长页只在正文区域滚动。
- 目标详情、动作卡、重启、Webhook 与现场状态：保留既有信息架构，统一按钮、Badge、
  空态、加载态和错误反馈；终端外的所有浮层复用 Radix Dialog 的焦点约束。
- 表单：新建目标、编辑目标、提交成果、项目、Webhook 全部使用 `Field` 与输入原语；
  Webhook 启用使用 `Toggle`，状态订阅使用 `Checkbox`。
- 主题：主色从靛蓝迁移到深海青，主动作悬停使用同色阶而非跳到成功绿；正文、次级
  文字、状态文字和柔底在深浅主题下均达到 WCAG AA。

## 验收

```sh
pnpm typecheck
pnpm test
pnpm --dir apps/desktop exec vite build
CREWVANE_KEEP_TEST_ARTIFACTS=1 pnpm test:desktop
```

桌面门禁在三种窗口尺寸、深浅主题下覆盖注意力首页、待办池两类、全部目标、设置页
顶部与底部、目标详情和新建目标；自动检查对比度、横向裁切、无名称按钮、小点击目标、
右上角状态与主按钮的垂直中心，以及三目标并发响应。视觉原则仍见
`skills/crewvane-ui/references/checklist.md`。
