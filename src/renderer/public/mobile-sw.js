/* Pi 远程对话 service worker: an offline shell and notification clicks. Never caches /api. */
'use strict'
const CACHE = 'pi-mobile-v1'
const OFFLINE =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Pi 远程对话</title><body style="font:15px -apple-system,system-ui,sans-serif;padding:32px;color:#888">' +
  '暂时连不上电脑。请确认 Pi Desktop 正在运行、手机网关已开启，并且手机与电脑在同一网络或已连接 Tailscale。</body>'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key)
      await self.clients.claim()
    })()
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // Hashed build files never change under the same name.
  if (url.pathname.startsWith('/assets/') || url.pathname === '/icon.png') {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(request)
        if (hit) return hit
        const response = await fetch(request)
        if (response.ok) await cache.put(request, response.clone())
        return response
      })
    )
    return
  }
  // The page itself: always fresh when online, the last copy when not.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) await (await caches.open(CACHE)).put('/', response.clone())
          return response
        })
        .catch(
          async () =>
            (await caches.match('/')) ||
            new Response(OFFLINE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
        )
    )
  }
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue
        await client.focus()
        if (client.url !== target && 'navigate' in client) await client.navigate(target)
        return
      }
      await self.clients.openWindow(target)
    })()
  )
})
