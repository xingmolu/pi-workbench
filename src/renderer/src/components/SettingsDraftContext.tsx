import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { t } from '../../../shared/i18n'

type SettingsDraftContextValue = {
  dirty: boolean
  report: (source: string, dirty: boolean) => void
  clear: () => void
}

const SettingsDraftContext = createContext<SettingsDraftContextValue | null>(null)

export const SETTINGS_DISCARD_MESSAGE = t(
  '当前页面有未保存修改。离开后这些修改会丢失，确定继续吗？'
)

export function confirmDiscardSettingsDraft(dirty: boolean): boolean {
  return !dirty || window.confirm(SETTINGS_DISCARD_MESSAGE)
}

export function SettingsDraftProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const sources = useRef(new Set<string>())
  const [dirty, setDirty] = useState(false)

  const report = useCallback((source: string, nextDirty: boolean): void => {
    if (nextDirty) sources.current.add(source)
    else sources.current.delete(source)
    setDirty(sources.current.size > 0)
  }, [])

  const clear = useCallback((): void => {
    sources.current.clear()
    setDirty(false)
  }, [])

  const value = useMemo(() => ({ dirty, report, clear }), [clear, dirty, report])

  return <SettingsDraftContext.Provider value={value}>{children}</SettingsDraftContext.Provider>
}

export function useSettingsDraft(source: string, dirty: boolean): void {
  const report = useContext(SettingsDraftContext)?.report
  useEffect(() => {
    if (!report) return
    report(source, dirty)
    return () => report(source, false)
  }, [dirty, report, source])
}

export function useSettingsDraftController(): SettingsDraftContextValue | null {
  return useContext(SettingsDraftContext)
}
