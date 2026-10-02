import { expect, it } from 'vitest'
import { CodexProjection, displayCommand } from './projection'

it('shows the command a shell wrapper runs', () => {
  expect(displayCommand("/bin/bash -lc 'npm test'")).toBe('npm test')
  expect(displayCommand("/bin/zsh -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'")
  expect(displayCommand('ls -la')).toBe('ls -la')
})

it('folds Codex items and deltas into conversation nodes', () => {
  const projection = new CodexProjection()
  projection.item(
    {
      type: 'userMessage',
      id: 'u1',
      content: [
        { type: 'text', text: 'fix it' },
        { type: 'localImage', path: '/x.png' }
      ]
    },
    true
  )
  projection.item({ type: 'agentMessage', id: 'a1', text: '' }, false)
  projection.delta('a1', 'assistant', 'Hel')
  projection.delta('a1', 'assistant', 'lo')
  projection.item(
    {
      type: 'commandExecution',
      id: 'c1',
      command: "/bin/bash -lc 'npm test'",
      cwd: '/p',
      status: 'inProgress'
    },
    false
  )
  projection.output('c1', 'ok\n')
  projection.item(
    {
      type: 'fileChange',
      id: 'f1',
      status: 'completed',
      changes: [
        {
          path: 'src/a.ts',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1 +1,2 @@\n-a\n+b\n+c\n'
        }
      ]
    },
    true
  )
  expect(projection.nodes).toMatchObject([
    { type: 'user', text: 'fix it', imageCount: 1 },
    { type: 'assistant', markdown: 'Hello', streaming: true },
    { type: 'tool', title: 'npm test', output: 'ok\n', status: 'running', intent: 'terminal' },
    {
      type: 'tool',
      intent: 'diff',
      title: 'src/a.ts',
      change: { path: 'src/a.ts', kind: 'edit', additions: 2, deletions: 1, anchored: true }
    }
  ])
  projection.item(
    {
      type: 'commandExecution',
      id: 'c1',
      command: 'npm test',
      status: 'completed',
      exitCode: 1,
      aggregatedOutput: 'fail'
    },
    true
  )
  expect(projection.node('c1')).toMatchObject({ status: 'error', output: 'fail' })
  projection.settle()
  expect(projection.node('a1')).not.toHaveProperty('streaming')
})
