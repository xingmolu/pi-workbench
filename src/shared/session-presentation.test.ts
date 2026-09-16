import { describe, expect, it } from 'vitest'
import {
  activeSessionHeader,
  activeSessionTitle,
  canCreateSession,
  projectedSessionStatus,
  projectSessionTitle,
  sessionStatusDisplay
} from './session-presentation'

describe('canCreateSession', () => {
  it('enables both sidebar variants only when a project is open', () => {
    expect(canCreateSession(null)).toBe(false)
    expect(canCreateSession({ path: '/tmp/project', name: 'project' })).toBe(true)
  })
})

describe('projectSessionTitle', () => {
  it('uses a short first line for automatic titles', () => {
    expect(
      projectSessionTitle({ firstMessage: '打包验收：跨模型上下文\n不要调用工具，详细测试要求' })
    ).toBe('打包验收：跨模型上下文')
    expect(
      [...projectSessionTitle({ firstMessage: '中文🙂'.repeat(60) })].length
    ).toBeLessThanOrEqual(49)
  })
  it('uses the first message when an old session still has the placeholder name', () => {
    expect(
      projectSessionTitle({ name: '新会话', firstMessage: 'Fix the project restore race' })
    ).toBe('Fix the project restore race')
  })

  it('preserves a user-defined session name', () => {
    expect(projectSessionTitle({ name: '启动性能优化', firstMessage: '检查首屏加载' })).toBe(
      '启动性能优化'
    )
  })

  it.each(['(no messages)', '   '])(
    'keeps the new-session title for an empty legacy first message: %j',
    (firstMessage) => {
      expect(projectSessionTitle({ name: '新会话', firstMessage })).toBe('新会话')
      expect(projectSessionTitle({ firstMessage })).toBe('新会话')
    }
  )
})

describe('activeSessionTitle', () => {
  it('shows a transient new-session title until Pi persists the session', () => {
    expect(activeSessionTitle(null, [])).toBe('新会话')
  })

  it('uses the active persisted session title', () => {
    expect(
      activeSessionTitle('/sessions/active.jsonl', [
        {
          id: 'other',
          path: '/sessions/other.jsonl',
          title: '其他会话',
          modified: '2026-09-01T00:00:00.000Z',
          messageCount: 1,
          active: false,
          status: 'idle'
        },
        {
          id: 'active',
          path: '/sessions/active.jsonl',
          title: '恢复项目',
          modified: '2026-09-01T00:00:00.000Z',
          messageCount: 1,
          active: true,
          status: 'running'
        }
      ])
    ).toBe('恢复项目')
  })
})

describe('activeSessionHeader', () => {
  it('shows snapshot status for an unsaved empty active session', () => {
    expect(activeSessionHeader(null, [], 'awaiting-approval')).toEqual({
      title: '新会话',
      status: { tone: 'awaiting-approval', label: '等待确认' }
    })
  })
})

describe('sessionStatusDisplay', () => {
  it.each([
    ['idle', '空闲'],
    ['running', '运行中'],
    ['awaiting-approval', '等待确认'],
    ['error', '出错']
  ] as const)('maps %s to its own visible status label', (status, label) => {
    expect(sessionStatusDisplay(status)).toEqual({ tone: status, label })
  })
})

describe('projectedSessionStatus', () => {
  it('applies the live status only to the active session', () => {
    expect(
      projectedSessionStatus('/sessions/active.jsonl', '/sessions/active.jsonl', 'running')
    ).toBe('running')
    expect(projectedSessionStatus('/sessions/old.jsonl', '/sessions/active.jsonl', 'running')).toBe(
      'idle'
    )
  })
})
