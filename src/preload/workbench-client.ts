import type {
  WorkbenchCommand,
  WorkbenchCommandResult,
  WorkbenchEvent
} from '../shared/workbench-contracts'
import {
  workbenchCommandResultSchema,
  workbenchCommandSchema,
  workbenchEventSchema
} from '../shared/workbench-schemas'

export type WorkbenchTransport = {
  invoke(command: WorkbenchCommand): Promise<unknown>
  onEvent(listener: (event: unknown) => void): () => void
}

export type WorkbenchClient = {
  workbench(command: WorkbenchCommand): Promise<WorkbenchCommandResult>
  onWorkbenchEvent(listener: (event: WorkbenchEvent) => void): () => void
}

export function createWorkbenchClient(transport: WorkbenchTransport): WorkbenchClient {
  return {
    async workbench(command) {
      const parsedCommand = workbenchCommandSchema.safeParse(command)
      if (!parsedCommand.success) throw new Error('Workbench command is invalid')
      try {
        return workbenchCommandResultSchema.parse(await transport.invoke(parsedCommand.data))
      } catch {
        throw new Error('Workbench response is invalid')
      }
    },
    onWorkbenchEvent(listener) {
      return transport.onEvent((value) => {
        const parsed = workbenchEventSchema.safeParse(value)
        if (parsed.success) listener(parsed.data)
      })
    }
  }
}
