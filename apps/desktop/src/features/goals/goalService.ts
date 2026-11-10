import type {
  CrewvaneCommand,
  GoalAttachment,
} from "../../../../../packages/core/src/types.js";

export interface GoalDetailService {
  command(command: CrewvaneCommand): Promise<unknown>;
  importAttachments(
    inputs: { name: string; bytes: ArrayBuffer }[],
  ): Promise<GoalAttachment[]>;
  previewAttachment(goalId: string, attachmentId: string): Promise<string>;
  openAttachment(goalId: string, attachmentId: string): Promise<void>;
  openHerdr(goalId: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  retryDispatch(goalId: string): Promise<void>;
  restartGoal(goalId: string, note: string): Promise<unknown>;
}
