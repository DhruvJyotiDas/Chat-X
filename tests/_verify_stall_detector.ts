// npx tsx _verify_stall_detector.ts
// Property checks on StallTracker (src/lib/stallDetector.ts) — the pure decision core
// behind useStalledVideoRecovery. Run with `npx tsx`, not node.

import { StallTracker, STALL_THRESHOLD_MS, RECOVERY_COOLDOWN_MS } from '../src/lib/stallDetector';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL: ${name}`); }
}

// 1. Steady playback (currentTime advancing every sample) never stalls, however long it runs.
{
  const t = new StallTracker(0, 0);
  let triggered = false;
  let now = 0;
  for (let i = 0; i < 200; i++) {
    now += 1000;
    if (t.sample(now / 1000, now)) triggered = true;
  }
  check('steady playback never triggers recovery', !triggered);
}

// 2. currentTime frozen for exactly STALL_THRESHOLD_MS - 1 does not trigger yet.
{
  const t = new StallTracker(5, 0);
  const justBefore = t.sample(5, STALL_THRESHOLD_MS - 1);
  check('does not trigger just before the threshold', !justBefore);
}

// 3. currentTime frozen past STALL_THRESHOLD_MS triggers exactly once.
{
  const t = new StallTracker(5, 0);
  const before = t.sample(5, STALL_THRESHOLD_MS - 1000);
  const at = t.sample(5, STALL_THRESHOLD_MS + 1);
  check('does not fire before threshold crossed', !before);
  check('fires once threshold is crossed', at);
}

// 4. After firing, a second stall within the cooldown window does not fire again.
{
  const t = new StallTracker(5, 0);
  const first = t.sample(5, STALL_THRESHOLD_MS + 1);
  const second = t.sample(5, STALL_THRESHOLD_MS + 1 + RECOVERY_COOLDOWN_MS - 1);
  check('first stall fires', first);
  check('second stall inside cooldown does not fire', !second);
}

// 5. After the cooldown elapses, a still-stalled tile can fire again.
{
  const t = new StallTracker(5, 0);
  const first = t.sample(5, STALL_THRESHOLD_MS + 1);
  const later = t.sample(5, STALL_THRESHOLD_MS + 1 + RECOVERY_COOLDOWN_MS + 1);
  check('first stall fires', first);
  check('fires again after cooldown elapses if still stalled', later);
}

// 6. Any progress resets the stall clock — a brief stutter followed by real playback
//    never accumulates toward the threshold across the gap.
{
  const t = new StallTracker(0, 0);
  const stutter1 = t.sample(0, STALL_THRESHOLD_MS - 500); // 6.5s stuck, not yet over threshold
  const progresses = t.sample(1, STALL_THRESHOLD_MS - 400); // frame arrives, resets clock
  const stillFine = t.sample(1, STALL_THRESHOLD_MS - 400 + STALL_THRESHOLD_MS - 1000);
  check('no trigger before threshold', !stutter1);
  check('progress does not itself trigger', !progresses);
  check('clock reset by progress, no false trigger shortly after', !stillFine);
}

// 7. A tiny sub-frame currentTime jitter (< 0.05s) does not count as progress —
//    guards against float noise masking a real stall.
{
  const t = new StallTracker(5, 0);
  const jitter = t.sample(5.02, STALL_THRESHOLD_MS - 100);
  const stillStalled = t.sample(5.02, STALL_THRESHOLD_MS + 100);
  check('sub-threshold jitter is not progress', !jitter);
  check('genuine stall still detected despite jitter', stillStalled);
}

// 8. currentTime going backwards (a seek/loop edge case) is treated as no-progress,
//    not a crash and not a spurious trigger before the threshold.
{
  const t = new StallTracker(10, 0);
  const backwards = t.sample(2, 100);
  check('currentTime decreasing does not itself trigger early', !backwards);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
