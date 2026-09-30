import { expect, it } from 'vitest'
import type { ConversationNode } from '../../../shared/contracts'
import type { LiveSessionSummary } from '../../../shared/session-runtime'
import { conversationSubagents } from './subagent-presentation'

const spawn: ConversationNode = {
  type: 'tool',
  id: 'spawn',
  toolCallId: 'spawn',
  name: 'session_task',
  title: 'spawn',
  intent: 'generic',
  status: 'success',
  subagent: {
    operation: 'spawn',
    children: [
      {
        id: 'task',
        title: 'Review auth',
        prompt: 'Review auth carefully',
        state: 'running',
        workerId: 'worker',
        sessionId: 'session',
        generation: 1
      }
    ]
  }
}
const resident: LiveSessionSummary = {
  workerId: 'worker',
  cwd: '/project',
  sessionPath: '/session',
  sessionId: 'session',
  generation: 1,
  selected: false,
  status: 'running',
  sessionTask: {
    taskId: 'task',
    parentWorkerId: 'parent',
    createdAt: 1,
    progress: {
      id: 'task',
      title: 'subagent',
      state: 'awaiting-approval',
      activity: '等待操作确认'
    }
  }
}

it('keeps child lifecycle independent of successful delegation and uses current approval activity', () => {
  expect(conversationSubagents([spawn], []).get('task')?.state).toBe('running')
  expect(conversationSubagents([spawn], [resident]).get('task')).toMatchObject({
    title: 'Review auth',
    prompt: 'Review auth carefully',
    state: 'awaiting-approval',
    activity: '等待操作确认'
  })
})
it('ignores a reused worker with another native session or generation', () => {
  for (const stale of [
    { ...resident, sessionId: 'another' },
    { ...resident, generation: 2 }
  ])
    expect(conversationSubagents([spawn], [stale]).get('task')?.state).toBe('unavailable')
})
it('preserves SDK-native running and approval states independently of desktop residents', () => {
  for (const state of ['running', 'awaiting-approval'] as const) {
    const native: ConversationNode = {
      ...spawn,
      subagent: {
        operation: 'spawn',
        children: [
          {
            id: 'native-task',
            title: 'Native review',
            workerId: 'sdk-tool-use-id',
            sessionId: 'parent',
            state
          }
        ]
      }
    }
    expect(conversationSubagents([native], [resident]).get('native-task')?.state).toBe(state)
  }
})
it('preserves collected full results across live preview truncation and loses stale results on follow-up work', () => {
  const collect: ConversationNode = {
    ...spawn,
    id: 'collect',
    subagent: {
      operation: 'collect',
      children: [{ id: 'task', title: '子 Agent', state: 'success', output: 'FULL RESULT' }]
    }
  }
  const live: LiveSessionSummary = {
    ...resident,
    sessionTask: {
      ...resident.sessionTask!,
      progress: { id: 'task', title: '子 Agent', state: 'success', output: 'FULL', truncated: true }
    }
  }
  expect(conversationSubagents([spawn, collect], [live]).get('task')).toMatchObject({
    title: 'Review auth',
    output: 'FULL RESULT'
  })
  live.sessionTask!.progress = {
    id: 'task',
    title: '子 Agent',
    state: 'running',
    activity: 'Searching'
  }
  expect(conversationSubagents([spawn, collect], [live]).get('task')?.output).toBeUndefined()
  expect(conversationSubagents([spawn, collect], []).get('task')?.output).toBe('FULL RESULT')
})
