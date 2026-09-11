import { useLayoutEffect, useRef, useState } from 'react'

export async function writeMarkdownClipboard(
  text: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined
): Promise<boolean> {
  try {
    if (!clipboard) return false
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function useMarkdownCopy(epoch: string): {
  status: 'idle' | 'pending' | 'success' | 'error'
  copy: (text: string) => Promise<void>
} {
  const [status, setStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle')
  const request = useRef(0)
  const pending = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useLayoutEffect(() => {
    request.current++
    pending.current = false
    setStatus('idle')
    return () => {
      request.current++
      clearTimeout(timer.current)
    }
  }, [epoch])
  return {
    status,
    copy: async (text) => {
      if (pending.current) return
      pending.current = true
      clearTimeout(timer.current)
      const id = ++request.current
      setStatus('pending')
      try {
        const copied = await writeMarkdownClipboard(text, navigator.clipboard)
        if (id !== request.current) return
        if (!copied) {
          setStatus('error')
          return
        }
        setStatus('success')
        timer.current = setTimeout(() => setStatus('idle'), 2000)
      } catch {
        if (id === request.current) setStatus('error')
      } finally {
        if (id === request.current) pending.current = false
      }
    }
  }
}
