/* yt-dlp Web — Frontend */

const state = {
    url: '',
    info: null,
    selectedFormat: 'best_video',
    activeJobs: {},   // jobId -> { ws, data }
    historyOffset: 0,
    historyLimit: 50,
    extractors: [],   // [{name, description}, ...]
    sidebarOpen: false,
    tags: [],              // [{id, name, color, count, system}, ...]
    activeTagFilter: null, // tag_id or null for "all"
    currentView: 'home',   // 'home' | 'library' | 'playlists'
    servicesOpen: false,

    // Library state
    library: {
        items: [],
        offset: 0,
        limit: 50,
        search: '',
        sortBy: 'created_at',
        sortOrder: 'desc',
        tagIds: new Set(),  // multi-select tag filter
        selected: new Set(),
    },

    // Playlists state
    playlists: {
        items: [],
        activeId: null,
        activePlaylist: null,
        activeItems: [],
    },

    // Player state
    player: {
        playlistId: null,
        items: [],
        currentIndex: -1,
        playing: false,
    },
};

const TAG_COLORS = [
    '#3b82f6', '#22c55e', '#ef4444', '#f59e0b', '#8b5cf6',
    '#ec4899', '#06b6d4', '#f97316', '#6366f1', '#14b8a6',
];

// --- Helpers ---

function formatBytes(bytes) {
    if (bytes == null || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

function formatSpeed(bps) {
    if (bps == null) return '-- /s';
    return formatBytes(bps) + '/s';
}

function formatEta(secs) {
    if (secs == null) return '--:--';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    if (m >= 60) {
        const h = Math.floor(m / 60);
        return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDuration(secs) {
    if (secs == null) return '';
    return formatEta(secs);
}

function formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const day = String(d.getDate()).padStart(2, '0');
    const mon = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${day}.${mon}.${year} ${h}:${m}`;
}

function formatPresetLabel(preset) {
    const labels = {
        best_video: 'Best Video',
        audio_mp3: 'MP3',
        video_720p: '720p',
        video_1080p: '1080p',
    };
    return labels[preset] || preset;
}

function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function $(id) { return document.getElementById(id); }

function showError(msg) {
    const el = $('error-msg');
    el.textContent = msg;
    el.hidden = false;
}

function hideError() {
    $('error-msg').hidden = true;
}

function setLoading(btn, loading) {
    btn.disabled = loading;
    if (loading) {
        btn._origText = btn.textContent;
        btn.innerHTML = '<span class="spinner"></span>Loading...';
    } else {
        btn.textContent = btn._origText || btn.textContent;
    }
}

function wsUrl(path) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}${path}`;
}

// ===== SPA Navigation =====

function navigateTo(view) {
    if (view === state.currentView) return;
    state.currentView = view;

    $('view-home').hidden = view !== 'home';
    $('view-library').hidden = view !== 'library';
    $('view-playlists').hidden = view !== 'playlists';

    // Update nav buttons
    document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });

    // Update URL
    const url = view === 'library' ? '/library' : view === 'playlists' ? '/playlists' : '/';
    history.pushState({ view }, '', url);

    // Load data on first visit
    if (view === 'library' && state.library.items.length === 0) {
        loadLibrary();
    }
    if (view === 'playlists' && state.playlists.items.length === 0) {
        loadPlaylists();
    }
}

function initRouter() {
    const path = location.pathname;
    const viewMap = { '/library': 'library', '/playlists': 'playlists' };
    const initialView = viewMap[path] || 'home';

    if (initialView !== 'home') {
        state.currentView = initialView;
        $('view-home').hidden = true;
        $('view-library').hidden = initialView !== 'library';
        $('view-playlists').hidden = initialView !== 'playlists';
        document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === initialView);
        });
        if (initialView === 'library') loadLibrary();
        if (initialView === 'playlists') loadPlaylists();
    }

    window.addEventListener('popstate', (e) => {
        const view = e.state?.view || 'home';
        state.currentView = view;
        $('view-home').hidden = view !== 'home';
        $('view-library').hidden = view !== 'library';
        $('view-playlists').hidden = view !== 'playlists';
        document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });
        if (view === 'library') loadLibrary();
        if (view === 'playlists') loadPlaylists();
    });
}

// ===== Sidebar =====

function toggleSidebar() {
    const sidebar = $('sidebar');
    state.sidebarOpen = !state.sidebarOpen;
    sidebar.classList.toggle('collapsed', !state.sidebarOpen);
}

function toggleServicesSection() {
    state.servicesOpen = !state.servicesOpen;
    const body = $('services-body');
    const arrow = $('services-arrow');
    body.hidden = !state.servicesOpen;
    arrow.classList.toggle('open', state.servicesOpen);
}

// ===== Extractors (Services) =====

async function loadExtractors() {
    try {
        const resp = await fetch('/api/extractors');
        if (!resp.ok) return;
        state.extractors = await resp.json();
        $('extractor-count').textContent = state.extractors.length;
        renderExtractors('');
    } catch (e) {
        console.error('Failed to load extractors', e);
    }
}

function renderExtractors(filter) {
    const list = $('extractor-list');
    list.innerHTML = '';

    const q = (filter || '').toLowerCase().trim();
    const items = q
        ? state.extractors.filter(e =>
            e.name.toLowerCase().includes(q) ||
            (e.description && e.description.toLowerCase().includes(q)))
        : state.extractors;

    for (const ext of items) {
        const li = document.createElement('li');
        li.className = 'extractor-item';
        li.textContent = ext.name;
        if (ext.description && ext.description !== ext.name) {
            const desc = document.createElement('span');
            desc.className = 'ext-desc';
            desc.textContent = ext.description;
            li.appendChild(desc);
        }
        list.appendChild(li);
    }
}

// ===== URL Support Check =====

let _urlCheckTimer = null;

function checkUrlSupport(url) {
    const warning = $('url-warning');
    if (!url || !state.extractors.length) {
        warning.hidden = true;
        return;
    }

    let hostname = '';
    try {
        const parsed = new URL(url);
        hostname = parsed.hostname.replace(/^www\./, '').replace(/^m\./, '');
    } catch {
        warning.hidden = true;
        return;
    }

    if (!hostname) {
        warning.hidden = true;
        return;
    }

    const hl = hostname.toLowerCase();
    const domainParts = hl.split('.');
    const domainName = domainParts.length >= 2 ? domainParts[domainParts.length - 2] : hl;

    const found = state.extractors.some(e => {
        const name = e.name.toLowerCase();
        const desc = (e.description || '').toLowerCase();
        return name.includes(domainName) || desc.includes(hl) || desc.includes(domainName);
    });

    warning.hidden = found;
}

function onUrlInput(value) {
    clearTimeout(_urlCheckTimer);
    _urlCheckTimer = setTimeout(() => checkUrlSupport(value.trim()), 300);
}

// ===== Fetch Info =====

