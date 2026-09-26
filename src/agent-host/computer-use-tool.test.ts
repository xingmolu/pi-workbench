import { describe, expect, it } from 'vitest'
import { stream } from '@earendil-works/pi-ai/api/anthropic-messages'
import type { Model } from '@earendil-works/pi-ai'
import { COMPUTER_USE_TOOL_PARAMETERS } from './computer-use-tool'
import { computerUseOperationSchema } from '../shared/computer-use'

const model: Model<'anthropic-messages'> = {
  id: 'glm-5.3',
  name: 'GLM test',
  api: 'anthropic-messages',
  provider: 'fixture',
  baseUrl: 'https://fixture.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32000,
  maxTokens: 1024
}

describe('computer tool provider contract', () => {
  it('preserves action and operation fields in the actual Anthropic-compatible request', async () => {
    let payload: unknown
    const result = await stream(
      model,
      {
        messages: [{ role: 'user', content: 'Observe the desktop', timestamp: 0 }],
        tools: [
          {
            name: 'computer',
            description: 'Desktop control',
            parameters: COMPUTER_USE_TOOL_PARAMETERS
          }
        ]
      },
      {
        apiKey: 'offline-fixture',
        onPayload: (value) => {
          payload = value
          throw new Error('captured-before-network')
        },
        fetch: async () => {
          throw new Error('Network must not be used')
        }
      }
    ).result()
    expect(result.errorMessage).toContain('captured-before-network')
    expect(payload).toMatchObject({
      tools: [
        {
          name: 'computer',
          input_schema: {
            type: 'object',
            required: ['action'],
            properties: {
              action: expect.any(Object),
              stateId: expect.any(Object),
              target: expect.any(Object),
              intent: expect.any(Object)
            }
          }
        }
      ]
    })
  })

  it('keeps host validation strict for incomplete or unrelated operations', () => {
    for (const operation of [
      {},
      { action: 'act' },
      { action: 'search', query: 'button' },
      { action: 'inspect', stateId: 's' },
      { action: 'observe', text: 'unexpected' }
    ]) {
      expect(computerUseOperationSchema.safeParse(operation).success).toBe(false)
    }
    expect(computerUseOperationSchema.parse({ action: 'observe' })).toEqual({ action: 'observe' })
  })
})
