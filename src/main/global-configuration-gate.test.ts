import { expect, it } from 'vitest'
import { GlobalConfigurationGate } from './global-configuration-gate'
import { HostResponseBroker, HostRejectedError } from './host-response-broker'

it('refuses writes while another session is active and rejects simultaneous configuration operations', async () => {
  let idle = false
  const gate = new GlobalConfigurationGate(() => idle)
  let writes = 0
  await expect(
    gate.run(async () => {
      writes++
    })
  ).rejects.toThrow('所有会话')
  expect(writes).toBe(0)
  idle = true
  let finish!: () => void
  const pending = gate.run(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  expect(gate.busy).toBe(true)
  await expect(
    gate.run(async () => {
      writes++
    })
  ).rejects.toThrow('正在更新')
  finish()
  await pending
  expect(gate.busy).toBe(false)
  expect(writes).toBe(0)
})

it('retains a timed-out lobby operation until that owner actually exits', async () => {
  const gate = new GlobalConfigurationGate(() => true)
  const broker = new HostResponseBroker({ timeoutMs: 1 })
  await expect(
    gate.run(async () => {
      try {
        await broker.request({ type: 'runtime:refresh' }, () => {})
      } catch (error) {
        gate.recordFailure('lobby', error)
        throw error
      }
    })
  ).rejects.toThrow('请求超时')
  expect(gate.busy).toBe(true)
  await expect(gate.run(async () => {})).rejects.toThrow('完成状态未确认')
  gate.ownerExited('different-worker')
  await expect(gate.run(async () => {})).rejects.toThrow('完成状态未确认')
  gate.ownerExited('lobby')
  await expect(gate.run(async () => {})).resolves.toBeUndefined()
})

it('does not retain a completed lobby rejection as uncertain ownership', async () => {
  const gate = new GlobalConfigurationGate(() => true)
  gate.recordFailure('lobby', new HostRejectedError('配置无效'))
  expect(gate.busy).toBe(false)
  await expect(gate.run(async () => 'ready')).resolves.toBe('ready')
})
