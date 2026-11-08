const C = "aurum-v1", SHELL = ["/", "/index.html", "/shim.js", "/standalone.js", "/lw.js", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.pathname.startsWith("/api/") || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match("/index.html"))));
});
self.addEventListener("push", e => {
  let d = {}; try{ d = e.data.json(); }catch(_){ d = {title:"AURUM", body: e.data && e.data.text()}; }
  e.waitUntil(self.registration.showNotification(d.title || "AURUM", {body: d.body || "", icon: "/icon-192.png", badge: "/icon-192.png", tag: d.tag || "aurum", renotify: true, vibrate: [200, 100, 200], data: {url: d.url || "/"}}));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({type:"window", includeUncontrolled:true}).then(ws => { for (const w of ws){ if ("focus" in w) return w.focus(); } return clients.openWindow(e.notification.data.url || "/"); }));
});
