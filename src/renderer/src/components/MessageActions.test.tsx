import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import MessageActions from './MessageActions'
import { EMPTY_SNAPSHOT } from '../store/pi-store'

it('temporary user content has text copy but no canonical edit action', () => {
  const html = renderToStaticMarkup(createElement(MessageActions, {
    snapshot: EMPTY_SNAPSHOT,
    node: { type:'user', id:'temporary', text:'question' }
  }))
  expect(html).toContain('aria-label="复制问题"')
  expect(html).not.toContain('aria-label="编辑问题"')
})

it('temporary assistant keeps accessible copy and disabled mutation reasons', () => {
  const html = renderToStaticMarkup(createElement(MessageActions, {
    snapshot: {...EMPTY_SNAPSHOT,ready:true,sessionId:'s'},
    node: { type:'assistant', id:'temporary', markdown:'partial',streaming:true }
  }))
  expect(html).toContain('aria-label="复制回复"')
  expect(html).toContain('回复尚未完成，暂时不能记录反馈')
  expect(html).toContain('回复尚未完成，暂时不能分叉')
  expect(html).toContain('aria-pressed="false"')
})
