// Capture Pi Desktop's process-level CPU use without restarting the installed app.
// Usage: node scripts/capture-pi-cpu.cjs [--pid=MAIN_PID] [--seconds=30] [--interval-ms=5000]
const { execFileSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')

const MAIN_EXECUTABLE =
  /^\/.*\/Pi Desktop\.app\/Contents\/MacOS\/Pi Desktop(?:\s+--[\w-]+(?:=[^\s]+)?)*$/

function cpuSeconds(value) {
  const [clock, days = '0'] = value.includes('-')
    ? [value.slice(value.indexOf('-') + 1), value.slice(0, value.indexOf('-'))]
    : [value]
  const fields = clock.split(':').map(Number)
  if (!fields.length || fields.some((field) => !Number.isFinite(field))) return null
  return (
    Number(days) * 86400 +
    fields.reverse().reduce((sum, field, index) => sum + field * 60 ** index, 0)
  )
}

function parseProcesses(output) {
  return output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+([\d.:-]+)\s+(.+)$/.exec(line)
    if (!match) return []
    const [, pid, ppid, reportedCpu, rssKiB, time, command] = match
    return [
      {
        pid: Number(pid),
        ppid: Number(ppid),
        reportedCpu: Number(reportedCpu),
        rssMiB: Math.round(Number(rssKiB) / 1024),
        cpuSeconds: cpuSeconds(time),
        command
      }
    ]
  })
}

function role(command, main) {
  if (main) return 'main'
  const type = /--type=([^\s]+)/.exec(command)?.[1]
  const utility = /--utility-sub-type=([^\s]+)/.exec(command)?.[1]
  return utility ? `utility:${utility.split('.').at(-1)}` : type || 'agent-or-helper'
}

function selectTree(processes, mainPid) {
  const included = new Set([mainPid])
  for (let changed = true; changed;) {
    changed = false
    for (const item of processes)
      if (!included.has(item.pid) && included.has(item.ppid)) {
        included.add(item.pid)
        changed = true
      }
  }
  return processes.filter((item) => included.has(item.pid))
}

function summarize(processes, mainPid, prior, elapsedSeconds) {
  const selected = selectTree(processes, mainPid)
  const items = selected
    .map((item) => {
      const before = prior?.get(item.pid)
      const delta =
        before !== undefined && item.cpuSeconds !== null && item.cpuSeconds >= before
          ? item.cpuSeconds - before
          : null
      const coreCpuPercent =
        delta !== null && elapsedSeconds > 0
          ? Math.round((delta / elapsedSeconds) * 1000) / 10
          : null
      return {
        pid: item.pid,
        ppid: item.ppid,
        role: role(item.command, item.pid === mainPid),
        coreCpuPercent,
        reportedCpuPercent: item.reportedCpu,
        rssMiB: item.rssMiB
      }
    })
    .sort(
      (a, b) =>
        (b.coreCpuPercent ?? b.reportedCpuPercent) - (a.coreCpuPercent ?? a.reportedCpuPercent)
    )
  return {
    mainPid,
    totalCoreCpuPercent: items.every((item) => item.coreCpuPercent !== null)
      ? Math.round(items.reduce((sum, item) => sum + item.coreCpuPercent, 0) * 10) / 10
      : null,
    processes: items
  }
}

function option(name, fallback) {
  const found = process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))
  return found ? Number(found.slice(name.length + 3)) : fallback
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('This capture supports macOS only')
  const requestedPid = option('pid', null)
  const seconds = option('seconds', 30)
  const intervalMs = option('interval-ms', 5000)
  if (requestedPid !== null && (!Number.isInteger(requestedPid) || requestedPid <= 0))
    throw new Error('--pid must be a positive integer')
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 300)
    throw new Error('--seconds must be an integer from 5 to 300')
  if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 5000)
    throw new Error('--interval-ms must be an integer from 250 to 5000')
  const read = () =>
    parseProcesses(
      execFileSync('ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,time=,command='], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
      })
    )
  const first = read()
  const candidates = first.filter((item) => MAIN_EXECUTABLE.test(item.command))
  const mainPid = requestedPid ?? (candidates.length === 1 ? candidates[0].pid : null)
  if (!mainPid || !candidates.some((item) => item.pid === mainPid))
    throw new Error(
      `Select a running Pi Desktop main PID with --pid. Candidates: ${candidates.map((item) => item.pid).join(', ') || 'none'}`
    )
  const started = performance.now()
  let previousAt = started
  let previous = new Map(first.map((item) => [item.pid, item.cpuSeconds]))
  const until = started + seconds * 1000
  while (performance.now() < until) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, until - performance.now()))
    )
    const now = performance.now()
    const processes = read()
    if (!processes.some((item) => item.pid === mainPid)) break
    const snapshot = summarize(processes, mainPid, previous, (now - previousAt) / 1000)
    process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...snapshot }) + '\n')
    previous = new Map(processes.map((item) => [item.pid, item.cpuSeconds]))
    previousAt = now
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })

module.exports = { cpuSeconds, parseProcesses, selectTree, summarize }
