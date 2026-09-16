import type { ComponentProps } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'

// shadcn Resizable composition, using the application's existing CSS tokens.
export function ResizablePanelGroup(props: ComponentProps<typeof Group>): React.JSX.Element {
  return <Group data-slot="resizable-panel-group" {...props} />
}
export function ResizablePanel(props: ComponentProps<typeof Panel>): React.JSX.Element {
  return <Panel data-slot="resizable-panel" {...props} />
}
export function ResizableHandle(props: ComponentProps<typeof Separator>): React.JSX.Element {
  return <Separator data-slot="resizable-handle" {...props} />
}
