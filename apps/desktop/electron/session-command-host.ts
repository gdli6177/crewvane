import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WorkspaceService, validatedScene, type ManagedSessionContext,
} from "../../../packages/core/src/index.js";
import {
  SessionRecoveryChannel, SessionError, publishSessionHost, unpublishSessionHost,
  type RecoveryRequest, type SessionRuntime,
} from "../../../packages/sessions/src/index.js";

/** Desktop execution for managed CLI operations; not an arbitrary shell bridge. */
export class SessionCommandHost {
  private readonly channel: SessionRecoveryChannel;
  constructor(private readonly options: {
    workspace: string;
    directory: string;
    canDispatch(): Promise<boolean>;
    runtime(context: ManagedSessionContext): Pick<SessionRuntime, "launchOwner" | "send">;
  }) {
    this.channel = new SessionRecoveryChannel(options.directory, request => this.execute(request));
  }
  async start() {
    await this.channel.start();
    try { await publishSessionHost(this.options.workspace, this.channel); }
    catch (error) { await this.channel.stop(); throw error; }
  }
  async stop() {
    await unpublishSessionHost(this.options.workspace, this.channel);
    await this.channel.stop();
  }
  private async execute(request: RecoveryRequest) {
    if (!await this.options.canDispatch())
      throw new SessionError("backend_switch_in_progress", "正在交接现场，普通 Host 请求未执行。");
    const state = await new WorkspaceService(this.options.workspace).read();
    const context = request.context, binding = state.backendBinding;
    const scope = JSON.parse(await readFile(join(this.options.workspace, ".crewvane", "coordinator-scope.json"), "utf8"));
    if (!binding || binding.status !== "active" || context.role !== "concierge" ||
      context.installationId !== binding.installationId || context.backend !== binding.backend ||
      context.epoch !== binding.epoch || context.scopeGeneration !== binding.scopeGeneration ||
      context.attemptId !== state.concierge.scene?.attemptId || context.goalId !== scope.goalId)
      throw new Error("会话操作不属于当前管家、运行代次或案卷。");
    const runtime = this.options.runtime(context);
    if (request.operation === "launch") {
      const value = request.input;
      if (value.goalId !== scope.goalId || typeof value.name !== "string" ||
        value.role && value.role !== "owner" && value.role !== "verifier" ||
        value.task !== undefined && typeof value.task !== "string" ||
        value.taskFile !== undefined && typeof value.taskFile !== "string" ||
        value.consultationOnly !== undefined)
        throw new Error("受管启动参数无效。");
      return runtime.launchOwner({
        goalId: scope.goalId, name: value.name,
        role: value.role as "owner" | "verifier" | undefined,
        task: value.task as string | undefined, taskFile: value.taskFile as string | undefined,
      });
    }
    if (request.operation !== "send" || typeof request.input.deliveryId !== "string" ||
      typeof request.input.text !== "string" || request.input.text.length > 100_000)
      throw new Error("受管投递参数无效。");
    return runtime.send(validatedScene(request.input.scene), request.input.deliveryId, request.input.text);
  }
}
