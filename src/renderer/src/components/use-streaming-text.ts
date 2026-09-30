import { useEffect, useRef, useState } from 'react'

/** Coalesce live text without delaying the final answer or leaking a previous message. */
export function useStreamingText(text: string, identity: string, streaming: boolean): string {
  const [visible, setVisible] = useState({ identity, text })
  const latest = useRef({ identity, text })
  latest.current = { identity, text }
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (!streaming) {
      clearTimeout(timer.current)
      timer.current = undefined
      setVisible(latest.current)
    } else if (timer.current === undefined) {
      timer.current = setTimeout(
        () => {
          timer.current = undefined
          setVisible(latest.current)
        },
        text.length > 32 * 1024 ? 500 : text.length > 8 * 1024 ? 240 : 80
      )
    }
  }, [text, identity, streaming])
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      timer.current = undefined
    },
    [identity]
  )
  return !streaming || visible.identity !== identity || !text.startsWith(visible.text)
    ? text
    : visible.text
}
