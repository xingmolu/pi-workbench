import { expect, it } from 'vitest'
import { ProcessCpuSampler } from './process-cpu-sampler'

const metric = (cpu?: number, pid = 7, creationTime = 1) => ({
  pid,
  creationTime,
  cpu: { cumulativeCPUUsage: cpu }
})
it('reports core-equivalent 100% and 300% from cumulative seconds', () => {
  const sampler = new ProcessCpuSampler()
  expect(sampler.sample([metric(2)], 1000)).toEqual([null])
  expect(sampler.sample([metric(3)], 2000)).toEqual([100])
  expect(sampler.sample([metric(9)], 4000)).toEqual([300])
})
it('fences PID reuse and prunes exited processes', () => {
  const sampler = new ProcessCpuSampler()
  sampler.sample([metric(2)], 1000)
  expect(sampler.sample([metric(3, 7, 2)], 2000)).toEqual([null])
  sampler.sample([], 3000)
  expect(sampler.sample([metric(4, 7, 2)], 4000)).toEqual([null])
})
it('treats missing, invalid, reset counters and nonpositive elapsed as unavailable', () => {
  const sampler = new ProcessCpuSampler()
  for (const value of [undefined, NaN, Infinity, -1]) {
    sampler.sample([metric(2)], 1000)
    expect(sampler.sample([metric(value)], 2000)).toEqual([null])
    expect(sampler.sample([metric(3)], 3000)).toEqual([null])
  }
  expect(sampler.sample([metric(1)], 4000)).toEqual([null])
  expect(sampler.sample([metric(2)], 4000)).toEqual([null])
  expect(sampler.sample([metric(3)], 3000)).toEqual([null])
})
