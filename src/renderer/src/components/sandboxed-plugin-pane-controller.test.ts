import { describe, expect, it, vi } from 'vitest'
import type { WorkbenchBounds, WorkbenchCommand } from '../../../shared/contracts'
import { createSandboxedPluginPaneController } from './sandboxed-plugin-pane-controller'

type Deferred = {
  promise: Promise<unknown>
  resolve: () => void
  reject: (error: Error) => void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
    resolve = () => resolvePromise(undefined)
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const FIRST_BOUNDS: WorkbenchBounds = { x: 10, y: 20, width: 300, height: 200 }
const SECOND_BOUNDS: WorkbenchBounds = { x: 11, y: 21, width: 301, height: 201 }
const LATEST_BOUNDS: WorkbenchBounds = { x: 12, y: 22, width: 302, height: 202 }

function setup(): {
  controller: ReturnType<typeof createSandboxedPluginPaneController>
  commands: WorkbenchCommand[]
  requests: Deferred[]
  availability: ReturnType<typeof vi.fn>
} {
  const commands: WorkbenchCommand[] = []
  const requests: Deferred[] = []
  const availability = vi.fn()
  const controller = createSandboxedPluginPaneController({
    viewId: 'acme.notes.panel',
    send: (command) => {
      commands.push(command)
      const request = deferred()
      requests.push(request)
      return request.promise
    },
    onUnavailableChange: availability
  })
  return { controller, commands, requests, availability }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('Sandboxed plugin pane command backpressure', () => {
  it('allows only one visible request while retaining the latest bounds', () => {
    const { controller, commands } = setup()

    controller.publish(FIRST_BOUNDS)
    controller.publish(SECOND_BOUNDS)
    controller.publish(LATEST_BOUNDS)

    expect(commands).toEqual([
      {
        type: 'view:set',
        viewId: 'acme.notes.panel',
        visible: true,
        bounds: FIRST_BOUNDS
      }
    ])
  })

  it('sends exactly one latest-bounds follow-up after the active request resolves', async () => {
    const { controller, commands, requests } = setup()
    controller.publish(FIRST_BOUNDS)
    controller.publish(SECOND_BOUNDS)
    controller.publish(LATEST_BOUNDS)

    requests[0]!.resolve()
    await settle()

    expect(commands).toEqual([
      {
        type: 'view:set',
        viewId: 'acme.notes.panel',
        visible: true,
        bounds: FIRST_BOUNDS
      },
      {
        type: 'view:set',
        viewId: 'acme.notes.panel',
        visible: true,
        bounds: LATEST_BOUNDS
      }
    ])
  })

  it('hides immediately and prevents an old completion from publishing again', async () => {
    const { controller, commands, requests, availability } = setup()
    controller.publish(FIRST_BOUNDS)
    controller.publish(LATEST_BOUNDS)

    controller.dispose()
    expect(commands.at(-1)).toEqual({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: false
    })

    requests[0]!.resolve()
    await settle()

    expect(commands).toHaveLength(2)
    expect(availability).not.toHaveBeenCalled()
  })

  it('handles rejection without an unhandled promise and continues with latest bounds', async () => {
    const { controller, commands, requests, availability } = setup()
    controller.publish(FIRST_BOUNDS)
    controller.publish(LATEST_BOUNDS)

    requests[0]!.reject(new Error('/private/plugin/path failed'))
    await settle()

    expect(availability).toHaveBeenCalledWith(true)
    expect(commands.at(-1)).toEqual({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true,
      bounds: LATEST_BOUNDS
    })

    requests[1]!.resolve()
    await settle()
    expect(availability.mock.calls).toEqual([[true], [false]])
  })

  it('suspends with a hide and resumes after ignoring the old completion', async () => {
    const { controller, commands, requests, availability } = setup()
    controller.publish(FIRST_BOUNDS)
    controller.publish(SECOND_BOUNDS)

    controller.suspend()
    expect(commands.at(-1)).toEqual({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: false
    })

    requests[0]!.resolve()
    await settle()
    expect(commands).toHaveLength(2)
    expect(availability).not.toHaveBeenCalled()

    controller.publish(LATEST_BOUNDS)
    expect(commands.at(-1)).toEqual({
      type: 'view:set',
      viewId: 'acme.notes.panel',
      visible: true,
      bounds: LATEST_BOUNDS
    })
  })

  it('resumes immediately while the pre-suspension request never settles', () => {
    const { controller, commands } = setup()
    controller.publish(FIRST_BOUNDS)

    controller.suspend()
    controller.publish(LATEST_BOUNDS)

    expect(commands).toEqual([
      {
        type: 'view:set',
        viewId: 'acme.notes.panel',
        visible: true,
        bounds: FIRST_BOUNDS
      },
      { type: 'view:set', viewId: 'acme.notes.panel', visible: false },
      {
        type: 'view:set',
        viewId: 'acme.notes.panel',
        visible: true,
        bounds: LATEST_BOUNDS
      }
    ])
  })

  it('coalesces repeated suspension into one best-effort hide', () => {
    const { controller, commands } = setup()
    controller.publish(FIRST_BOUNDS)

    controller.suspend()
    controller.suspend()

    expect(
      commands.filter((command) => command.type === 'view:set' && command.visible === false)
    ).toHaveLength(1)
  })

  it('keeps disposal terminal after suspension', () => {
    const { controller, commands } = setup()
    controller.publish(FIRST_BOUNDS)
    controller.suspend()

    controller.dispose()
    controller.publish(LATEST_BOUNDS)

    expect(commands).toHaveLength(2)
    expect(commands.at(-1)).toMatchObject({ type: 'view:set', visible: false })
  })
})
