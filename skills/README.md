# Skills

- `crewvane/`：随桌面应用安装的主协议 Skill，负责目标入口、明确状态写回、
  attention receipt、负责人现场与 CLI 边界。
- `crewvane-local-pack-author/`：随桌面应用安装的本地工作方法创建器；通过自然语言
  生成、验证并安装说明型或脚本型能力包。
- `crewvane-ui/`：桌面 UI 开发约束：token、共享原语、空态/设置/注意力面板与视觉验收清单。项目内使用，不随应用安装。
- `ship-*`：**Legacy**，0.2 手工合同流程的遗留技能，不再随应用安装或参与
  当前流程；仅为历史参考保留。当前用法见 `docs/crewvane.md`。

当前版本同时把角色和工序作为 Core 内置 Skill 解析。内置方法位于
`packages/core/src/skill-registry.ts`，不复制到 Agent 配置目录；设置页会列出其
名称和用途，但不可修改或占用目标本地方法名额。本地能力包存储在
`<workspace>/.crewvane/skills/`，格式见
`docs/product/local-capability-packs.md`。
