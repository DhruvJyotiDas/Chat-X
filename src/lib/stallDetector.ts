// Pure decision logic behind useStalledVideoRecovery, split out so it can be tested
// without a real <video> element or React's effect timing — see that hook for why
// this detection exists at all.

export const STALL_THRESHOLD_MS = 7000;
export const RECOVERY_COOLDOWN_MS = 20_000;

export class StallTracker {
  private lastTime: number;
  private lastProgressAt: number;
  // -Infinity, not 0: a real timestamp of 0 would look like "already recovered right at
  // the epoch" and wrongly suppress the very first stall for a full cooldown window.
  private lastRecoveryAt = -Infinity;

  constructor(initialTime: number, now: number) {
    this.lastTime = initialTime;
    this.lastProgressAt = now;
  }

  /** Feed a fresh `video.currentTime` sample. Returns true exactly when recovery should fire. */
  sample(currentTime: number, now: number): boolean {
    if (currentTime > this.lastTime + 0.05) {
      this.lastTime = currentTime;
      this.lastProgressAt = now;
      return false;
    }
    if (now - this.lastProgressAt < STALL_THRESHOLD_MS) return false;
    if (now - this.lastRecoveryAt < RECOVERY_COOLDOWN_MS) return false;

    this.lastRecoveryAt = now;
    return true;
  }
}
