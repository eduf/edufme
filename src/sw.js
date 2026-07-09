// Service worker do eduf.me — só push. Sem cache, sem offline, sem fetch handler.

self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "eduf.me", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "eduf.me", {
      body: data.body || "",
      data: { url: data.url || "https://eduf.me/" }
    })
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
