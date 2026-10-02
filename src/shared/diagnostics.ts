export const DIAGNOSTICS_CHANNEL = 'pi:diagnostics'

export type DiagnosticsCommand = { type: 'summary' } | { type: 'export' } | { type: 'open-folder' }

export type DiagnosticsResult<Command extends DiagnosticsCommand> = Command extends {
  type: 'summary'
}
  ? { crashes: number; directory: string }
  : Command extends { type: 'export' }
    ? { saved: string } | { cancelled: true }
    : { opened: true }
