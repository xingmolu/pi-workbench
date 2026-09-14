import { expect, it } from 'vitest'
import { GlobalConfigurationGate } from './global-configuration-gate'

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
