# Orca Session Adapter：G0 接口核实记录

核实日期：2026-11-13。开发基线：Crewvane `v0.10.0`，`ddf9cc2`。
本文记录安装源码与隔离实测，不把上游功能名称当成已验证的产品保证。

## 被测环境

- macOS Apple Silicon；Orca `1.4.258`，`/Applications/Orca.app`。
- 官方应用身份 `com.stablyai.orca`；签名 Team ID `6CX3WHS9HZ`。
- 官方 CLI：应用内 `Contents/Resources/bin/orca`。
- 独立测试 profile：`/private/tmp/cv-orca-g0/profile`，不操作用户正常 profile。
- Herdr 对照版本 `0.9.5`，使用命名测试 Session。
- 真实模型由已安装 OMP `18.15.0` 提供；Codex 生命周期另走打包应用 Hook 验收。

Orca 的安装检测同时核对 bundle 身份、严格代码签名、发布者、应用版本和 CLI
版本；当前仅 `1.4.258` 在兼容表中。其他已签名版本显示“尚未验证”，不自动启用。
官方安装包 URL、字节数和 SHA-256 固定在
`packages/sessions/src/orca/detection.ts`，更新检查不等于批准任意新版本。

## 确认可用的接口与边界

| 能力 | 实现与实测依据 |
| --- | --- |
| 连接身份 | CLI envelope 中的 runtime ID；核对进程出生时间，防止 PID 复用 |
| 普通目录工作区 | 精确 folder-match，中文/空格路径通过；不执行 git init 或创建额外 worktree |
| 创建终端 | `terminal create` 执行私有短 launcher；收据绑定 installation、request、binding、attempt 与真实 locator |
| 注入环境 | launcher 在交互登录 zsh 中 source，导出 Crewvane 身份；保留 alias、函数与原生 argv |
| 发送正文 | `terminal send` 的接受/开始观测分开保存；未确认结果不换请求重发 |
| 生命周期 | 查询终端和程序的可验证状态；idle 不是业务完成，Agent Hooks 和 CLI 语义写回继续有效 |
| 后台终端 | `orphaned=true` 仅表示 leaf 未挂载；`connected=true`、`writable=true` 且进程身份匹配时仍可发送，不能判为失联 |
| 精确聚焦 | `terminal switch` 返回 `navigated=true` 且 runtime 匹配；20 次聚焦不创建新终端 |
| 关闭 | 验证绑定、终端 incarnation 与进程停止；退出码不能单独证明停止 |
| 丢失响应 | 通过原请求的私有收据发现原现场；不盲目再次创建 |
| 原生恢复 | **unsupported**；按目标案卷继续，不宣称跨后端恢复终端全文或原生会话 |

适配器连接时还核对 `terminal.prompt-delivery.v1`、
`terminal.create-idempotency.v2`、`workspace-selector.folder-match.v1`
等实际能力。虽然上游声明创建幂等能力，当前所用公共 `terminal create` 命令
没有显式 request ID 参数，因此 Crewvane 仍在副作用前持久保存意图，使用自己的
launcher 收据发现现场，不把能力名称当作可安全重试的凭据。

## 可重跑证据

```sh
CREWVANE_TEST_ORCA_PROFILE=/private/tmp/cv-orca-g0/profile pnpm test:orca
CREWVANE_TEST_HERDR_BINARY=/absolute/path/to/verified/herdr \
  pnpm exec tsx scripts/herdr-session-contract-smoke.mjs
```

2026-11-13 的真实 Orca 契约证据：
`/private/var/folders/rn/g5lv0lln5xs50nhkrc2w0lyr0000gn/T/cv-orca-contract-ZCJWxB/manifest.json`。
确认 alias、中文 argv / cwd、1,044 项 PATH、48,001 字节精确单次投递、
重复创建复用、20 次聚焦、受管进程停止；原生恢复明确返回 unsupported。

多终端投递证据：`/private/tmp/cv-orca-live-send-6z6kif`。前台管家与后台
负责人同时存在，负责人 `orphaned=true` 时通过官方 `terminal send` 实际收到
消息并回复；`terminal switch` 聚焦同一个 handle 后 `orphaned=false`。
契约回归覆盖 inspect、send、focus 三条路径，避免把界面挂载状态混同进程状态。

同次 Herdr 契约证据：`/private/tmp/cv-hc-6q6Ly3/manifest.json`。
确认 alias、中文路径、42,001 字节精确单次投递、幂等创建与发送、
真实聚焦、确认停止。真实 CLI 仅支持方向式 `pane focus`；按目标定位使用
Tab 聚焦及必要时的 `agent focus <paneId>`，不会使用不存在的 `pane focus <id>`。

完整“管家创建负责人 → 两方向切换 → 现场答复 → 注意力写回”结果另记在
[发布验收记录](../qa/session-backends-v0.11.0-acceptance.md)，不能用本节无模型
契约试验替代真实模型执行。

## 尚未验证

- 第二台无开发依赖 Mac 的安装与首次系统授权；当前只能记录本机结果。
- Orca 原生 Agent 会话 resume、远程 execution host 和完整终端历史迁移。
- 任意新 Orca 版本；通过签名检查不等于通过本版接口合同。
- 原生 Orca 的所有快捷键组合；Crewvane 只负责定位，其输入交互由 Orca 承载。
