/**
 * What the process and its container hold in memory, for the hourly log line and the admin page:
 * the JavaScript heap, native memory (resident set), and the container's own accounting, which hosts
 * such as Railway bill by and which also counts the system's cache of files read or written.
 * Numbers only: nothing here can carry personal data.
 */
import { readFileSync } from 'node:fs';

export interface MemoryReport {
  /** Resident memory of this process. */
  rssMb: number;
  /** Live JavaScript objects, and what the heap has reserved. */
  heapUsedMb: number;
  heapTotalMb: number;
  /** Memory outside the heap held by JavaScript objects (buffers, file contents in transit). */
  externalMb: number;
  /** The container's memory as the host counts it, when the system exposes it: process memory, and cached file pages. */
  containerMb?: number;
  containerAnonMb?: number;
  containerFileMb?: number;
}

const mb = (bytes: number) => Math.round(bytes / 104857.6) / 10;

/**
 * The container's memory counters, or undefined where the system exposes none. The memory controller is
 * cgroup v1's when it is bound there (also on hosts that mount both versions), else v2's. Inside a
 * container the path /proc/self/cgroup names is often not mounted: the container sees its own group at
 * the root of the mount, which is tried next.
 */
export function containerMemory(read: (path: string) => string = (p) => readFileSync(p, 'utf8')): Pick<MemoryReport, 'containerMb' | 'containerAnonMb' | 'containerFileMb'> | undefined {
  let self: string;
  try {
    self = read('/proc/self/cgroup');
  } catch {
    return undefined;
  }
  const v1 = /^\d+:(?:[^:]*,)?memory(?:,[^:]*)?:(.*)$/m.exec(self)?.[1];
  const v2 = /^0::(.*)$/m.exec(self)?.[1];
  const under = (root: string, path: string) => (path === '/' ? root : `${root}${path}`);
  const candidates: [dir: string, usageFile: string][] =
    v1 !== undefined
      ? [[under('/sys/fs/cgroup/memory', v1), 'memory.usage_in_bytes'], ['/sys/fs/cgroup/memory', 'memory.usage_in_bytes']]
      : v2 !== undefined
        ? [[under('/sys/fs/cgroup', v2), 'memory.current'], ['/sys/fs/cgroup', 'memory.current']]
        : [];
  for (const [dir, usageFile] of candidates) {
    try {
      const stat = new Map(
        read(`${dir}/memory.stat`)
          .trim()
          .split('\n')
          .map((line) => line.split(' ') as [string, string]),
      );
      const usage = Number(read(`${dir}/${usageFile}`).trim());
      const anon = Number(stat.get('anon') ?? stat.get('rss'));
      const file = Number(stat.get('file') ?? stat.get('cache'));
      if ([usage, anon, file].every(Number.isFinite)) return { containerMb: mb(usage), containerAnonMb: mb(anon), containerFileMb: mb(file) };
    } catch {
      // not mounted here: try the next place
    }
  }
  return undefined;
}

export function memoryReport(): MemoryReport {
  const m = process.memoryUsage();
  return { rssMb: mb(m.rss), heapUsedMb: mb(m.heapUsed), heapTotalMb: mb(m.heapTotal), externalMb: mb(m.external), ...containerMemory() };
}
