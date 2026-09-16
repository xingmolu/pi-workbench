import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ProjectSessionList from './ProjectSessionList'
import { EMPTY_SNAPSHOT } from '../store/pi-store'

const READY_SNAPSHOT = {
  ...EMPTY_SNAPSHOT,
  ready: true,
  project: { path: '/tmp/studio', name: 'studio' },
  sessions: []
}

it('shows a truthful catalog loading state without inventing project history', () => {
  const html = renderToStaticMarkup(
    <ProjectSessionList snapshot={EMPTY_SNAPSHOT} onNavigate={() => {}} />
  )
  expect(html).toContain('正在读取项目目录')
  expect(html).toContain('已加载 0 个项目 · 0 个会话')
  expect(html).not.toContain('搜索已加载会话')
  expect(html).not.toContain('空闲')
})

it('places transient pending in the scope status instead of the persistent blocker paragraph', () => {
  const html = renderToStaticMarkup(
    <ProjectSessionList snapshot={READY_SNAPSHOT} onNavigate={() => {}} pending />
  )
  // Static markup covers status copy only; loaded row behavior and geometry are E2E tested.
  expect(html).not.toContain('catalog-disabled-reason')
  expect(html).toContain('catalog-status')
  expect(html).toContain('正在切换会话')
  expect(html).toContain('aria-busy="true"')
})

it('still explains persistent blockers instead of silently blocking', () => {
  const html = renderToStaticMarkup(
    <ProjectSessionList snapshot={{ ...READY_SNAPSHOT, ready: false }} onNavigate={() => {}} />
  )
  expect(html).toContain('catalog-disabled-reason')
  expect(html).toContain('Pi 引擎未连接')
  expect(html).not.toContain('正在切换会话')
})
