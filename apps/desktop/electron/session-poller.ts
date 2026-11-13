import type { SceneReferenceV1 } from "../../../packages/core/src/index.js";
import type { SceneObservation } from "../../../packages/sessions/src/index.js";

/** Budget only the routine compensation poll. Explicit focus, delivery and
 * switch identity checks always query freshly through the SessionRuntime. */
export class SessionPoller {
  private readonly runtimes = new Map<string, {
    next: number; failures: number; pending?: Promise<SceneObservation[]>;
  }>();
  constructor(private readonly now = Date.now) {}

  async inspect(
    scenes: SceneReferenceV1[],
    read: (scenes: SceneReferenceV1[]) => Promise<SceneObservation[]>,
  ): Promise<SceneObservation[] | undefined> {
    if (!scenes.length) return;
    const first = scenes[0]!;
    const key = `${first.backend}:${first.runtimeId}:${first.runtimeGeneration}`;
    if (scenes.some(scene => scene.backend !== first.backend ||
      scene.runtimeId !== first.runtimeId || scene.runtimeGeneration !== first.runtimeGeneration))
      throw new Error("不能把不同运行时的现场混入同一采集。");
    let schedule = this.runtimes.get(key);
    if (!schedule) {
      schedule = { next: 0, failures: 0 };
      this.runtimes.set(key, schedule);
    }
    if (schedule.pending) return schedule.pending;
    if (this.now() < schedule.next) return;
    // Reserve the whole batch at admission, independent of the goal count.
    schedule.next = this.now() + 10_000;
    const current = schedule;
    const failed = () => {
      current.failures++;
      current.next = this.now() + (current.failures === 1 ? 30_000 : 60_000);
    };
    return current.pending = read(scenes).then(observations => {
      if (!observations.length || observations.every(item => item.identity !== "match")) failed();
      else { current.failures = 0; current.next = this.now() + 10_000; }
      return observations;
    }, error => { failed(); throw error; }).finally(() => { current.pending = undefined; });
  }

  reset() { this.runtimes.clear(); }
}
