type ProcessCpuMetric = {
  pid: number
  creationTime: number
  cpu: { cumulativeCPUUsage?: number }
}

/** Cumulative CPU seconds / monotonic wall seconds, as a percentage of one core. */
export class ProcessCpuSampler {
  private previous = new Map<string, { cpu: number; at: number }>()

  sample(metrics: readonly ProcessCpuMetric[], monotonicMs: number): Array<number | null> {
    const next = new Map<string, { cpu: number; at: number }>()
    const result = metrics.map((metric) => {
      const key = `${metric.pid}:${metric.creationTime}`
      const cpu = metric.cpu.cumulativeCPUUsage
      if (cpu === undefined || !Number.isFinite(cpu) || cpu < 0 || !Number.isFinite(monotonicMs))
        return null
      const prior = this.previous.get(key)
      next.set(key, { cpu, at: monotonicMs })
      if (!prior || monotonicMs <= prior.at || cpu < prior.cpu) return null
      const percent = ((cpu - prior.cpu) / ((monotonicMs - prior.at) / 1000)) * 100
      return Number.isFinite(percent) ? percent : null
    })
    this.previous = next
    return result
  }
}
