import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ProjectSessionList from './ProjectSessionList'
import { EMPTY_SNAPSHOT } from '../store/pi-store'

it('shows a truthful catalog loading state without inventing project history', () => {
  const html = renderToStaticMarkup(
    <ProjectSessionList snapshot={EMPTY_SNAPSHOT} onNavigate={() => {}} />
  )
  expect(html).toContain('正在读取项目目录')
  expect(html).toContain('搜索已加载会话')
  expect(html).not.toContain('空闲')
})
