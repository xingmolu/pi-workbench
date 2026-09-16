import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { DesktopControlPanel } from './DesktopControlSettings'
import type { DesktopControlPermission } from '../../../shared/desktop-control'

const unsupported: DesktopControlPermission = {
  platformSupported: false,
  mediaAccessStatus: 'unavailable',
  access: 'unsupported',
  canCapture: false,
  canOpenSettings: false
}

function render(patch: Partial<ComponentProps<typeof DesktopControlPanel>> = {}): string {
  return renderToStaticMarkup(
    <DesktopControlPanel
      permission={unsupported}
      sources={[]}
      truncated={false}
      probed={false}
      message={null}
      pending={null}
      error={null}
      onRefresh={() => undefined}
      onOpenSettings={() => undefined}
      {...patch}
    />
  )
}

it('shows the four permission chips and macOS-only copy', () => {
  expect(render()).toContain('不支持')
  expect(render()).toContain('打开系统设置（屏幕录制）')
  expect(render()).toContain('刷新 / 试截取')
  expect(render()).toContain('辅助功能')
  expect(render()).toContain('adhoc')
  expect(
    render({ permission: { ...unsupported, access: 'granted', canOpenSettings: true } })
  ).toContain('已授权')
  expect(render({ permission: { ...unsupported, access: 'denied' } })).toContain('未授权')
  expect(render({ permission: { ...unsupported, access: 'restricted' } })).toContain('受限')
  expect(render()).toContain('disabled=""')
})

it('renders a bounded thumbnail gallery after a successful probe', () => {
  const html = render({
    permission: {
      platformSupported: true,
      mediaAccessStatus: 'granted',
      access: 'granted',
      canCapture: true,
      canOpenSettings: true
    },
    probed: true,
    sources: [
      {
        id: 'screen:0:0',
        name: 'Built-in Retina Display',
        type: 'screen',
        thumbnailDataUrl: 'data:image/png;base64,AAAA'
      },
      { id: 'window:1:0', name: 'Finder', type: 'window', thumbnailDataUrl: '' }
    ]
  })
  expect(html).toContain('已授权')
  expect(html).toContain('Built-in Retina Display')
  expect(html).toContain('data:image/png;base64,AAAA')
  expect(html).toContain('Finder')
  expect(html).toContain('无缩略图')
  expect(html).toContain('屏幕')
  expect(html).toContain('窗口')
})

it('explains denied and empty probe states without inventing sources', () => {
  const html = render({
    permission: {
      platformSupported: true,
      mediaAccessStatus: 'denied',
      access: 'denied',
      canCapture: false,
      canOpenSettings: true
    },
    probed: true,
    message: '尚未授权屏幕录制，无法列出屏幕或窗口。'
  })
  expect(html).toContain('未授权')
  expect(html).toContain('尚未授权屏幕录制，无法列出屏幕或窗口。')
  expect(html).not.toContain('desktop-control-gallery')
})
