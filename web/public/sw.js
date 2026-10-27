// Service worker: makes the app installable, opens offline to the app shell, shows notifications.
const SHELL = "orc-shell-v2";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png"])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// Pages: network first (always the newest app), cached shell when the hub is unreachable.
// API calls are never cached: they must be live.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || /^\/(api|v1|node)\//.test(url.pathname)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && (e.request.mode === "navigate" || url.pathname.startsWith("/assets/"))) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(e.request.mode === "navigate" ? "/" : e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request.mode === "navigate" ? "/" : e.request).then((r) => r || Response.error())),
  );
});

self.addEventListener("push", (e) => {
  let p = { title: "Orchestrator", body: "", url: "/", tag: "orc" };
  try {
    p = { ...p, ...e.data.json() };
  } catch {
    /* not JSON: show the defaults */
  }
  e.waitUntil(self.registration.showNotification(p.title, { body: p.body, tag: p.tag, icon: "/icon-192.png", badge: "/badge-96.png", data: { url: p.url } }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => w.url.startsWith(location.origin));
      if (win) return win.navigate(url).then((w) => (w || win).focus());
      return self.clients.openWindow(url);
    }),
  );
});
