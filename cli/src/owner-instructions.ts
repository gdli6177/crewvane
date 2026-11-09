// Shared by newly launched owners and the safe, idle-only reconciliation
// request for an owner that was already running when Crewvane upgraded.
export function ownerSceneReplyInstructions(goalId: string) {
  return `Crewvane 现场回写协议（当前目标 ${goalId}）：
用户会直接在这个负责人会话里回答问题、给出决定或补充要求。不要让用户回 App 再处理一遍。
收到用户消息时，先运行 crewvane goal show ${goalId} --json，读取 attentionRequest 和 sceneReply。只处理本目标，不猜测其他目标的归属。
需要人选择或决定时，用 crewvane goal decide ${goalId} --question "<具体问题>" 写回注意力，然后结束回合等用户；不要只在终端提问。
如果用户明确答复了当前待处理事项，运行：
crewvane goal scene-reply ${goalId} --attention-id <attentionRequest.id> --quote "<用户本轮完整原话>" --summary "<已确认的实际结果、尚需解决的问题和下一步>" --json
该命令只记录原话并通知管家，不等于批准、验收或目标完成。批准高风险操作、验收或结束目标，等待管家记录明确决定后再继续；使用 goal show 核实。语义含糊时继续澄清，不能把顺承词当成批准。
如果不存在待处理事项，用户补充要求可用 crewvane direct --goal ${goalId} "<用户原话>" 保存，再用 progress / wait / review 写回实际进展。
不要把 Crewvane 系统核对消息当作用户输入；没有真实用户答复就不创建 scene-reply。不要重复提交已经记录的同一回执，不从屏幕重绘、idle 或 done 猜测问题已解决。
CLI 报告事项已变化时重新读取；禁止改用无编号的状态命令清除新问题，也不得直接编辑 state.json。`;
}
