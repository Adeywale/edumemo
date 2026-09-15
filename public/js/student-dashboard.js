(async () => {
  const user = await App.requireAuth(['student']);
  if (!user) return;
  App.loadInstitutionBranding();
  let searchTerm = '';
  const state = { filter: 'all', page: 1 };
  const content = App.renderShell({ role: 'student', searchPlaceholder: 'Search memos by title, sender or category…', onSearch: value => { searchTerm = value; state.page = 1; load(); } });
  App.initUserChrome(user);
  content.innerHTML = `
    <div class="panel-header"><h1>Memos</h1></div>
    <div class="tabs" id="tabs"><button class="tab-btn active" data-filter="all">All</button><button class="tab-btn" data-filter="unread">Unread</button><button class="tab-btn" data-filter="read">Read</button></div>
    <div id="list-region"><div class="empty-state"><span class="spinner" style="border-top-color:var(--green); border-color:var(--border);"></span></div></div>
    <div class="pagination" id="pagination"></div>`;
  const listRegion = document.getElementById('list-region');
  const pagination = document.getElementById('pagination');
  document.getElementById('tabs').addEventListener('click', event => {
    if (!event.target.matches('.tab-btn')) return;
    document.querySelectorAll('.tab-btn').forEach(button => button.classList.remove('active'));
    event.target.classList.add('active'); state.filter = event.target.dataset.filter; state.page = 1; load();
  });
  async function load() {
    listRegion.innerHTML = '<div class="empty-state"><span class="spinner" style="border-top-color:var(--green); border-color:var(--border);"></span></div>';
    try {
      const params = new URLSearchParams({ filter: state.filter, page: state.page });
      if (searchTerm) params.set('search', searchTerm);
      const { memos, total, pageSize } = await Api.get(`/api/memos?${params}`);
      if (!memos.length) {
        listRegion.innerHTML = `<div class="empty-state"><div class="emoji">📭</div><h3>${searchTerm ? 'No matching memos' : 'No memos yet'}</h3><p>${searchTerm ? 'Try a different search term.' : "You'll see memos here as soon as they're published to you."}</p></div>`;
        pagination.innerHTML = ''; return;
      }
      listRegion.innerHTML = `<div class="list">${memos.map(memo => `<div class="list-row ${memo.is_read ? '' : 'is-unread'}" data-id="${memo.id}"><div class="unread-dot ${memo.is_read ? 'hidden' : ''}"></div><div class="row-main"><div class="row-title">${App.escapeHtml(memo.title)}</div><div class="row-meta"><span>${App.escapeHtml(memo.sender_name)}</span>${memo.category_name ? `<span class="badge badge-grey">${App.escapeHtml(memo.category_name)}</span>` : ''}${memo.has_attachment ? '<span>📎 Attachment</span>' : ''}</div></div><div class="row-side">${App.timeAgo(memo.published_at)}</div></div>`).join('')}</div>`;
      listRegion.querySelectorAll('.list-row').forEach(row => row.addEventListener('click', () => { window.location.href = `/memo.html?id=${row.dataset.id}`; }));
      const pages = Math.max(1, Math.ceil(total / pageSize));
      pagination.innerHTML = pages > 1 ? Array.from({ length: pages }, (_, index) => { const page = index + 1; return `<button class="btn btn-sm ${page === state.page ? 'btn-primary' : 'btn-secondary'}" data-page="${page}">${page}</button>`; }).join('') : '';
      pagination.querySelectorAll('button').forEach(button => button.addEventListener('click', () => { state.page = Number(button.dataset.page); load(); }));
    } catch (error) { listRegion.innerHTML = `<div class="alert alert-error">${App.escapeHtml(error.message)}</div>`; }
  }
  load();
})();
