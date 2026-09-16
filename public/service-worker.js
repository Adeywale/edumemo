/* EduMemo Service Worker: displays incoming Web Push notifications and
   routes clicks to the relevant memo. */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch (e) { payload = { title: 'New Memo', body: event.data.text() }; }

  const title = payload.title || 'New Memo';
  // A `tag` collapses notifications for the same memo so the user never sees
  // duplicates when a memo is re-published or resent. `memoId` makes the tag
  // unique per memo rather than per delivery attempt.
  const memoId = payload.memoId || payload.url || title;
  const options = {
    body: payload.body || 'A new memo has been published.',
    icon: '/images/icon-192.png',
    badge: '/images/icon-192.png',
    tag: `memo-${memoId}`,
    data: { url: payload.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
