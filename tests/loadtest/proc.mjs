// Linux /proc-based process accounting. Used instead of any JS-side
// self-report (performance.now(), etc.) specifically because encode/decode
// work in Chromium is often off the main thread (GPU process, utility
// processes) — a JS-side timer inside the page would miss all of it. Reading
// /proc directly gets the OS's own exact CPU-seconds for a process, correct
// regardless of which thread or which of Chromium's several processes did
// the work, and correct regardless of which core the scheduler used.
import { readFileSync, readdirSync } from 'fs';

const CLK_TCK = 100; // confirmed via `getconf CLK_TCK` on this host — do not assume, this varies by kernel/arch

/** Every currently-running PID's PPID, read once per call — cheap enough to
 *  call fresh each time rather than trying to maintain it incrementally,
 *  and immune to staleness bugs from a process tree that's still forking. */
function allPpids() {
  const map = new Map(); // pid -> ppid
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      // Command name (field 2) is parenthesized and may itself contain
      // spaces/parens, so split on the LAST ')' rather than naive whitespace
      // splitting of the whole line.
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
      const fields = afterComm.split(' ');
      const ppid = parseInt(fields[1], 10); // field 4 overall = fields[1] after the comm split
      map.set(parseInt(entry, 10), ppid);
    } catch { /* process exited between readdir and read — skip it */ }
  }
  return map;
}

/** Every living descendant of rootPid, rootPid included. */
export function descendantPids(rootPid) {
  const ppids = allPpids();
  const children = new Map();
  for (const [pid, ppid] of ppids) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (!ppids.has(pid) && pid !== rootPid) continue; // already exited
    out.push(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return out;
}

/** utime+stime for one PID, in seconds. Returns null if the process has
 *  already exited (a client tearing down mid-sample is expected, not an
 *  error — the caller just drops that PID from the sum). */
export function cpuSecondsFor(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    const fields = afterComm.split(' ');
    // Per proc(5), utime is field 14 overall / stime is field 15 overall.
    // fields[] here starts at overall field 3 (state), so utime = fields[11],
    // stime = fields[12] (14-3=11, 15-3=12).
    const utime = parseInt(fields[11], 10);
    const stime = parseInt(fields[12], 10);
    return (utime + stime) / CLK_TCK;
  } catch {
    return null;
  }
}

/** Sum of utime+stime across a whole process tree, right now. Call this at
 *  the start and end of a measurement window and take the difference — that
 *  difference divided by wall-clock elapsed is the tree's average core
 *  usage over the window, which is the only methodologically correct way to
 *  read "CPU usage" (a single instantaneous read is meaningless; %CPU is
 *  always a delta over an interval). */
export function treeCpuSecondsNow(rootPid) {
  let total = 0;
  for (const pid of descendantPids(rootPid)) {
    const s = cpuSecondsFor(pid);
    if (s !== null) total += s;
  }
  return total;
}

/** RSS memory (MB) for a single PID — used for the LiveKit/Go backend
 *  processes, not summed across a tree (a server process isn't expected to
 *  fork the way a browser does, and VmRSS across a tree double-counts
 *  shared pages badly enough to be misleading anyway). */
export function rssMbFor(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? Math.round(parseInt(m[1], 10) / 1024) : null;
  } catch {
    return null;
  }
}

/** System-wide CPU utilization right now, as (busy-ticks, total-ticks) from
 *  /proc/stat's aggregate `cpu` line — two snapshots + a delta gives overall
 *  host utilization as a fraction of all cores, independent of which
 *  processes are responsible. This is the host-saturation signal: once this
 *  approaches the core count, per-process numbers stop being clean. */
export function systemCpuSnapshot() {
  const line = readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = parts[3] + (parts[4] ?? 0); // idle + iowait
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

export function systemCpuFraction(before, after) {
  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  if (totalDelta <= 0) return 0;
  return 1 - idleDelta / totalDelta; // fraction of all cores busy, 0..1
}

export const CPU_COUNT = readdirSync('/sys/devices/system/cpu').filter((n) => /^cpu\d+$/.test(n)).length;