async function fetchInfo() {
    const url = $('url-input').value.trim();
    if (!url) return;

    hideError();
    state.url = url;
    state.info = null;
    $('preview-section').hidden = true;

    const btn = $('fetch-btn');
    setLoading(btn, true);

    try {
        const resp = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.detail || 'Failed to fetch info');
        }
        state.info = await resp.json();
        renderPreview();
    } catch (e) {
        showError(e.message);
    } finally {
        setLoading(btn, false);
    }
}

function renderPreview() {
    const info = state.info;
    if (!info) return;

    $('preview-thumb').src = info.thumbnail || '';
    $('preview-thumb').style.display = info.thumbnail ? 'block' : 'none';
    $('preview-title').textContent = info.title || 'Unknown title';
    $('preview-uploader').textContent = info.uploader || '';
    $('preview-duration').textContent = info.duration ? `Duration: ${formatDuration(info.duration)}` : '';
    $('playlist-warning').hidden = !info.is_playlist;

    const sizes = info.preset_sizes || {};
    document.querySelectorAll('.format-size').forEach(el => {
        const preset = el.dataset.preset;
        const bytes = sizes[preset];
        if (bytes) {
            const approx = preset === 'audio_mp3' ? '~' : '';
            el.textContent = `(${approx}${formatBytes(bytes)})`;
        } else {
            el.textContent = '';
        }
    });

    $('preview-section').hidden = false;
}

// ===== Start Download =====

async function startDownload() {
    if (!state.url) return;

    const format = document.querySelector('input[name="format"]:checked').value;
    const pinned = $('pin-on-download')?.checked || false;
    const btn = $('download-btn');
    setLoading(btn, true);
    hideError();

    try {
        const resp = await fetch('/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: state.url, format_preset: format, pinned }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.detail || 'Failed to start download');
        }
        const data = await resp.json();
        createActiveJob(data.job_id, state.info, format);
        connectJobWS(data.job_id);
    } catch (e) {
        showError(e.message);
    } finally {
        setLoading(btn, false);
    }
}

// ===== Active Jobs UI =====

function createActiveJob(jobId, info, format) {
    state.activeJobs[jobId] = { data: { status: 'queued' } };

    const card = document.createElement('div');
    card.className = 'job-card';
    card.id = `job-${jobId}`;
    card.innerHTML = `
        <div class="job-card-header">
            <span class="job-card-title">${info?.title || 'Downloading...'}</span>
            <span class="job-card-status" data-field="status">queued</span>
        </div>
        <div class="progress-bar-container">
            <div class="progress-bar" data-field="bar"></div>
        </div>
        <span class="progress-text" data-field="progress">Waiting...</span>
        <div class="job-error" data-field="error" hidden></div>
        <div class="job-card-actions">
            <button class="cancel-btn" data-field="cancel-btn" onclick="cancelJob('${jobId}')">Cancel</button>
            <a class="download-link" data-field="download-link" href="#" hidden>Download File</a>
        </div>
    `;

    $('active-list').prepend(card);
    $('no-active').hidden = true;
}

function updateActiveJob(jobId, msg) {
    const card = $(`job-${jobId}`);
    if (!card) return;

    const get = (f) => card.querySelector(`[data-field="${f}"]`);

    if (msg.type === 'status') {
        get('status').textContent = msg.status;
        if (msg.status === 'extracting') {
            get('progress').textContent = 'Extracting info...';
        }
    }

    if (msg.type === 'progress' && msg.status === 'downloading') {
        const pct = msg.percent || 0;
        get('bar').style.width = pct + '%';
        get('status').textContent = 'downloading';
        get('progress').textContent =
            `${pct.toFixed(1)}%  ${formatSpeed(msg.speed)}  ETA: ${formatEta(msg.eta)}`;
        card.className = 'job-card';
    }

    if (msg.type === 'postprocessor' && msg.pp_status === 'started') {
        if (msg.postprocessor && msg.postprocessor.includes('Merger')) {
            get('status').textContent = 'merging';
            get('progress').textContent = 'Merging video + audio...';
            get('bar').style.width = '100%';
            card.className = 'job-card status-merging';
        } else if (msg.postprocessor && msg.postprocessor.includes('ExtractAudio')) {
            get('status').textContent = 'processing';
            get('progress').textContent = 'Extracting audio...';
            get('bar').style.width = '100%';
        }
    }

    if (msg.type === 'complete') {
        get('cancel-btn').hidden = true;

        if (msg.status === 'done') {
            get('status').textContent = 'done';
            get('bar').style.width = '100%';
            get('progress').textContent = `Done${msg.file_size ? ' — ' + formatBytes(msg.file_size) : ''}`;
            card.className = 'job-card status-done';

            if (msg.file_name) {
                const link = get('download-link');
                link.href = `/files/${encodeURIComponent(msg.file_name)}`;
                link.hidden = false;
            }

            loadHistory();
            loadTags(); // Refresh tag counts
        } else if (msg.status === 'cancelled') {
            get('status').textContent = 'cancelled';
            get('progress').textContent = 'Cancelled';
            card.className = 'job-card status-cancelled';
        } else if (msg.status === 'error') {
            get('status').textContent = 'error';
            get('progress').textContent = 'Failed';
            card.className = 'job-card status-error';
            const errEl = get('error');
            errEl.textContent = msg.error_msg || 'Unknown error';
            errEl.hidden = false;
        }
    }
}

async function cancelJob(jobId) {
    try {
        await fetch(`/api/downloads/${jobId}/cancel`, { method: 'POST' });
    } catch (e) {
        console.error('Failed to cancel', e);
    }
}

// ===== WebSocket =====

function connectJobWS(jobId) {
    const ws = new WebSocket(wsUrl(`/ws/${jobId}`));
    if (state.activeJobs[jobId]) {
        state.activeJobs[jobId].ws = ws;
    }

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        updateActiveJob(msg.job_id || jobId, msg);
    };

    ws.onclose = () => {
        setTimeout(() => {
            if (state.activeJobs[jobId]?.data?.status === 'done' ||
                state.activeJobs[jobId]?.data?.status === 'error') {
                delete state.activeJobs[jobId];
            }
        }, 5000);
    };

    ws.onerror = () => {
        console.error('WebSocket error for job', jobId);
    };
}

// ===== Pin =====

async function togglePin(jobId) {
    try {
        const resp = await fetch(`/api/downloads/${jobId}/pin`, { method: 'PATCH' });
        if (!resp.ok) return;
        const data = await resp.json();

        // Update in home history
        const el = $(`hist-${jobId}`);
        if (el) {
            const pinBtn = el.querySelector('.pin-btn');
            if (pinBtn) {
                pinBtn.classList.toggle('pinned', data.pinned);
                pinBtn.title = data.pinned ? 'Unpin' : 'Pin';
            }
            el.classList.toggle('history-item-pinned', data.pinned);
        }

        // Update in library
        const libEl = $(`lib-${jobId}`);
        if (libEl) {
            const pinBtn = libEl.querySelector('.pin-btn');
            if (pinBtn) {
                pinBtn.classList.toggle('pinned', data.pinned);
                pinBtn.title = data.pinned ? 'Unpin' : 'Pin';
            }
            libEl.classList.toggle('pinned', data.pinned);
        }
    } catch (e) {
        console.error('Failed to toggle pin', e);
    }
}

