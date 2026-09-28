import { useCallback, useState } from 'react'

const KEY = 'pi-mobile-notify'
export type NotifyState = 'unsupported' | 'off' | 'on' | 'denied'

/** Browsers only offer notifications on HTTPS (e.g. Tailscale Serve) or localhost. */
const supported = (): boolean => 'Notification' in window && window.isSecureContext

function current(): NotifyState {
  if (!supported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  let wanted = false
  try {
    wanted = localStorage.getItem(KEY) === '1'
  } catch {
    /* Treated as off. */
  }
  return Notification.permission === 'granted' && wanted ? 'on' : 'off'
}

export function useNotifications(): { state: NotifyState; toggle: () => Promise<void> } {
  const [state, setState] = useState(current)
  const toggle = useCallback(async () => {
    if (!supported()) return
    const next = current() === 'on' ? false : (await Notification.requestPermission()) === 'granted'
    try {
      localStorage.setItem(KEY, next ? '1' : '0')
    } catch {
      /* Applies to this visit only. */
    }
    setState(current())
  }, [])
  return { state, toggle }
}

/**
 * Tells a reader who switched away that the session needs them. Only while the page is alive
 * in the background: closed pages would need Web Push through an internet push service.
 */
export async function notifyInBackground(title: string, body: string, tag: string): Promise<void> {
  if (!document.hidden || current() !== 'on') return
  const options: NotificationOptions = {
    body,
    tag,
    data: { url: location.href },
    icon: '/icon.png'
  }
  try {
    const registration = await navigator.serviceWorker?.getRegistration()
    if (registration) await registration.showNotification(title, options)
    else new Notification(title, options)
  } catch {
    /* Some browsers only allow notifications from a service worker; nothing else to try. */
  }
}

/** Offline shell and installability. Service workers need a secure context too. */
export function registerServiceWorker(): void {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return
  void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {})
}
