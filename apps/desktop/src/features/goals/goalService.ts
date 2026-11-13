import type {
  CrewvaneCommand,
  GoalAttachment,
  SkillPackView,
} from "../../../../../packages/core/src/types.js";

export interface GoalDetailService {
  command(command: CrewvaneCommand): Promise<unknown>;
  importAttachments(
    inputs: { name: string; bytes: ArrayBuffer }[],
  ): Promise<GoalAttachment[]>;
  previewAttachment(goalId: string, attachmentId: string): Promise<string>;
  openAttachment(goalId: string, attachmentId: string): Promise<void>;
  openHerdr(goalId: string, recover?: boolean): Promise<void>;
  openUrl(url: string): Promise<void>;
  retryDispatch(goalId: string): Promise<void>;
  restartGoal(goalId: string, note: string): Promise<unknown>;
  methodPacks?(): Promise<SkillPackView[]>;
}