// ===== Tags =====

async function loadTags() {
    try {
        const resp = await fetch('/api/tags');
        if (!resp.ok) return;
        state.tags = await resp.json();
        renderTagFilter();
        renderLibraryTagFilters();
    } catch (e) {
        console.error('Failed to load tags', e);
    }
}

function renderTagFilter() {
    const strip = $('tag-filter');
    if (state.tags.length === 0) {
        strip.hidden = true;
        return;
    }
    strip.hidden = false;

    let html = `<span class="tag-filter-chip ${state.activeTagFilter === null ? 'active' : ''}"
                     onclick="filterByTag(null)">All</span>`;
    for (const t of state.tags) {
        const active = state.activeTagFilter === t.id ? 'active' : '';
        html += `<span class="tag-filter-chip ${active}"
                       style="--tag-color:${t.color}; ${state.activeTagFilter === t.id ? 'background:' + t.color + '; border-color:' + t.color + '; color:#fff' : ''}"
                       onclick="filterByTag(${t.id})">${escHtml(t.name)}</span>`;
    }
    html += `<button class="tag-manage-btn" onclick="openTagManager()">Manage Tags</button>`;
    strip.innerHTML = html;
}

function filterByTag(tagId) {
    state.activeTagFilter = tagId;
    renderTagFilter();
    loadHistory();
}

// ===== Tag Assignment Popover =====

function openTagAssign(downloadId, anchorEl) {
    closeTagAssign();

    const pop = document.createElement('div');
    pop.className = 'tag-assign-popover';
    pop.id = 'tag-assign-popover';

    const histEl = $(`hist-${downloadId}`) || $(`lib-${downloadId}`);
    const currentTagIds = new Set();
    if (histEl) {
        histEl.querySelectorAll('.tag-chip[data-tag-id]').forEach(chip => {
            currentTagIds.add(parseInt(chip.dataset.tagId));
        });
    }

    let html = '<div class="tag-assign-title">Assign Tags</div>';
    if (state.tags.length === 0) {
        html += '<p class="muted" style="padding:8px;font-size:12px">No tags yet. Create one in Manage Tags.</p>';
    }
    for (const t of state.tags) {
        const checked = currentTagIds.has(t.id) ? 'checked' : '';
        html += `<label class="tag-assign-row">
            <input type="checkbox" ${checked}
                   onchange="toggleTagAssign('${downloadId}', ${t.id}, this.checked)">
            <span class="tag-chip" style="background:${t.color}20; color:${t.color}; border-color:${t.color}">${escHtml(t.name)}</span>
        </label>`;
    }
    pop.innerHTML = html;

    const tagsContainer = anchorEl.closest('.h-tags') || anchorEl.closest('.lib-tags');
    if (tagsContainer) {
        tagsContainer.style.position = 'relative';
        tagsContainer.appendChild(pop);
    } else {
        anchorEl.parentElement.style.position = 'relative';
        anchorEl.parentElement.appendChild(pop);
    }

    setTimeout(() => {
        document.addEventListener('click', _closeTagAssignOnOutsideClick);
    }, 0);
}

function closeTagAssign() {
    const el = $('tag-assign-popover');
    if (el) el.remove();
    document.removeEventListener('click', _closeTagAssignOnOutsideClick);
}

function _closeTagAssignOnOutsideClick(e) {
    const pop = $('tag-assign-popover');
    if (pop && !pop.contains(e.target) && !e.target.classList.contains('add-tag-btn')) {
        closeTagAssign();
    }
}

async function toggleTagAssign(downloadId, tagId, add) {
    const method = add ? 'POST' : 'DELETE';
    try {
        await fetch(`/api/downloads/${downloadId}/tags/${tagId}`, { method });
        loadHistory();
        loadTags();
        if (state.currentView === 'library') loadLibrary();
    } catch (e) {
        console.error('Failed to toggle tag', e);
    }
    closeTagAssign();
}

// ===== Tag Manager Modal =====

function openTagManager() {
    closeTagAssign();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'tag-manager-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) closeTagManager(); };

    const colorOptions = TAG_COLORS.map((c, i) =>
        `<span class="color-swatch${i === 0 ? ' selected' : ''}" data-color="${c}" style="background:${c}"
              onclick="selectTagColor(this)"></span>`
    ).join('');

    const tagListHtml = state.tags.length > 0
        ? state.tags.map(t => {
            const isSystem = t.system;
            const renameBtn = isSystem
                ? ''
                : `<button class="btn-sm" onclick="renameTag(${t.id}, '${escHtml(t.name)}')">Rename</button>`;
            const deleteBtn = isSystem
                ? '<span style="font-size:11px;color:var(--text-muted)">system</span>'
                : `<button class="btn-sm btn-danger" onclick="removeTag(${t.id})">Delete</button>`;
            return `<div class="tag-manager-row" data-tag-id="${t.id}">
                <span class="tag-chip" style="background:${t.color}20; color:${t.color}; border-color:${t.color}">${escHtml(t.name)}</span>
                <span style="flex:1"></span>
                ${renameBtn}
                ${deleteBtn}
            </div>`;
        }).join('')
        : '<p class="muted" style="font-size:12px">No tags created yet</p>';

    overlay.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>Manage Tags</h3>
                <button class="modal-close" onclick="closeTagManager()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="tag-create-form">
                    <input type="text" id="new-tag-name" placeholder="New tag name..." maxlength="30">
                    <div class="color-palette" id="color-palette">${colorOptions}</div>
                    <input type="hidden" id="new-tag-color" value="${TAG_COLORS[0]}">
                    <button class="btn-primary btn-sm" onclick="createNewTag()">Create</button>
                </div>
                <div class="tag-manager-list" id="tag-manager-list">
                    ${tagListHtml}
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const input = $('new-tag-name');
    if (input) {
        input.focus();
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') createNewTag();
        });
    }
}

function closeTagManager() {
    const el = $('tag-manager-overlay');
    if (el) el.remove();
}

function selectTagColor(el) {
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
    el.classList.add('selected');
    $('new-tag-color').value = el.dataset.color;
}

async function createNewTag() {
    const nameEl = $('new-tag-name');
    const name = nameEl.value.trim();
    const color = $('new-tag-color').value;
    if (!name) return;

    try {
        const resp = await fetch('/api/tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, color }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            alert(err.detail || 'Failed to create tag');
            return;
        }
        await loadTags();
        closeTagManager();
        openTagManager();
    } catch (e) {
        console.error('Failed to create tag', e);
    }
}

