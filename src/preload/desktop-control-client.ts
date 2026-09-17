import {
  desktopControlCommandSchema,
  desktopControlResultSchema,
  type DesktopControlCommand,
  type DesktopControlResult
} from '../shared/desktop-control'

export type DesktopControlTransport = {
  invoke(command: DesktopControlCommand): Promise<unknown>
}

export function createDesktopControlClient(transport: DesktopControlTransport): {
  desktopControl(command: DesktopControlCommand): Promise<DesktopControlResult>
} {
  return {
    async desktopControl(command) {
      const parsed = desktopControlCommandSchema.parse(command)
      return desktopControlResultSchema.parse(await transport.invoke(parsed))
    }
  }
}
