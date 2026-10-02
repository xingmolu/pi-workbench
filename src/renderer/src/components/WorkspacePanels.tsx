import { useNavigationLibrary } from '../store/navigation-library'
import { performNavigationAction } from '../store/navigation-feedback'
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './Resizable'
import { t } from '../../../shared/i18n'
import '../assets/workspace-panels.css'

const ResizeContext = createContext(false)
export const useWorkspaceResizing = (): boolean => useContext(ResizeContext)

export default function WorkspacePanels({
  collapsed,
  conversation,
  workbench
}: {
  collapsed: boolean
  conversation: ReactNode
  workbench: ReactNode
}): React.JSX.Element {
  const panel = useRef<PanelImperativeHandle | null>(null)
  const group = useRef<HTMLDivElement | null>(null)
  const separator = useRef<HTMLDivElement | null>(null)
  const storedWidth = useNavigationLibrary((state) => state.library.layout.workbenchWidth ?? 440)
  const expandedWidth = useRef(storedWidth)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    expandedWidth.current = storedWidth
  }, [storedWidth])
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    },
    []
  )
  const [resizing, setResizing] = useState(false)
  useLayoutEffect(() => {
    // Panel constraints are registered by the library during this layout commit.
    // Apply the remembered size after that registration has settled.
    const frame = requestAnimationFrame(() => {
      panel.current?.resize(collapsed ? '0px' : `${expandedWidth.current}px`)
    })
    return () => cancelAnimationFrame(frame)
  }, [collapsed])
  useEffect(() => {
    const finish = (): void => setResizing(false)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
    }
  }, [])

  return (
    <ResizeContext.Provider value={resizing}>
      <ResizablePanelGroup
        className={`workspace-panels${collapsed ? ' is-workbench-collapsed' : ''}`}
        orientation="horizontal"
        resizeTargetMinimumSize={{ fine: 10, coarse: 20 }}
        elementRef={group}
        onLayoutChanged={(layout, { isUserInteraction }) => {
          // The callback can precede React's DOM commit, so getSize() can still
          // report the previous pixels. Convert the supplied, committed layout.
          if (!collapsed && isUserInteraction && group.current && separator.current) {
            expandedWidth.current =
              (layout.workbench / 100) * (group.current.clientWidth - separator.current.offsetWidth)
            if (saveTimer.current) clearTimeout(saveTimer.current)
            saveTimer.current = setTimeout(() => {
              const width = Math.round(Math.min(1200, Math.max(252, expandedWidth.current)))
              void performNavigationAction({
                type: 'layout:save',
                layout: { workbenchWidth: width }
              })
            }, 350)
          }
        }}
      >
        <ResizablePanel id="conversation" minSize="420px" className="conversation-panel">
          {conversation}
        </ResizablePanel>
        <ResizableHandle
          className="workspace-resize-handle"
          elementRef={separator}
          aria-label={t('调整工作台宽度')}
          disabled={collapsed}
          onPointerDownCapture={() => {
            if (!collapsed) setResizing(true)
          }}
        />
        <ResizablePanel
          id="workbench"
          panelRef={panel}
          defaultSize="0px"
          minSize={collapsed ? '0px' : '252px'}
          maxSize={collapsed ? '0px' : '65%'}
          groupResizeBehavior="preserve-pixel-size"
          className="workbench-panel"
        >
          {workbench}
        </ResizablePanel>
      </ResizablePanelGroup>
    </ResizeContext.Provider>
  )
}