async function renameTag(tagId, currentName) {
    const newName = prompt('Rename tag:', currentName);
    if (!newName || newName.trim() === currentName) return;

    try {
        const resp = await fetch(`/api/tags/${tagId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName.trim() }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            alert(err.detail || 'Failed to rename tag');
            return;
        }
        await loadTags();
        closeTagManager();
        openTagManager();
        loadHistory();
    } catch (e) {
        console.error('Failed to rename tag', e);
    }
}

async function removeTag(tagId) {
    if (!confirm('Delete this tag? It will be removed from all downloads.')) return;

    try {
        const resp = await fetch(`/api/tags/${tagId}`, { method: 'DELETE' });
        if (!resp.ok) {
            const err = await resp.json();
            alert(err.detail || 'Failed to delete tag');
            return;
        }
        await loadTags();
        if (state.activeTagFilter === tagId) {
            state.activeTagFilter = null;
        }
        closeTagManager();
        openTagManager();
        loadHistory();
    } catch (e) {
        console.error('Failed to delete tag', e);
    }
}

// ===== History (Home page) =====

async function loadHistory() {
    state.historyOffset = 0;
    let url = `/api/downloads?limit=${state.historyLimit}&offset=0`;
    if (state.activeTagFilter !== null) {
        url += `&tag_id=${state.activeTagFilter}`;
    }
    try {
        const resp = await fetch(url);
        if (!resp.ok) return;
        const data = await resp.json();
        renderHistory(data, false);
    } catch (e) {
        console.error('Failed to load history', e);
    }
}

async function loadMoreHistory() {
    state.historyOffset += state.historyLimit;
    let url = `/api/downloads?limit=${state.historyLimit}&offset=${state.historyOffset}`;
    if (state.activeTagFilter !== null) {
        url += `&tag_id=${state.activeTagFilter}`;
    }
    try {
        const resp = await fetch(url);
        if (!resp.ok) return;
        const data = await resp.json();
        renderHistory(data, true);
    } catch (e) {
        console.error('Failed to load more history', e);
    }
}

function renderHistory(items, append) {
    const list = $('history-list');
    if (!append) list.innerHTML = '';

    if (items.length === 0 && !append) {
        $('no-history').hidden = false;
        $('load-more-btn').hidden = true;
        return;
    }

    $('no-history').hidden = true;
    $('load-more-btn').hidden = items.length < state.historyLimit;

    for (const item of items) {
        if ($(`job-${item.id}`)) continue;

        const el = document.createElement('div');
        const pinnedClass = item.pinned ? ' history-item-pinned' : '';
        el.className = 'history-item' + pinnedClass;
        el.id = `hist-${item.id}`;

        const thumbHtml = item.thumbnail
            ? `<img class="h-thumb" src="${item.thumbnail}" alt="">`
            : `<div class="h-thumb"></div>`;

        const downloadBtn = item.file_name && item.status === 'done'
            ? `<a class="download-link" href="/files/${encodeURIComponent(item.file_name)}">Download</a>`
            : '';

        const statusClass = item.status === 'done' ? 'color: var(--success)'
            : item.status === 'error' ? 'color: var(--error)'
            : '';

        const pinClass = item.pinned ? 'pin-btn pinned' : 'pin-btn';
        const pinTitle = item.pinned ? 'Unpin' : 'Pin';

        const tagsHtml = (item.tags || []).map(t =>
            `<span class="tag-chip" data-tag-id="${t.id}"
                   style="background:${t.color}20; color:${t.color}; border-color:${t.color}"
                   onclick="filterByTag(${t.id})" title="Filter by ${escHtml(t.name)}">${escHtml(t.name)}</span>`
        ).join('');

        const addTagBtn = `<button class="add-tag-btn" onclick="openTagAssign('${item.id}', this)" title="Add tag">+</button>`;

        const metaParts = [];
        if (item.duration) metaParts.push(formatDuration(item.duration));
        if (item.created_at) metaParts.push(formatDate(item.created_at));
        const metaHtml = metaParts.length > 0
            ? `<span class="h-meta">${metaParts.join(' &middot; ')}${item.url ? ` &middot; <a class="h-source" href="${escHtml(item.url)}" target="_blank" rel="noopener" title="${escHtml(item.url)}">source</a>` : ''}</span>`
            : '';

        el.innerHTML = `
            ${thumbHtml}
            <div class="h-info">
                <span class="h-title" title="${escHtml(item.title || item.url)}">${escHtml(item.title || item.url)}</span>
                ${metaHtml}
                <span class="h-tags">${tagsHtml}${addTagBtn}</span>
            </div>
            <span class="h-format">${formatPresetLabel(item.format_preset)}</span>
            <span class="h-size">${item.file_size ? formatBytes(item.file_size) : ''}</span>
            <span style="${statusClass}; font-size:12px; width:60px; text-align:center">${item.status}</span>
            <span class="h-actions">
                <button class="${pinClass}" onclick="togglePin('${item.id}')" title="${pinTitle}">&#9733;</button>
                ${downloadBtn}
                <button class="delete-btn" onclick="deleteJob('${item.id}')">Delete</button>
            </span>
        `;
        list.appendChild(el);
    }
}

async function deleteJob(jobId) {
    try {
        await fetch(`/api/downloads/${jobId}?delete_file=true`, { method: 'DELETE' });
        const el = $(`hist-${jobId}`);
        if (el) el.remove();
        const libEl = $(`lib-${jobId}`);
        if (libEl) libEl.remove();
        if ($('history-list').children.length === 0) {
            $('no-history').hidden = false;
        }
        loadTags(); // Refresh counts
    } catch (e) {
        console.error('Failed to delete', e);
    }
}

// ===== Library Page =====

function buildLibraryUrl() {
    const lib = state.library;
    let url = `/api/downloads?limit=${lib.limit}&offset=${lib.offset}`;
    url += `&sort_by=${lib.sortBy}&sort_order=${lib.sortOrder}`;
    url += `&status=done`; // Library only shows completed downloads

    if (lib.tagIds.size > 0) url += `&tag_ids=${[...lib.tagIds].join(',')}`;
    if (lib.search) url += `&search=${encodeURIComponent(lib.search)}`;

    return url;
}

async function loadLibrary() {
    state.library.offset = 0;
    state.library.selected.clear();
    updateBulkUI();

    try {
        const resp = await fetch(buildLibraryUrl());
        if (!resp.ok) return;
        state.library.items = await resp.json();
        renderLibrary(false);
    } catch (e) {
        console.error('Failed to load library', e);
    }
}

async function loadMoreLibrary() {
    state.library.offset += state.library.limit;
    try {
        const resp = await fetch(buildLibraryUrl());
        if (!resp.ok) return;
        const more = await resp.json();
        state.library.items.push(...more);
        renderLibrary(true, more);
    } catch (e) {
        console.error('Failed to load more library', e);
    }
}

function renderLibrary(append, newItems) {
    const list = $('library-list');
    const items = append ? (newItems || []) : state.library.items;

    if (!append) list.innerHTML = '';

    if (state.library.items.length === 0) {
        $('no-library').hidden = false;
        $('library-load-more').hidden = true;
        return;
    }

    $('no-library').hidden = true;
    $('library-load-more').hidden = items.length < state.library.limit;

    for (const item of items) {
        const el = document.createElement('div');
        const pinnedClass = item.pinned ? ' pinned' : '';
        const selectedClass = state.library.selected.has(item.id) ? ' selected' : '';
        el.className = 'library-item' + pinnedClass + selectedClass;
        el.id = `lib-${item.id}`;

        const thumbHtml = item.thumbnail
            ? `<img class="lib-thumb" src="${item.thumbnail}" alt="">`
            : `<div class="lib-thumb"></div>`;

        const downloadBtn = item.file_name
            ? `<a class="download-link" href="/files/${encodeURIComponent(item.file_name)}">Download</a>`
            : '';

        const pinClass = item.pinned ? 'pin-btn pinned' : 'pin-btn';

        const tagsHtml = (item.tags || []).map(t =>
            `<span class="tag-chip" data-tag-id="${t.id}"
                   style="background:${t.color}20; color:${t.color}; border-color:${t.color}">${escHtml(t.name)}</span>`
        ).join('');

        const addTagBtn = `<button class="add-tag-btn" onclick="openTagAssign('${item.id}', this)" title="Add tag">+</button>`;

        const metaParts = [];
        if (item.format_preset) metaParts.push(formatPresetLabel(item.format_preset));
        if (item.created_at) metaParts.push(formatDate(item.created_at));
        if (item.url) {
            let hostname = '';
            try { hostname = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
            if (hostname) metaParts.push(hostname);
        }

        el.innerHTML = `
            <input type="checkbox" class="lib-checkbox"
                   ${state.library.selected.has(item.id) ? 'checked' : ''}
                   onchange="toggleLibrarySelect('${item.id}', this.checked)">
            ${thumbHtml}
            <div class="lib-info">
                <span class="lib-title" title="${escHtml(item.title || item.url)}">${escHtml(item.title || item.url)}</span>
                <span class="lib-meta">${metaParts.join(' &middot; ')}</span>
                <span class="lib-tags">${tagsHtml}${addTagBtn}</span>
            </div>
            <span class="lib-duration">${formatDuration(item.duration)}</span>
            <span class="lib-size">${item.file_size ? formatBytes(item.file_size) : ''}</span>
            <span class="lib-pin">
                <button class="${pinClass}" onclick="togglePin('${item.id}')" title="${item.pinned ? 'Unpin' : 'Pin'}">&#9733;</button>
            </span>
            <span class="lib-actions">
                ${downloadBtn}
                <button class="delete-btn" onclick="deleteJob('${item.id}')" style="border-color:var(--error);color:var(--error)">Del</button>
            </span>
        `;
        list.appendChild(el);
    }
}

function renderLibraryTagFilters() {
    const container = $('library-tag-filters');
    if (!container) return;

    const lib = state.library;

    // "All" chip — active when no tags selected
    let html = `<span class="tag-filter-chip ${lib.tagIds.size === 0 ? 'active' : ''}"
                     onclick="clearLibraryTagFilter()">All</span>`;

    for (const t of state.tags) {
        const active = lib.tagIds.has(t.id);
        const style = active
            ? `background:${t.color}; border-color:${t.color}; color:#fff`
            : '';
        html += `<span class="tag-filter-chip ${active ? 'active' : ''}" style="${style}"
                       onclick="toggleLibraryTagFilter(${t.id})">${escHtml(t.name)} (${t.count || 0})</span>`;
    }

    // Create tag button
    html += `<button class="tag-manage-btn" onclick="openTagManager()">+ New Tag</button>`;

    container.innerHTML = html;
}

function toggleLibraryTagFilter(tagId) {
    const lib = state.library;
    if (lib.tagIds.has(tagId)) {
        lib.tagIds.delete(tagId);
    } else {
        lib.tagIds.add(tagId);
    }
    renderLibraryTagFilters();
    loadLibrary();
}

function clearLibraryTagFilter() {
    state.library.tagIds.clear();
    renderLibraryTagFilters();
    loadLibrary();
}

let _libSearchTimer = null;

function onLibrarySearch(value) {
    clearTimeout(_libSearchTimer);
    _libSearchTimer = setTimeout(() => {
        state.library.search = value.trim();
        loadLibrary();
    }, 400);
}

function onLibrarySortChange() {
    state.library.sortBy = $('library-sort-by').value;
    loadLibrary();
}

function toggleLibrarySortOrder() {
    const lib = state.library;
    lib.sortOrder = lib.sortOrder === 'desc' ? 'asc' : 'desc';
    $('library-sort-order').innerHTML = lib.sortOrder === 'desc' ? '&#9660;' : '&#9650;';
    loadLibrary();
}

// Library Bulk Selection

function toggleLibrarySelect(jobId, checked) {
    if (checked) {
        state.library.selected.add(jobId);
    } else {
        state.library.selected.delete(jobId);
    }

    const el = $(`lib-${jobId}`);
    if (el) el.classList.toggle('selected', checked);

    updateBulkUI();
}

function clearBulkSelection() {
    state.library.selected.clear();
    document.querySelectorAll('.lib-checkbox').forEach(cb => {
        cb.checked = false;
    });
    document.querySelectorAll('.library-item.selected').forEach(el => {
        el.classList.remove('selected');
    });
    updateBulkUI();
}

function updateBulkUI() {
    const count = state.library.selected.size;
    $('bulk-actions').hidden = count === 0;
    $('bulk-count').textContent = `${count} selected`;
}

async function bulkPin(pinned) {
    const ids = [...state.library.selected];
    if (ids.length === 0) return;
    try {
        await fetch('/api/downloads/bulk/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, pinned }),
        });
        clearBulkSelection();
        loadLibrary();
    } catch (e) {
        console.error('Bulk pin failed', e);
    }
}

