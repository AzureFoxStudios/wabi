import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
const pageKiB = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim()) / 1024;

async function processTree(rootPid) {
  const pending = [String(rootPid)];
  const found = new Set();
  while (pending.length) {
    const pid = pending.pop();
    if (found.has(pid)) continue;
    found.add(pid);
    const tasks = await readdir(`/proc/${pid}/task`).catch(() => []);
    for (const tid of tasks) {
      const children = await readFile(`/proc/${pid}/task/${tid}/children`, 'utf8').catch(() => '');
      pending.push(...children.trim().split(/\s+/).filter(Boolean));
    }
  }
  return [...found];
}

async function snapshot(rootPid) {
  const processes = new Map();
  for (const pid of await processTree(rootPid)) {
    try {
      const [stat, rollup, command] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'),
        readFile(`/proc/${pid}/smaps_rollup`, 'utf8').catch(() => ''),
        readFile(`/proc/${pid}/comm`, 'utf8')
      ]);
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const pssKiB = Number(rollup.match(/^Pss:\s+(\d+) kB/m)?.[1] ?? 0);
      const rssPages = Number(fields[21]);
      processes.set(pid, {
        command: command.trim(),
        ticks: Number(fields[11]) + Number(fields[12]),
        pssKiB,
        rssKiB: rssPages * pageKiB
      });
    } catch {
      // A child may exit between discovering and reading it.
    }
  }
  return processes;
}

export async function measureDesktopIdle(rootPid, seconds = 15) {
  const startAt = performance.now();
  const start = await snapshot(rootPid);
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  const end = await snapshot(rootPid);
  const elapsedSeconds = (performance.now() - startAt) / 1000;
  let usedTicks = 0;
  const processBreakdown = [];
  for (const [pid, process] of end) {
    const previous = start.get(pid);
    const ticks = previous ? Math.max(0, process.ticks - previous.ticks) : 0;
    usedTicks += ticks;
    processBreakdown.push({
      pid: Number(pid),
      command: process.command,
      cpuPercentOneCore: Number((ticks / ticksPerSecond / elapsedSeconds * 100).toFixed(2)),
      proportionalMemoryMiB: Number((process.pssKiB / 1024).toFixed(1))
    });
  }
  return {
    elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
    cpuPercentOneCore: Number((usedTicks / ticksPerSecond / elapsedSeconds * 100).toFixed(2)),
    proportionalMemoryMiB: Number(([...end.values()].reduce((sum, p) => sum + p.pssKiB, 0) / 1024).toFixed(1)),
    residentMemorySumMiB: Number(([...end.values()].reduce((sum, p) => sum + p.rssKiB, 0) / 1024).toFixed(1)),
    processCount: end.size,
    stableProcessCount: [...end.keys()].filter(pid => start.has(pid)).length,
    processBreakdown
  };
}
