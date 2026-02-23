/* yt-dlp Web — Frontend */

const state = {
    url: '',
    info: null,
    selectedFormat: 'best_video',
    activeJobs: {},   // jobId -> { ws, data }
    historyOffset: 0,
    historyLimit: 50,
    extractors: [],   // [{name, description}, ...]
    panelOpen: false,
    tags: [],              // [{id, name, color}, ...]
    activeTagFilter: null, // tag_id or null for "all"
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

// --- Side Panel: Extractors ---

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

function toggleSidePanel() {
    const panel = $('side-panel');
    state.panelOpen = !state.panelOpen;
    panel.classList.toggle('collapsed', !state.panelOpen);
}

// --- URL Support Check ---

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

// --- Fetch Info ---

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

// --- Start Download ---

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

// --- Active Jobs UI ---

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

// --- WebSocket ---

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

// --- Pin ---

async function togglePin(jobId) {
    try {
        const resp = await fetch(`/api/downloads/${jobId}/pin`, { method: 'PATCH' });
        if (!resp.ok) return;
        const data = await resp.json();
        const el = $(`hist-${jobId}`);
        if (el) {
            const pinBtn = el.querySelector('.pin-btn');
            if (pinBtn) {
                pinBtn.classList.toggle('pinned', data.pinned);
                pinBtn.title = data.pinned ? 'Unpin' : 'Pin';
            }
            el.classList.toggle('history-item-pinned', data.pinned);
        }
    } catch (e) {
        console.error('Failed to toggle pin', e);
    }
}

// --- Tags ---

async function loadTags() {
    try {
        const resp = await fetch('/api/tags');
        if (!resp.ok) return;
        state.tags = await resp.json();
        renderTagFilter();
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

// --- Tag Assignment Popover ---

function openTagAssign(downloadId, anchorEl) {
    closeTagAssign();

    const pop = document.createElement('div');
    pop.className = 'tag-assign-popover';
    pop.id = 'tag-assign-popover';

    // Get current tags from the history item's data attributes
    const histEl = $(`hist-${downloadId}`);
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

    // Position relative to the h-tags container
    const tagsContainer = anchorEl.closest('.h-tags');
    if (tagsContainer) {
        tagsContainer.style.position = 'relative';
        tagsContainer.appendChild(pop);
    } else {
        anchorEl.parentElement.style.position = 'relative';
        anchorEl.parentElement.appendChild(pop);
    }

    // Close on outside click (defer to avoid immediate close)
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
    } catch (e) {
        console.error('Failed to toggle tag', e);
    }
    closeTagAssign();
}

// --- Tag Manager Modal ---

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
        ? state.tags.map(t =>
            `<div class="tag-manager-row" data-tag-id="${t.id}">
                <span class="tag-chip" style="background:${t.color}20; color:${t.color}; border-color:${t.color}">${escHtml(t.name)}</span>
                <span style="flex:1"></span>
                <button class="btn-sm" onclick="renameTag(${t.id}, '${escHtml(t.name)}')">Rename</button>
                <button class="btn-sm btn-danger" onclick="removeTag(${t.id})">Delete</button>
            </div>`
        ).join('')
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

    // Allow Enter key to create tag
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
        await fetch(`/api/tags/${tagId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName.trim() }),
        });
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
        await fetch(`/api/tags/${tagId}`, { method: 'DELETE' });
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

// --- History ---

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
        // Skip items that are currently active
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

        // Build tag chips
        const tagsHtml = (item.tags || []).map(t =>
            `<span class="tag-chip" data-tag-id="${t.id}"
                   style="background:${t.color}20; color:${t.color}; border-color:${t.color}"
                   onclick="filterByTag(${t.id})" title="Filter by ${escHtml(t.name)}">${escHtml(t.name)}</span>`
        ).join('');

        const addTagBtn = `<button class="add-tag-btn" onclick="openTagAssign('${item.id}', this)" title="Add tag">+</button>`;

        // Meta info line: duration, date, source
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
        if ($('history-list').children.length === 0) {
            $('no-history').hidden = false;
        }
    } catch (e) {
        console.error('Failed to delete', e);
    }
}

// --- Init ---

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

    const urlInput = $('url-input');
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') fetchInfo();
    });
    urlInput.addEventListener('input', (e) => {
        onUrlInput(e.target.value);
    });
});