function openBulkTagAssign() {
    closeTagAssign();

    const ids = [...state.library.selected];
    if (ids.length === 0) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'bulk-tag-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    let html = '<div class="modal-content" style="width:300px">';
    html += '<div class="modal-header"><h3>Add Tag to Selected</h3><button class="modal-close" onclick="document.getElementById(\'bulk-tag-overlay\').remove()">&times;</button></div>';
    html += '<div class="modal-body">';
    for (const t of state.tags) {
        html += `<div class="tag-assign-row" style="padding:6px 0; cursor:pointer"
                      onclick="doBulkTag(${t.id})">
            <span class="tag-chip" style="background:${t.color}20; color:${t.color}; border-color:${t.color}">${escHtml(t.name)}</span>
        </div>`;
    }
    if (state.tags.length === 0) {
        html += '<p class="muted">No tags yet</p>';
    }
    html += '</div></div>';
    overlay.innerHTML = html;
    document.body.appendChild(overlay);
}

async function doBulkTag(tagId) {
    const ids = [...state.library.selected];
    const overlay = $('bulk-tag-overlay');
    if (overlay) overlay.remove();

    try {
        await fetch('/api/downloads/bulk/tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, tag_id: tagId }),
        });
        clearBulkSelection();
        loadLibrary();
        loadTags();
    } catch (e) {
        console.error('Bulk tag failed', e);
    }
}

