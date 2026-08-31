/**
 * Agent Host — Electron Node `utilityProcess`.
 *
 * Engine (not wired in this scaffold): `@earendil-works/pi-coding-agent`.
 * This process will later call:
 *
 *   import { createAgentSession } from '@earendil-works/pi-coding-agent'
 *   await createAgentSession({ agentDir: '~/.pi/agent' })
 *
 * Do not import the Pi SDK from the renderer.
 * Do not load DSH Web UI. Do not fork dsh-desktop.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

const AGENT_DIR = join(homedir(), '.pi', 'agent')
const ENGINE = '@earendil-works/pi-coding-agent'

type HostMessage = {
  type?: string
}

function send(message: Record<string, unknown>): void {
  process.parentPort.postMessage(message)
}

process.parentPort.on('message', (event) => {
  const data = (event.data ?? {}) as HostMessage
  if (data.type === 'ping' || data.type === 'bootstrap') {
    send({
      type: 'ready',
      stub: true,
      engine: ENGINE,
      agentDir: AGENT_DIR
    })
  }
})

send({
  type: 'ready',
  stub: true,
  engine: ENGINE,
  agentDir: AGENT_DIR
})
