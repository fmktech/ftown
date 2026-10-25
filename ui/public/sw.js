const CACHE_NAME = "ftown-v3";
const APP_SHELL = ["/", "/icon.svg", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/login")) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        if (response.ok && !response.headers.get("Cache-Control")?.includes("no-store")) {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// IndexedDB receipt claims serialize duplicates across worker restarts.
function claimNotification(id) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("ftown-push", 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("receipts")) request.result.createObjectStore("receipts");
      if (!request.result.objectStoreNames.contains("settings")) request.result.createObjectStore("settings");
    };
    request.onerror = () => reject(new Error("Notification storage unavailable"));
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("receipts", "readwrite");
      const receipts = transaction.objectStore("receipts");
      let fresh = false;
      const read = receipts.get(id);
      read.onsuccess = () => { if (!read.result) { receipts.put(true, id); fresh = true; } };
      transaction.oncomplete = () => { db.close(); resolve(fresh); };
      transaction.onerror = () => { db.close(); reject(new Error("Notification storage unavailable")); };
    };
  });
}
function pushOwner(next, write = false) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("ftown-push", 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("receipts")) request.result.createObjectStore("receipts");
      if (!request.result.objectStoreNames.contains("settings")) request.result.createObjectStore("settings");
    };
    request.onerror = () => reject(new Error("Notification storage unavailable"));
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction("settings", write ? "readwrite" : "readonly");
      const store = tx.objectStore("settings"); let owner = null;
      if (write) store.put(next, "owner");
      else { const read = store.get("owner"); read.onsuccess = () => { owner = read.result ?? null; }; }
      tx.oncomplete = () => { db.close(); resolve(owner); };
      tx.onerror = () => { db.close(); reject(new Error("Notification storage unavailable")); };
    };
  });
}
// Serialize display with owner changes: logout closes earlier displays before acknowledgement.
let notificationWork = Promise.resolve();
function serializeNotification(work) {
  const next = notificationWork.then(work, work);
  notificationWork = next.catch(() => {});
  return next;
}
self.addEventListener("message", (event) => {
  if (event.data?.type !== "ftown-push-owner" || !event.source?.url
    || new URL(event.source.url).origin !== self.location.origin
    || (event.data.ownerHash !== null && !/^[a-f0-9]{64}$/.test(event.data.ownerHash))) return;
  event.waitUntil(serializeNotification(() => pushOwner(event.data.ownerHash, true).then(
    async () => {
      if (event.data.ownerHash === null) for (const notification of await self.registration.getNotifications()) notification.close();
      event.ports[0]?.postMessage({ ok: true });
    },
    () => event.ports[0]?.postMessage({ ok: false }),
  )));
});
self.addEventListener("push", (event) => {
  event.waitUntil(serializeNotification(async () => {
    let data;
    try { data = event.data?.json(); } catch { return; }
    if (!data || typeof data.id !== "string" || !/^[a-f0-9]{64}$/.test(data.id)
      || typeof data.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(data.sessionId)) return;
    if (typeof data.ownerHash !== "string" || data.ownerHash !== await pushOwner()) return;
    if (!await claimNotification(data.id)) return;
    await self.registration.showNotification('FTown attention', {
      body: 'Open FTown to view details.', icon: "/icon.svg", tag: `ftown-${data.id}`,
      data: { sessionId: data.sessionId },
    });
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId;
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId)) return;
  event.waitUntil((async () => {
    const url = new URL(`/dashboard?session=${encodeURIComponent(sessionId)}`, self.location.origin).href;
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      if (new URL(existing.url).pathname === "/dashboard") existing.postMessage({ type: "ftown-open-session", sessionId });
      else await existing.navigate(url);
      await existing.focus();
    } else await self.clients.openWindow(url);
  })());
});