async function bulkDelete() {
    const ids = [...state.library.selected];
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} file(s)? This will also remove the files from disk.`)) return;

    try {
        await fetch('/api/downloads/bulk/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
        clearBulkSelection();
        loadLibrary();
        loadTags();
        loadHistory();
    } catch (e) {
        console.error('Bulk delete failed', e);
    }
}

// ===== Playlists =====

async function loadPlaylists() {
    try {
        const resp = await fetch('/api/playlists');
        if (!resp.ok) return;
        state.playlists.items = await resp.json();
        renderPlaylists();
    } catch (e) {
        console.error('Failed to load playlists', e);
    }
}

function renderPlaylists() {
    const list = $('playlists-list');
    list.innerHTML = '';
    const items = state.playlists.items;

    if (items.length === 0) {
        $('no-playlists').hidden = false;
        return;
    }
    $('no-playlists').hidden = true;

    for (const pl of items) {
        const el = document.createElement('div');
        el.className = 'playlist-card';
        el.onclick = (e) => {
            if (e.target.closest('button')) return;
            openPlaylistDetail(pl.id);
        };

        const typeBadge = `<span class="playlist-type-badge ${pl.type === 'smart' ? 'smart' : ''}">${pl.type === 'smart' ? 'Smart' : 'Manual'}</span>`;
        const count = pl.item_count || 0;

        el.innerHTML = `
            <div class="playlist-card-header">
                <span class="playlist-card-name">${escHtml(pl.name)}</span>
                ${typeBadge}
            </div>
            <div class="playlist-card-meta">
                <span>${count} track${count !== 1 ? 's' : ''}</span>
            </div>
            <div class="playlist-card-actions">
                <button onclick="playPlaylist(${pl.id})">&#9654; Play</button>
                <button onclick="window.open('/api/playlists/${pl.id}/m3u')">M3U</button>
                <button onclick="copyPlaylistUrl(${pl.id})">Copy URL</button>
                <button onclick="event.stopPropagation(); deletePlaylist(${pl.id})" style="border-color:var(--error);color:var(--error)">Delete</button>
            </div>
        `;
        list.appendChild(el);
    }
}

async function openPlaylistDetail(playlistId) {
    try {
        const resp = await fetch(`/api/playlists/${playlistId}`);
        if (!resp.ok) return;
        const pl = await resp.json();
        state.playlists.activeId = playlistId;
        state.playlists.activePlaylist = pl;
        state.playlists.activeItems = pl.items || [];

        $('playlists-list-view').hidden = true;
        $('playlist-detail-view').hidden = false;
        $('playlist-detail-name').textContent = pl.name;
        const typeBadge = $('playlist-detail-type');
        typeBadge.textContent = pl.type === 'smart' ? 'Smart' : 'Manual';
        typeBadge.className = 'playlist-type-badge' + (pl.type === 'smart' ? ' smart' : '');

        // Show/hide smart settings
        const smartSettings = $('smart-playlist-settings');
        const addTracksBtn = $('add-tracks-btn');
        if (pl.type === 'smart') {
            smartSettings.hidden = false;
            addTracksBtn.hidden = true;
            renderSmartTagChips(pl);
            // Set sort controls
            $('smart-sort-by').value = pl.smart_sort || 'created_at';
            $('smart-sort-order').innerHTML = (pl.smart_order || 'desc') === 'desc' ? '&#9660;' : '&#9650;';
        } else {
            smartSettings.hidden = true;
            addTracksBtn.hidden = false;
        }

        renderPlaylistTracks();
    } catch (e) {
        console.error('Failed to open playlist', e);
    }
}

function renderSmartTagChips(pl) {
    const container = $('smart-tag-chips');
    const selectedIds = new Set((pl.smart_tag_ids || '').split(',').filter(x => x).map(Number));

    let html = '';
    for (const t of state.tags) {
        const active = selectedIds.has(t.id);
        const style = active
            ? `background:${t.color}; border-color:${t.color}; color:#fff`
            : `background:${t.color}20; color:${t.color}; border-color:${t.color}`;
        html += `<span class="tag-filter-chip ${active ? 'active' : ''}" style="${style}"
                       onclick="toggleSmartTag(${t.id})">${escHtml(t.name)}</span>`;
    }
    container.innerHTML = html;
}

async function toggleSmartTag(tagId) {
    const pl = state.playlists.activePlaylist;
    if (!pl) return;
    const current = new Set((pl.smart_tag_ids || '').split(',').filter(x => x).map(Number));
    if (current.has(tagId)) current.delete(tagId);
    else current.add(tagId);
    const newTagIds = [...current].join(',');
    try {
        await fetch(`/api/playlists/${pl.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ smart_tag_ids: newTagIds }),
        });
        pl.smart_tag_ids = newTagIds;
        renderSmartTagChips(pl);
        // Reload items
        const resp = await fetch(`/api/playlists/${pl.id}`);
        if (resp.ok) {
            const data = await resp.json();
            state.playlists.activeItems = data.items || [];
            renderPlaylistTracks();
        }
    } catch (e) {
        console.error('Failed to update smart tags', e);
    }
}

async function onSmartSortChange() {
    const pl = state.playlists.activePlaylist;
    if (!pl) return;
    const sortBy = $('smart-sort-by').value;
    try {
        await fetch(`/api/playlists/${pl.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ smart_sort: sortBy }),
        });
        pl.smart_sort = sortBy;
        const resp = await fetch(`/api/playlists/${pl.id}`);
        if (resp.ok) {
            const data = await resp.json();
            state.playlists.activeItems = data.items || [];
            renderPlaylistTracks();
        }
    } catch (e) {
        console.error('Failed to update smart sort', e);
    }
}

