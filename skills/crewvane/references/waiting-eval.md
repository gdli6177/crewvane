# 等待语义验收场景

本表用于核对调用本 Skill 的 Agent 是否采用正确命令；不要求固定自然语言输出格式。

| 真实事实 | 期望行为 | 禁止行为 |
| --- | --- | --- |
| 需要用户选择方案、补充信息或完成操作 | `goal decide --question`，保留注意力 | `goal wait --owner 你` |
| 等待管家、负责人、工人或另一个 Agent 的结果 | 保持 `active`，通过管家协调；有实际结果才 `progress` | 把任何内部 Agent 写成外部等待对象 |
| YR 尚未完成外部审批 | `goal wait --owner YR --reason`，有明确时间再加提醒 | 省略等待对象，覆盖执行负责人 |
| 用户要求一小时后提醒 | `goal remind`；生命周期保持原样 | 把活动目标改成等待外部 |
| 用户给外部等待目标追加消息 | 先保存原话；交回 Agent 后为 `active`，核查后再决定是否重设外部等待 | 从正文直接推断批准或完成 |
| 负责人终端停止输出 | 让管家核对真实事实，继续写回 | 把空闲当成外部等待、交付或已完成 |

确定性约束见 `packages/core/test/external-wait.test.ts` 与 `cli/test/cli.test.ts`；打包应用验证入口为 `pnpm test:external-wait`。
