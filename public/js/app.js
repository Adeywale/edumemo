/* Shared app-wide helpers used across every authenticated page. */

const App = (() => {
  function toast(message, type = 'info') {
    let region = document.getElementById('toast-region');
    if (!region) {
      region = document.createElement('div');
      region.id = 'toast-region';
      document.body.appendChild(region);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    region.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function showError(err) {
    toast(err.message || 'Something went wrong.', 'error');
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    const then = new Date(dateStr.replace(' ', 'T') + 'Z');
    const diffMs = Date.now() - then.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return then.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr.replace(' ', 'T') + 'Z');
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
      ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function fileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /** Redirects to login if not authenticated; returns the session user otherwise. */
  async function requireAuth(allowedRoles) {
    try {
      const { user } = await Api.get('/api/auth/me');
      if (allowedRoles && !allowedRoles.includes(user.role)) {
        window.location.href = '/login.html';
        return null;
      }
      return user;
    } catch (e) {
      window.location.href = '/login.html';
      return null;
    }
  }

  async function loadInstitutionBranding() {
    try {
      const config = await Api.get('/api/config');
      document.querySelectorAll('[data-institution-name]').forEach(el => {
        el.textContent = config.institutionName;
      });
      document.title = document.title.replace('EduMemo', config.institutionShortName || 'EduMemo');
      return config;
    } catch (e) { return null; }
  }

  function initSidebarToggle() {
    const toggle = document.getElementById('mobile-toggle');
    const sidebar = document.getElementById('sidebar');
    const scrim = document.getElementById('sidebar-scrim');
    if (!toggle || !sidebar) return;
    const close = () => { sidebar.classList.remove('open'); scrim && scrim.classList.remove('open'); };
    toggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      scrim && scrim.classList.toggle('open');
    });
    scrim && scrim.addEventListener('click', close);
  }

  function initUserChrome(user) {
    const nameEl = document.getElementById('sidebar-user-name');
    const roleEl = document.getElementById('sidebar-user-role');
    if (nameEl) nameEl.textContent = `${user.firstName} ${user.lastName}`;
    if (roleEl) {
      // Staff accounts are labelled by type under the user's name. Non-teaching
      // staff can only receive memos, so they are never labelled as publishers.
      const staffLabel = user.staffType === 'non_academic' ? 'Non-teaching staff' : 'Teaching staff';
      const roleLabels = {
        student: 'Student',
        staff: user.status === 'pending_approval' ? `${staffLabel} · Pending approval` : staffLabel,
        administrator: 'Super Admin',
      };
      roleEl.textContent = roleLabels[user.role] || user.role;
    }
    if (user.role === 'staff' && user.staffType === 'non_academic') {
      document.querySelectorAll('a[href="/staff/create-memo.html"], a[href="/staff/memos.html?tab=drafts"], a[href="/staff/memos.html?tab=sent"], a[href="/staff/memos.html?tab=archived"]').forEach(link => link.remove());
    }
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      const fallback = user.role === 'administrator' ? '/admin/login' : '/login';
      logoutBtn.addEventListener('click', async () => {
        try {
          const res = await Api.post('/api/auth/logout');
          window.location.href = res.redirect || fallback;
        } catch (e) { window.location.href = fallback; }
      });
    }

    // Self-healing web push. A device that has already been subscribed keeps
    // working in the browser, but the server only knows about it while its
    // push_subscriptions row exists -- and that row disappears whenever the
    // server is redeployed/restored with a fresh or restored database, or the
    // endpoint is pruned. Push then stops for that user while the UI still
    // shows notifications as enabled, which is exactly the "no more web push
    // notifications" symptom. Handing the existing subscription back on every
    // page load repairs that automatically, with no prompt and no user action.
    if (typeof PushClient !== 'undefined' && typeof PushClient.syncSubscription === 'function'
        && (user.role === 'student' || user.role === 'staff')) {
      PushClient.syncSubscription();
    }
  }

  /**
   * One-time guidance for accounts that opted into web push (e.g. during
   * registration) but have not yet subscribed any device on this browser.
   * Renders a small, dismissible banner at the top of #page-content. Changing
   * nothing when the account has no push preference, when a subscription
   * already exists, or when push.js isn't loaded on this page.
   */
  async function maybePromptPushSetup() {
    if (typeof PushClient === 'undefined') return;
    const content = document.getElementById('page-content');
    if (!content) return;
    try {
      // Hand any existing browser subscription to the server first, so the
      // banner is only shown to a device that genuinely has no subscription
      // (rather than to a device whose server-side row was lost).
      if (typeof PushClient.syncSubscription === 'function') await PushClient.syncSubscription();
      const { account } = await Api.get('/api/profile');
      if (!account.pushEnabled || account.pushSubscribed) return;

      const banner = document.createElement('div');
      banner.style.cssText = 'background:var(--green-tint,#e8f4ec);border:1px solid var(--green,#1b8a3d);border-radius:10px;padding:14px 16px;margin-bottom:16px;display:flex;flex-wrap:wrap;align-items:center;gap:10px;';
      banner.innerHTML = '<div style="flex:1;min-width:220px;">🔔 <strong>Web push is on for your account but not on this device yet.</strong>' +
        '<div style="font-size:13px;color:#3c4b43;margin-top:2px;">Enable it here so new memos alert you even when EduMemo is closed (Android phones can also install the app from Chrome for best results).</div></div>' +
        '<button class="btn btn-primary" id="push-setup-cta" style="margin:0;">Enable on this device</button>' +
        '<button type="button" class="btn btn-ghost" id="push-setup-dismiss" aria-label="Dismiss" style="padding:4px 10px;border:1px solid transparent;">✕</button>';

      if (!account.pushConfigured) {
        banner.innerHTML = '<div style="flex:1;">🔔 <strong>Web push is not set up by the administrator yet.</strong>' +
          '<div style="font-size:13px;color:#3c4b43;margin-top:2px;">Memo emails are still delivered to your inbox immediately. Push will become available once VAPID keys are configured.</div></div>' +
          '<button type="button" class="btn btn-ghost" id="push-setup-dismiss" aria-label="Dismiss" style="padding:4px 10px;">✕</button>';
      }

      content.prepend(banner);
      const dismiss = banner.querySelector('#push-setup-dismiss');
      if (dismiss) dismiss.addEventListener('click', () => banner.remove());

      const cta = banner.querySelector('#push-setup-cta');
      if (!cta) return;
      const reason = await PushClient.unsupportedReason();
      if (reason) {
        banner.innerHTML = `<div style="flex:1;">🔔 <strong>Web push on this device</strong><div style="font-size:13px;color:#3c4b43;margin-top:2px;">${escapeHtml(reason)}</div></div>` +
          '<button type="button" class="btn btn-ghost" id="push-setup-dismiss" aria-label="Dismiss" style="padding:4px 10px;">✕</button>';
        const dismissNow = banner.querySelector('#push-setup-dismiss');
        if (dismissNow) dismissNow.addEventListener('click', () => banner.remove());
        return;
      }
      cta.addEventListener('click', async () => {
        cta.disabled = true;
        cta.textContent = 'Enabling…';
        const result = await PushClient.enable();
        if (result.ok) {
          banner.remove();
          toast('Web push enabled on this device.', 'success');
        } else {
          cta.disabled = false;
          cta.textContent = 'Enable on this device';
          banner.innerHTML = `<div style="flex:1;">🔔 <strong>Web push on this device</strong><div style="font-size:13px;color:#3c4b43;margin-top:2px;">${escapeHtml(result.reason || 'Could not enable push. Please try again from Settings.')}</div></div>` +
            '<button type="button" class="btn btn-ghost" id="push-setup-dismiss" aria-label="Dismiss" style="padding:4px 10px;">✕</button>';
          const dismissErr = banner.querySelector('#push-setup-dismiss');
          if (dismissErr) dismissErr.addEventListener('click', () => banner.remove());
        }
      });
    } catch (e) { /* banner is best-effort; never block the page */ }
  }

  /** Notification bell: badge count + dropdown list, shared across all roles. */
  function initNotificationBell() {
    const btn = document.getElementById('bell-btn');
    const panel = document.getElementById('notif-panel');
    const countEl = document.getElementById('bell-count');
    if (!btn || !panel) return;

    async function refreshCount() {
      try {
        const { unreadCount } = await Api.get('/api/notifications/unread-count');
        if (unreadCount > 0) {
          countEl.textContent = unreadCount > 99 ? '99+' : unreadCount;
          countEl.style.display = 'flex';
        } else {
          countEl.style.display = 'none';
        }
      } catch (e) { /* ignore */ }
    }

    async function loadList() {
      panel.innerHTML = '<div class="notif-item"><span class="muted">Loading…</span></div>';
      try {
        const { notifications } = await Api.get('/api/notifications?page=1');
        if (notifications.length === 0) {
          panel.innerHTML = '<div class="empty-state" style="padding:30px 16px;"><div class="emoji">🔔</div><h3>No notifications yet</h3><p>New memo alerts will show up here.</p></div>';
          return;
        }
        panel.innerHTML = notifications.map(n => `
          <div class="notif-item ${n.is_read ? '' : 'unread'}" data-id="${n.id}" data-memo="${n.memo_id || ''}">
            <div class="t">${escapeHtml(n.title)}</div>
            <div class="d">${timeAgo(n.created_at)}</div>
          </div>
        `).join('') + '<div class="notif-footer"><a href="#" id="mark-all-read">Mark all as read</a></div>';

        panel.querySelectorAll('.notif-item').forEach(item => {
          item.addEventListener('click', async () => {
            const id = item.dataset.id;
            const memoId = item.dataset.memo;
            try { await Api.post(`/api/notifications/${id}/read`); } catch (e) {}
            if (memoId) window.location.href = `/memo.html?id=${memoId}`;
          });
        });
        const markAll = document.getElementById('mark-all-read');
        if (markAll) markAll.addEventListener('click', async (e) => {
          e.preventDefault();
          await Api.post('/api/notifications/read-all');
          await loadList();
          await refreshCount();
        });
      } catch (e) {
        panel.innerHTML = '<div class="notif-item">Could not load notifications.</div>';
      }
    }

    btn.addEventListener('click', () => {
      const willOpen = !panel.classList.contains('open');
      panel.classList.toggle('open');
      if (willOpen) { loadList(); btn.classList.remove('swing'); }
    });
    document.addEventListener('click', (e) => {
      if (!btn.contains(e.target) && !panel.contains(e.target)) panel.classList.remove('open');
    });

    refreshCount();
    setInterval(refreshCount, 30000);
  }

  function confirmModal({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay open';
      overlay.innerHTML = `
        <div class="modal-box">
          <h3>${escapeHtml(title)}</h3>
          <p>${body}</p>
          <div class="modal-actions">
            <button class="btn btn-secondary" data-action="cancel">${escapeHtml(cancelLabel)}</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="confirm" style="${danger ? 'background:var(--red);color:#fff;border-color:var(--red);' : ''}">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.dataset.action === 'cancel') {
          overlay.remove(); resolve(false);
        } else if (e.target.dataset.action === 'confirm') {
          overlay.remove(); resolve(true);
        }
      });
    });
  }

  const BELL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
  const MENU_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M3 6h18M3 12h18M3 18h18"/></svg>';

  const NAV = {
    student: [
      { href: '/student/dashboard.html', label: 'Memos', icon: '📋' },
      { href: '/student/settings.html', label: 'Settings', icon: '⚙️' },
    ],
    staff: [
      { href: '/staff/memos.html?tab=received', label: 'Received Memos', icon: '📥' },
      { href: '/staff/dashboard.html', label: 'Dashboard', icon: '🏠' },
      { href: '/staff/create-memo.html', label: 'Create Memo', icon: '✏️', highlight: true },
      { href: '/staff/memos.html?tab=drafts', label: 'Drafts', icon: '📝' },
      { href: '/staff/memos.html?tab=sent', label: 'Sent Memos', icon: '📤' },
      { href: '/staff/memos.html?tab=archived', label: 'Archived', icon: '🗄️' },
      { href: '/staff/settings.html', label: 'Settings', icon: '⚙️' },
    ],
    administrator: [
      { href: '/admin/dashboard.html', label: 'Overview', icon: '🏠' },
      { href: '/admin/create-memo.html', label: 'Send Institution-Wide Memo', icon: '📢', highlight: true },
      { href: '/admin/users.html?tab=students', label: 'Students', icon: '🎓' },
      { href: '/admin/users.html?tab=academic', label: 'Teaching Staff', icon: '🧑‍🏫' },
      { href: '/admin/users.html?tab=non_academic', label: 'Non-Teaching Staff', icon: '👥' },
      { href: '/admin/users.html?tab=approvals', label: 'Staff Approvals', icon: '✅' },
      { href: '/admin/memo-records.html', label: 'Memo Records', icon: '🗂️' },
      { href: '/admin/reports.html', label: 'Reports', icon: '📊' },
      { href: '/admin/academic-structure.html', label: 'Academic Structure', icon: '🏛️' },
      { href: '/admin/audit-logs.html', label: 'Audit Logs', icon: '📜' },
      { href: '/admin/settings.html', label: 'System Settings', icon: '🔧' },
    ],
  };

  function currentMatches(href) {
    const [path, query] = href.split('?');
    if (window.location.pathname !== path) return false;
    if (!query) return true;
    const wantTab = new URLSearchParams(query).get('tab');
    const gotTab = new URLSearchParams(window.location.search).get('tab');
    return wantTab === (gotTab || new URLSearchParams(query).get('tab'));
  }

  /** Renders the full app shell (sidebar + topbar) into the page, then calls back with the content container. */
  function renderShell({ role, searchPlaceholder = 'Search memos…', onSearch, showSearch = true }) {
    const navItems = NAV[role] || [];
    const navHtml = navItems.map(item => `
      <a href="${item.href}" class="${currentMatches(item.href) ? 'active' : ''}" ${item.highlight ? 'style="background:var(--green-tint);color:var(--green-dark);"' : ''}>
        <span>${item.icon}</span> ${item.label}
      </a>`).join('');

    document.body.insertAdjacentHTML('afterbegin', `
      <div class="sidebar-scrim" id="sidebar-scrim"></div>
      <div class="app-shell">
        <aside class="sidebar" id="sidebar">
          <div class="sidebar-brand">
            <img src="/images/logo-dark.png" alt="Institution logo" onerror="this.onerror=null;this.src='/images/logo.png';this.style.background='#ffffff';this.style.padding='6px 9px';this.style.borderRadius='10px';">
          </div>
          <nav>${navHtml}</nav>
          <div class="sidebar-footer">
            <div class="sidebar-user">
              <div class="name" id="sidebar-user-name">…</div>
              <div class="role" id="sidebar-user-role">…</div>
            </div>
            <button class="btn btn-ghost btn-block" id="logout-btn">Log out</button>
          </div>
        </aside>
        <div class="main">
          <div class="topbar">
            <button class="mobile-toggle" id="mobile-toggle">${MENU_SVG}</button>
            ${showSearch ? '<div class="search-box"><input type="search" id="topbar-search"></div>' : '<div style="flex:1"></div>'}
            <div class="topbar-actions">
              <div class="dropdown-wrap">
                <button class="bell-btn" id="bell-btn" aria-label="Notifications">
                  ${BELL_SVG}
                  <span class="bell-count" id="bell-count" style="display:none;"></span>
                </button>
                <div class="dropdown-panel" id="notif-panel"></div>
              </div>
            </div>
          </div>
          <div class="content${role === 'administrator' ? ' wide' : ''}" id="page-content"></div>
        </div>
      </div>
    `);

    initSidebarToggle();
    initNotificationBell();

    if (showSearch && onSearch) {
      const searchInput = document.getElementById('topbar-search');
      let debounceTimer;
      searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => onSearch(searchInput.value.trim()), 350);
      });
    }

    return document.getElementById('page-content');
  }

  return {
    toast, showError, escapeHtml, timeAgo, formatDate, fileSize,
    requireAuth, loadInstitutionBranding, initSidebarToggle, initUserChrome,
    initNotificationBell, confirmModal, renderShell, maybePromptPushSetup,
  };
})();
