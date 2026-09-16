/* Web Push client helper. Registers the service worker and manages the
   browser push subscription lifecycle against /api/notifications/push/*. */

const PushClient = (() => {
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  function isIos() {
    return /iP(hone|ad|od)/.test(navigator.userAgent || '');
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      return await navigator.serviceWorker.register('/service-worker.js');
    } catch (e) {
      console.warn('Service worker registration failed', e);
      return null;
    }
  }

  async function isSupported() {
    if (!('serviceWorker' in navigator)) return false;
    if (!('PushManager' in window)) return false;
    return true;
  }

  /**
   * Human-readable reason when push cannot work in this browser. Web Push
   * requires Chrome/Edge/Samsung Internet etc. -- Apple Safari (including iOS)
   * does not expose the Push API, so those devices should rely on email.
   */
  async function unsupportedReason() {
    if (!('serviceWorker' in navigator)) return 'Web push is not supported by this browser.';
    if (!('PushManager' in window)) {
      if (isIos()) return 'Web push is not available on iPhone/iPad browsers. Memo emails are still delivered to your inbox — check the email linked to your account.';
      return 'Web push is not available in this browser. Use Chrome or Edge on Android/desktop.';
    }
    return null;
  }

  /**
   * Prompts for push permission and subscribes. Returns { ok, reason }.
   * Triggers a gentle bell-swing animation (via callback) on success, to
   * confirm the setup visually without being flashy or continuous.
   */
  async function enable(onSwing) {
    if (!(await isSupported())) {
      return { ok: false, reason: await unsupportedReason() };
    }

    const { publicKey, configured } = await Api.get('/api/notifications/push/public-key');
    if (!configured) {
      return { ok: false, reason: 'Push notifications are not yet configured by the administrator. Memo emails are still delivered to your inbox.' };
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return { ok: false, reason: 'Notification permission was not granted. You can try again anytime from Settings.' };
    }

    const reg = await registerServiceWorker();
    if (!reg) return { ok: false, reason: 'Could not register the service worker. Please reload the page and try again.' };

    try {
      const existing = await reg.pushManager.getSubscription();
      const sub = existing || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await Api.post('/api/notifications/push/subscribe', sub.toJSON());
      if (typeof onSwing === 'function') onSwing();
      return { ok: true };
    } catch (e) {
      console.warn('Push subscription failed', e);
      return { ok: false, reason: 'Could not complete the push subscription. Please try again from Settings.' };
    }
  }

  async function disable() {
    if (!(await isSupported())) return;
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await Api.post('/api/notifications/push/unsubscribe', { endpoint: sub.endpoint });
        await sub.unsubscribe();
      } else {
        await Api.post('/api/notifications/push/unsubscribe', {});
      }
    } catch (e) {
      console.warn('Push unsubscribe failed', e);
    }
  }

  /**
   * Re-registers an already-working device with the server, without asking the
   * user for anything. The browser keeps its PushManager subscription across
   * sign-outs, server redeploys/database restores and service-worker updates,
   * but the server only knows about a device while a matching
   * push_subscriptions row exists. Whenever that row is lost (host redeploy or
   * database restore, a pruned endpoint, a replacement server instance) push
   * silently stops for that user while the UI still shows notifications as
   * "on" -- so every page load hands the existing subscription back. It is an
   * idempotent upsert, so repeat calls are harmless.
   *
   * Turning web push OFF removes the browser subscription as well (see
   * disable()), so a user who opted out on this device has nothing left to
   * sync and is never silently re-enabled.
   *
   * Returns true when the server now has this device registered.
   */
  async function syncSubscription() {
    try {
      if (!(await isSupported())) return false;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return false;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return false;
      await Api.post('/api/notifications/push/subscribe', sub.toJSON());
      return true;
    } catch (e) {
      console.warn('Push subscription sync failed', e);
      return false;
    }
  }

  return { registerServiceWorker, isSupported, unsupportedReason, enable, disable, syncSubscription };
})();
