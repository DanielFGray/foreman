// The service worker: shows the bridge's push alerts (src/server/Push.ts) and
// opens the terminal of one that is tapped (src/page/alerts.ts). It handles
// nothing else, so the page loads from the network as it does without it.

// A new version takes over at once; it keeps no state that an old one needs.
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))

// The payload is the bridge's PushPayload (src/shared/Push.ts).
self.addEventListener("push", (event) => {
  const alert = event.data ? event.data.json() : { title: "herdr", body: "", tag: "herdr", terminal: null }
  event.waitUntil(
    self.registration.showNotification(alert.title, {
      body: alert.body,
      // One slot per terminal: a newer alert replaces the older one, and alerts again.
      tag: alert.tag,
      renotify: true,
      data: { terminal: alert.terminal },
      icon: "/icon-192.png",
    }),
  )
})

// An open page is brought forward and told the terminal; else a page opens on it.
self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const terminal = event.notification.data ? event.notification.data.terminal : null
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      const open = windows.find((client) => client.focused) || windows[0]
      if (open) {
        await open.focus()
        if (terminal) open.postMessage({ terminal })
        return
      }
      await self.clients.openWindow(terminal ? `/?terminal=${encodeURIComponent(terminal)}` : "/")
    })(),
  )
})
