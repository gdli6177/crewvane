import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock3,
  GitBranch,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  goalKind,
  goalRevision,
  resolveAcceptance,
  workspaceAutonomy,
} from "../../../../../packages/core/src/index.js";
import type {
  AcceptanceMode,
  Goal,
  WorkspaceState,
} from "../../../../../packages/core/src/types.js";
import { Badge } from "../../ui/index.js";
import type { GoalDetailService } from "./goalService.js";
import { time } from "./goalPresentation.js";

const kindLabels = {
  delivery: "交付目标",
  discovery: "探索目标",
  release: "发布目标",
} as const;

const acceptanceLabels: Record<AcceptanceMode, string> = {
  "human-review": "人工验收",
  "auto-with-verification": "独立复核后自动验收",
};

const acceptanceSourceLabels = {
  goal: "目标覆盖",
  project: "项目设置",
  workspace: "工作区默认",
} as const;

const continuationLabels = {
  checkpoint: "短回合收尾",
  verification: "独立复核",
  recovery: "带新证据恢复",
  "wait-due": "外部等待到期",
  "decision-resolved": "人工决定已解决",
  dependency: "依赖已完成",
} as const;

const continuationStatusLabels = {
  scheduled: "等待到期",
  claimed: "调度器已领取",
  sent: "已送达管家",
  settled: "已结算",
  cancelled: "已取消",
  failed: "发送失败",
} as const;

const verificationSiteLabels = {
  launching: "复核现场启动中",
  ready: "独立复核现场已就绪",
  blocked: "复核现场等待交互确认",
  failed: "复核现场启动失败",
} as const;