async function toggleSmartSortOrder() {
    const pl = state.playlists.activePlaylist;
    if (!pl) return;
    const newOrder = (pl.smart_order || 'desc') === 'desc' ? 'asc' : 'desc';
    try {
        await fetch(`/api/playlists/${pl.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ smart_order: newOrder }),
        });
        pl.smart_order = newOrder;
        $('smart-sort-order').innerHTML = newOrder === 'desc' ? '&#9660;' : '&#9650;';
        const resp = await fetch(`/api/playlists/${pl.id}`);
        if (resp.ok) {
            const data = await resp.json();
            state.playlists.activeItems = data.items || [];
            renderPlaylistTracks();
        }
    } catch (e) {
        console.error('Failed to toggle smart sort order', e);
    }
}

function renderPlaylistTracks() {
    const container = $('playlist-tracks');
    container.innerHTML = '';
    const items = state.playlists.activeItems;
    const pl = state.playlists.activePlaylist;
    const isManual = pl && pl.type === 'manual';

    if (items.length === 0) {
        $('no-tracks').hidden = false;
        return;
    }
    $('no-tracks').hidden = true;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const el = document.createElement('div');
        el.className = 'playlist-track';
        el.dataset.downloadId = item.id;
        const isPlaying = state.player.playlistId === state.playlists.activeId &&
                          state.player.currentIndex === i;
        if (isPlaying) el.classList.add('playing');

        const dragHandle = isManual
            ? `<span class="drag-handle" draggable="true">&#9776;</span>`
            : '';
        const removeBtn = isManual
            ? `<button class="track-remove" onclick="removeTrack('${item.id}')" title="Remove">&times;</button>`
            : '';
        const thumbHtml = item.thumbnail
            ? `<img class="track-thumb" src="${item.thumbnail}" alt="">`
            : `<div class="track-thumb"></div>`;

        el.innerHTML = `
            ${dragHandle}
            <span class="track-num">${i + 1}</span>
            ${thumbHtml}
            <div class="track-info">
                <span class="track-title" title="${escHtml(item.title || item.url || '')}">${escHtml(item.title || 'Untitled')}</span>
            </div>
            <span class="track-duration">${formatDuration(item.duration)}</span>
            ${removeBtn}
        `;

        // Click to play
        el.addEventListener('click', (e) => {
            if (e.target.closest('.drag-handle') || e.target.closest('.track-remove')) return;
            playFromIndex(i);
        });

        container.appendChild(el);
    }

    if (isManual) initDragReorder();
}

function backToPlaylistList() {
    state.playlists.activeId = null;
    state.playlists.activePlaylist = null;
    state.playlists.activeItems = [];
    $('playlists-list-view').hidden = false;
    $('playlist-detail-view').hidden = true;
    loadPlaylists();
}

async function removeTrack(downloadId) {
    const plId = state.playlists.activeId;
    if (!plId) return;
    try {
        await fetch(`/api/playlists/${plId}/items/${downloadId}`, { method: 'DELETE' });
        state.playlists.activeItems = state.playlists.activeItems.filter(i => i.id !== downloadId);
        renderPlaylistTracks();
    } catch (e) {
        console.error('Failed to remove track', e);
    }
}

async function deletePlaylist(playlistId) {
    if (!confirm('Delete this playlist?')) return;
    try {
        await fetch(`/api/playlists/${playlistId}`, { method: 'DELETE' });
        if (state.playlists.activeId === playlistId) backToPlaylistList();
        else loadPlaylists();
    } catch (e) {
        console.error('Failed to delete playlist', e);
    }
}

// Create Playlist Modal

function openCreatePlaylistModal() {
    $('create-playlist-modal').hidden = false;
    $('new-playlist-name').value = '';
    $('new-playlist-name').focus();
    document.querySelector('input[name="playlist-type"][value="manual"]').checked = true;
    toggleSmartOptions();
    renderSmartCreateTags();
}

function closeCreatePlaylistModal() {
    $('create-playlist-modal').hidden = true;
}

function toggleSmartOptions() {
    const isSmart = document.querySelector('input[name="playlist-type"]:checked').value === 'smart';
    $('smart-options').hidden = !isSmart;
}

function renderSmartCreateTags() {
    const container = $('smart-create-tags');
    container._selectedTags = container._selectedTags || new Set();
    let html = '';
    for (const t of state.tags) {
        const active = container._selectedTags.has(t.id);
        const style = active
            ? `background:${t.color}; border-color:${t.color}; color:#fff`
            : `background:${t.color}20; color:${t.color}; border-color:${t.color}`;
        html += `<span class="tag-filter-chip ${active ? 'active' : ''}" style="${style}"
                       onclick="toggleSmartCreateTag(${t.id})">${escHtml(t.name)}</span>`;
    }
    container.innerHTML = html;
}

function toggleSmartCreateTag(tagId) {
    const container = $('smart-create-tags');
    if (!container._selectedTags) container._selectedTags = new Set();
    if (container._selectedTags.has(tagId)) container._selectedTags.delete(tagId);
    else container._selectedTags.add(tagId);
    renderSmartCreateTags();
}

async function confirmCreatePlaylist() {
    const name = $('new-playlist-name').value.trim();
    if (!name) { alert('Please enter a name'); return; }
    const type = document.querySelector('input[name="playlist-type"]:checked').value;
    const body = { name, type };
    if (type === 'smart') {
        const container = $('smart-create-tags');
        const tagIds = container._selectedTags ? [...container._selectedTags] : [];
        body.smart_tag_ids = tagIds.join(',');
    }
    try {
        const resp = await fetch('/api/playlists', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const err = await resp.json();
            alert(err.detail || 'Failed to create playlist');
            return;
        }
        closeCreatePlaylistModal();
        $('smart-create-tags')._selectedTags = new Set();
        loadPlaylists();
    } catch (e) {
        console.error('Failed to create playlist', e);
    }
}

// Add Tracks Modal

let _addTracksCandidates = [];
let _addTracksSelected = new Set();

function openAddToPlaylistModal() {
    $('add-tracks-modal').hidden = false;
    $('add-tracks-search').value = '';
    _addTracksSelected.clear();
    searchPlaylistCandidates('');
}

function closeAddTracksModal() {
    $('add-tracks-modal').hidden = true;
}

async function searchPlaylistCandidates(query) {
    let url = `/api/downloads?limit=100&offset=0&status=done`;
    if (query) url += `&search=${encodeURIComponent(query)}`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) return;
        _addTracksCandidates = await resp.json();
        renderPlaylistCandidates();
    } catch (e) {
        console.error('Failed to search candidates', e);
    }
}

function renderPlaylistCandidates() {
    const container = $('playlist-candidates-list');
    const existingIds = new Set(state.playlists.activeItems.map(i => i.id));
    const candidates = _addTracksCandidates.filter(c => !existingIds.has(c.id));

    if (candidates.length === 0) {
        container.innerHTML = '<p class="muted" style="padding:12px">No matching files</p>';
        return;
    }

    container.innerHTML = candidates.map(c => {
        const checked = _addTracksSelected.has(c.id) ? 'checked' : '';
        const thumbHtml = c.thumbnail
            ? `<img class="cand-thumb" src="${c.thumbnail}" alt="">`
            : `<div class="cand-thumb"></div>`;
        return `<label class="candidate-item">
            <input type="checkbox" ${checked} onchange="toggleCandidateSelect('${c.id}', this.checked)">
            ${thumbHtml}
            <span class="cand-title">${escHtml(c.title || c.url || 'Untitled')}</span>
            <span class="cand-duration">${formatDuration(c.duration)}</span>
        </label>`;
    }).join('');
}

function toggleCandidateSelect(id, checked) {
    if (checked) _addTracksSelected.add(id);
    else _addTracksSelected.delete(id);
}

async function confirmAddToPlaylist() {
    const plId = state.playlists.activeId;
    if (!plId || _addTracksSelected.size === 0) return;

    for (const dlId of _addTracksSelected) {
        try {
            await fetch(`/api/playlists/${plId}/items`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ download_id: dlId }),
            });
        } catch (e) {
            console.error('Failed to add track', dlId, e);
        }
    }

    closeAddTracksModal();
    _addTracksSelected.clear();
    // Reload playlist detail
    openPlaylistDetail(plId);
}

