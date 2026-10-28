/* JLMirror service worker — handles Web Push notifications */

self.addEventListener("push", (event) => {
  const showNotification = (title, body, url) => {
    return self.registration.showNotification(title, {
      body: body || "Nova notificação",
      icon: "/logo.svg",
      badge: "/logo.svg",
      data: { url: url || "/" },
      vibrate: [200, 100, 200],
    });
  };

  if (!event.data) {
    // Trigger-only push: fetch latest notification from API
    event.waitUntil(
      fetch("/api/v1/push/latest", { credentials: "include" })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then(({ title, body, url }) => showNotification(title, body, url))
        .catch(() => showNotification("JLMirror", "Nova notificação", "/"))
    );
    return;
  }

  try {
    const data = event.data.json();
    event.waitUntil(
      showNotification(data.title || "JLMirror", data.body, data.url)
    );
  } catch {
    event.waitUntil(showNotification("JLMirror", "Nova notificação", "/"));
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if (client.url === url && "focus" in client) return client.focus();
        }
        if (clients.openWindow) return clients.openWindow(url);
      })
  );
});
