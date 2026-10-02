import { expect, it } from 'vitest'
import { explain } from './host'

it('turns engine errors into steps a user can take', () => {
  expect(explain(new Error('unexpected status 401 Unauthorized'))).toMatch(
    /^ChatGPT 登录已失效，请在「设置 › 引擎与账号」重新登录/
  )
  expect(explain('stream disconnected before completion: error sending request')).toMatch(
    /^连不上模型服务，请检查网络或代理后重试/
  )
  expect(explain(new Error('这个 ChatGPT 账号已不在 Pi 中'))).toBe('这个 ChatGPT 账号已不在 Pi 中')
  expect(explain('model overloaded')).toBe('model overloaded')
})