// M3U / Copy URL

function downloadCurrentM3U() {
    const plId = state.playlists.activeId;
    if (plId) window.open(`/api/playlists/${plId}/m3u`);
}

function copyPlaylistUrl(plId) {
    const url = `${location.origin}/api/playlists/${plId}/m3u`;
    navigator.clipboard.writeText(url).then(() => {
        // Brief visual feedback could go here
    }).catch(e => console.error('Failed to copy', e));
}

function copyCurrentPlaylistUrl() {
    const plId = state.playlists.activeId;
    if (plId) copyPlaylistUrl(plId);
}

// ===== Drag & Drop Reorder =====

function initDragReorder() {
    const container = $('playlist-tracks');
    let dragEl = null;

    container.addEventListener('dragstart', (e) => {
        const handle = e.target.closest('.drag-handle');
        if (!handle) { e.preventDefault(); return; }
        dragEl = handle.closest('.playlist-track');
        if (!dragEl) return;
        dragEl.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
    });

    container.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!dragEl) return;
        const afterEl = getDragAfterElement(container, e.clientY);
        if (afterEl) container.insertBefore(dragEl, afterEl);
        else container.appendChild(dragEl);
    });

    container.addEventListener('dragend', () => {
        if (!dragEl) return;
        dragEl.classList.remove('dragging');
        dragEl = null;
        saveDragOrder();
    });
}

function getDragAfterElement(container, y) {
    const elements = [...container.querySelectorAll('.playlist-track:not(.dragging)')];
    return elements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset, element: child };
        }
        return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element || null;
}

async function saveDragOrder() {
    const container = $('playlist-tracks');
    const ids = [...container.querySelectorAll('.playlist-track')].map(el => el.dataset.downloadId);
    const plId = state.playlists.activeId;
    if (!plId) return;

    // Update track numbers visually
    container.querySelectorAll('.playlist-track').forEach((el, i) => {
        const num = el.querySelector('.track-num');
        if (num) num.textContent = i + 1;
    });

    // Update state
    const itemMap = {};
    for (const item of state.playlists.activeItems) itemMap[item.id] = item;
    state.playlists.activeItems = ids.map(id => itemMap[id]).filter(Boolean);

    try {
        await fetch(`/api/playlists/${plId}/reorder`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
    } catch (e) {
        console.error('Failed to save order', e);
    }
}

// ===== Audio Player =====

function getAudioEl() { return $('player-audio'); }

async function playPlaylist(playlistId) {
    try {
        const resp = await fetch(`/api/playlists/${playlistId}`);
        if (!resp.ok) return;
        const pl = await resp.json();
        const items = pl.items || [];
        if (items.length === 0) return;

        state.player.playlistId = playlistId;
        state.player.items = items;
        state.player.currentIndex = 0;
        playTrack(0);
    } catch (e) {
        console.error('Failed to play playlist', e);
    }
}

function playCurrentPlaylist() {
    const plId = state.playlists.activeId;
    if (plId) playPlaylist(plId);
}

function playFromIndex(index) {
    const plId = state.playlists.activeId;
    if (!plId) return;
    // If different playlist, load items first
    if (state.player.playlistId !== plId) {
        state.player.playlistId = plId;
        state.player.items = [...state.playlists.activeItems];
    }
    state.player.currentIndex = index;
    playTrack(index);
}

function playTrack(index) {
    const items = state.player.items;
    if (index < 0 || index >= items.length) return;

    state.player.currentIndex = index;
    state.player.playing = true;

    const item = items[index];
    const audio = getAudioEl();
    if (!item.file_name) return;

    audio.src = `/files/${encodeURIComponent(item.file_name)}`;
    audio.play().catch(e => console.error('Playback error', e));

    $('player-bar').hidden = false;
    document.body.classList.add('player-active');
    updatePlayerUI();
    highlightCurrentTrack();
}

function updatePlayerUI() {
    const item = state.player.items[state.player.currentIndex];
    if (!item) return;
    $('player-title').textContent = item.title || 'Untitled';

    const playIcon = $('player-play-icon');
    if (state.player.playing) {
        playIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    } else {
        playIcon.innerHTML = '<polygon points="5,3 19,12 5,21"/>';
    }
}

function highlightCurrentTrack() {
    document.querySelectorAll('.playlist-track.playing').forEach(el => el.classList.remove('playing'));
    if (state.player.playlistId === state.playlists.activeId) {
        const tracks = $('playlist-tracks')?.querySelectorAll('.playlist-track') || [];
        if (tracks[state.player.currentIndex]) {
            tracks[state.player.currentIndex].classList.add('playing');
        }
    }
}

function playerToggle() {
    const audio = getAudioEl();
    if (audio.paused) {
        audio.play().catch(() => {});
        state.player.playing = true;
    } else {
        audio.pause();
        state.player.playing = false;
    }
    updatePlayerUI();
}

function playerNext() {
    const next = state.player.currentIndex + 1;
    if (next < state.player.items.length) {
        playTrack(next);
    }
}

function playerPrev() {
    const audio = getAudioEl();
    // If > 3 seconds into track, restart; otherwise go to previous
    if (audio.currentTime > 3) {
        audio.currentTime = 0;
        return;
    }
    const prev = state.player.currentIndex - 1;
    if (prev >= 0) {
        playTrack(prev);
    }
}

function playerSeek(value) {
    const audio = getAudioEl();
    if (audio.duration) {
        audio.currentTime = (value / 100) * audio.duration;
    }
}

function playerSetVolume(value) {
    getAudioEl().volume = parseFloat(value);
}

function formatPlayerTime(secs) {
    if (!secs || !isFinite(secs)) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function initPlayerEvents() {
    const audio = getAudioEl();

    audio.addEventListener('timeupdate', () => {
        if (!audio.duration) return;
        const pct = (audio.currentTime / audio.duration) * 100;
        $('player-seek').value = pct;
        $('player-current-time').textContent = formatPlayerTime(audio.currentTime);
        $('player-total-time').textContent = formatPlayerTime(audio.duration);
    });

    audio.addEventListener('ended', () => {
        state.player.playing = false;
        playerNext();
    });

    audio.addEventListener('play', () => {
        state.player.playing = true;
        updatePlayerUI();
    });

    audio.addEventListener('pause', () => {
        state.player.playing = false;
        updatePlayerUI();
    });
}

// ===== Init =====

async function loadVersion() {
    try {
        const resp = await fetch('/api/version');
        if (resp.ok) {
            const data = await resp.json();
            $('version-info').textContent = `yt-dlp ${data.yt_dlp_version}`;
        }
    } catch (e) {
        console.error('Failed to load version', e);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    loadVersion();
    loadTags();
    loadHistory();
    loadExtractors();
    initRouter();
    initPlayerEvents();

    const urlInput = $('url-input');
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') fetchInfo();
    });
    urlInput.addEventListener('input', (e) => {
        onUrlInput(e.target.value);
    });

    // Start sidebar collapsed
    $('sidebar').classList.add('collapsed');
});