function CriteriaList({ goal }: { goal: Goal }) {
  if (!goal.brief) return null;
  return (
    <div className="autonomy-criteria">
      {goal.brief.criteria.map(criterion => {
        const result = goal.autonomy?.lastVerification?.criteria.find(
          item => item.criterionId === criterion.id,
        );
        const provenance = criterion.provenance.kind === "user-message"
          ? "人的原话"
          : criterion.provenance.kind === "project-rule"
            ? `项目规则 · ${criterion.provenance.ref}`
            : `验证方法 · ${criterion.provenance.rationale}`;
        return (
          <div key={criterion.id}>
            <span className={result?.result === "passed"
              ? "passed"
              : result?.result === "failed" ? "failed" : "pending"}>
              {result?.result === "passed"
                ? <CheckCircle2 size={13} />
                : result?.result === "failed"
                  ? <AlertTriangle size={13} />
                  : <Clock3 size={13} />}
            </span>
            <div>
              <strong>{criterion.statement}</strong>
              <small>
                {criterion.required ? "必选" : "可选"} · {provenance}
              </small>
              {result?.note && <p>{result.note}</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function GoalAutonomySummary({
  goal,
  state,
  service,
  busy,
  notify,
}: {
  goal: Goal;
  state: WorkspaceState;
  service: GoalDetailService;
  busy: boolean;
  notify: (text: string) => void;
}) {
  const autonomy = goal.autonomy,
    resolution = resolveAcceptance(state, goal),
    brief = goal.brief,
    continuation = autonomy?.continuation,
    verification = autonomy?.lastVerification,
    acceptance = autonomy?.acceptance,
    boundary = autonomy?.boundaryChange,
    release = goal.release,
    workspace = workspaceAutonomy(state),
    briefHistory = goal.briefHistory ?? [];
  if (!brief && !autonomy && !release && goalKind(goal) === "delivery") return null;

  return (
    <section className="goal-autonomy-summary" aria-label="自主目标状态">
      <header>
        <span><Sparkles size={15} /></span>
        <div>
          <small>自主目标</small>
          <strong>{kindLabels[goalKind(goal)]} · 修订 {goalRevision(goal)}</strong>
        </div>
        {autonomy?.paused && <Badge tone="warm">自主续跑已暂停</Badge>}
        {workspace.paused && <Badge tone="danger">工作区全局暂停</Badge>}
        {boundary?.status === "pending" && <Badge tone="accent">边界待批准</Badge>}
      </header>

      <div className="autonomy-facts">
        <div>
          <small>生效验收方式</small>
          <strong>{release ? "每次生产发布由人批准" : acceptanceLabels[resolution.mode]}</strong>
          <span>{release ? "发布结果仍需人最终确认" : acceptanceSourceLabels[resolution.source]}</span>
        </div>
        <div>
          <small>恢复预算</small>
          <strong>
            {autonomy?.attempts.used ?? 0} / {autonomy?.attempts.limit ?? brief?.attemptBudget.maxRecoveryAttempts ?? "—"}
          </strong>
          <span>仅约束自动恢复，不限制正常工作回合</span>
        </div>
        <div>
          <small>下一步窗口</small>
          <strong>{continuation ? continuationLabels[continuation.trigger] : "暂无排队续跑"}</strong>
          <span>
            {continuation
              ? `${continuationStatusLabels[continuation.status]} · ${time(continuation.dueAt)}`
              : "等待负责人写回 checkpoint、交付或人工决定"}
          </span>
        </div>
        <div>
          <small>最终裁决</small>
          <strong>始终由人保留</strong>
          <span>可随时暂停、重新打开或改为人工验收</span>
        </div>
      </div>

      {!release && (
        <label className="autonomy-override">
          <span>
            <strong>目标验收覆盖</strong>
            <small>优先级最高；只作用于当前目标，不改变项目或工作区设置。</small>
          </span>
          <select
            value={autonomy?.override ?? "inherit"}
            disabled={busy}
            onChange={async event => {
              const acceptance = event.target.value as
                | "inherit"
                | AcceptanceMode;
              try {
                await service.command({
                  type: "goal.autonomy.acceptance",
                  goalId: goal.id,
                  acceptance,
                  actor: "你",
                });
                notify(acceptance === "inherit"
                  ? "已恢复项目或工作区的验收设置"
                  : acceptance === "human-review"
                    ? "当前目标已改为人工验收"
                    : "当前目标已允许独立复核后自动验收");
              } catch {
                // The command surface reports the real validation error.
              }
            }}
          >
            <option value="inherit">继承项目 / 工作区</option>
            <option value="human-review">人工验收</option>
            <option value="auto-with-verification">独立复核后自动验收</option>
          </select>
        </label>
      )}

      {brief && (
        <details className="autonomy-details" open={goal.status === "review"}>
          <summary>
            <span><ShieldCheck size={14} />委托摘要 v{brief.revision}</span>
            <ChevronDown size={14} />
          </summary>
          <div className="autonomy-detail-body">
            <p className="autonomy-outcome">{brief.outcome}</p>
            <div className="autonomy-scope">
              <div>
                <small>范围内</small>
                {brief.inScope.length ? brief.inScope.map(item => <span key={item}>{item}</span>) : <em>未单列</em>}
              </div>
              <div>
                <small>范围外</small>
                {brief.outOfScope.length ? brief.outOfScope.map(item => <span key={item}>{item}</span>) : <em>未单列</em>}
              </div>
              <div>
                <small>外部影响</small>
                {brief.externalEffects.length ? brief.externalEffects.map(item => <span key={item}>{item}</span>) : <em>无额外外部影响</em>}
              </div>
            </div>
            <CriteriaList goal={goal} />
            {!!(brief.constraints.length || brief.source.ruleRefs.length) && (
              <div className="autonomy-notes">
                {brief.constraints.map(item => <span key={item}>约束：{item}</span>)}
                {brief.source.ruleRefs.map(item => <span key={item}>规则引用：{item}</span>)}
              </div>
            )}
            <small className="autonomy-footnote">
              {brief.setBy} 于 {time(brief.setAt)} 建立
            </small>
            {!!briefHistory.length && (
              <details className="autonomy-history">
                <summary>委托摘要修订记录 · {briefHistory.length} 次</summary>
                {[...briefHistory].reverse().map(previous => (
                  <div key={`${previous.revision}:${previous.setAt}`}>
                    <strong>v{previous.revision} · {previous.outcome}</strong>
                    <small>{previous.setBy} · {time(previous.setAt)}</small>
                  </div>
                ))}
              </details>
            )}
          </div>
        </details>
      )}

      {(verification || autonomy?.verificationSite || continuation || acceptance) && (
        <details className="autonomy-details">
          <summary>
            <span><GitBranch size={14} />复核、续跑与验收记录</span>
            <ChevronDown size={14} />
          </summary>
          <div className="autonomy-detail-body">
            {continuation && (
              <div className="autonomy-record">
                <strong>续跑 · {continuationLabels[continuation.trigger]}</strong>
                <p>
                  {continuationStatusLabels[continuation.status]} · 第 {continuation.attempt} 次 ·
                  {" "}{time(continuation.dueAt)}
                </p>
                {continuation.lastError && <p className="failed">{continuation.lastError}</p>}
              </div>
            )}
            {autonomy?.verificationSite && (
              <div className="autonomy-record">
                <strong>{verificationSiteLabels[autonomy.verificationSite.status]}</strong>
                <p>
                  {autonomy.verificationSite.reference?.agent || "独立复核者"}
                  {autonomy.verificationSite.reference?.paneId
                    ? ` · ${autonomy.verificationSite.reference.paneId}`
                    : ""}
                  {" · "}{time(autonomy.verificationSite.at)}
                </p>
                {autonomy.verificationSite.detail && (
                  <p className="failed">{autonomy.verificationSite.detail}</p>
                )}
              </div>
            )}
            {verification && (
              <div className="autonomy-record">
                <strong>
                  独立复核 · {verification.outcome === "passed" ? "通过" : "未通过"}
                </strong>
                <p>{verification.summary}</p>
                <small>
                  {verification.reviewer} · {time(verification.verifiedAt)}
                  {verification.reviewerHerdr?.paneId
                    ? ` · 复核现场 ${verification.reviewerHerdr.paneId}`
                    : ""}
                </small>
              </div>
            )}
            {acceptance && (
              <div className="autonomy-record">
                <strong>
                  验收记录 · {acceptance.kind === "automatic" ? "自动验收" : "人工验收"}
                </strong>
                <p>{acceptance.note || "未附验收说明"}</p>
                <small>
                  {acceptance.by} · 授权修订 {acceptance.mandateRevision} · {time(acceptance.at)}
                </small>
              </div>
            )}
          </div>
        </details>
      )}

      {boundary && (
        <details className="autonomy-details" open={boundary.status === "pending"}>
          <summary>
            <span><AlertTriangle size={14} />边界变更 · {boundary.status === "pending" ? "待你批准" : boundary.status === "approved" ? "已批准" : "已拒绝"}</span>
            <ChevronDown size={14} />
          </summary>
          <div className="autonomy-detail-body">
            <p>{boundary.reason}</p>
            {boundary.recommendation && <p>建议：{boundary.recommendation}</p>}
            {!!boundary.evidence.length && <p>证据：{boundary.evidence.join("；")}</p>}
            {!!boundary.alternatives.length && <p>备选：{boundary.alternatives.join("；")}</p>}
            <small>{time(boundary.resolvedAt || boundary.createdAt)}</small>
          </div>
        </details>
      )}

      {release && (
        <details className="autonomy-details" open>
          <summary>
            <span><GitBranch size={14} />发布记录 · {release.status}</span>
            <ChevronDown size={14} />
          </summary>
          <div className="autonomy-detail-body">
            <p>
              候选 {release.candidate.version || release.candidate.revision}
              {release.candidate.digest ? ` · ${release.candidate.digest.slice(0, 12)}…` : ""}
              {" "}→ {release.environment}
            </p>
            {release.authorization ? (
              <p>
                已由 {release.authorization.approvedBy} 单独批准 · {time(release.authorization.approvedAt)}
                {release.authorization.note ? ` · ${release.authorization.note}` : ""}
              </p>
            ) : <p>尚未获得本次发布批准。</p>}
            {release.result && (
              <p className={release.result.outcome === "succeeded" ? "passed" : "failed"}>
                执行结果：{release.result.outcome === "succeeded" ? "成功" : "失败"} · {release.result.evidence.join("；")}
              </p>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
