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
};

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

function formatPresetLabel(preset) {
    const labels = {
        best_video: 'Best Video',
        audio_mp3: 'MP3',
        video_720p: '720p',
        video_1080p: '1080p',
    };
    return labels[preset] || preset;
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

    // Try to extract hostname from URL
    let hostname = '';
    try {
        const parsed = new URL(url);
        hostname = parsed.hostname.replace(/^www\./, '').replace(/^m\./, '');
    } catch {
        // Not a valid URL yet — hide warning
        warning.hidden = true;
        return;
    }

    if (!hostname) {
        warning.hidden = true;
        return;
    }

    // Check if any extractor name/description matches the hostname
    const hl = hostname.toLowerCase();
    // Extract domain name without TLD for matching (e.g. "youtube" from "youtube.com")
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

    // Show estimated sizes per preset
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
    const btn = $('download-btn');
    setLoading(btn, true);
    hideError();

    try {
        const resp = await fetch('/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: state.url, format_preset: format }),
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
        <div class="job-card-actions" data-field="actions" hidden>
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

    if (msg.type === 'complete' && msg.status === 'done') {
        get('status').textContent = 'done';
        get('bar').style.width = '100%';
        get('progress').textContent = `Done${msg.file_size ? ' — ' + formatBytes(msg.file_size) : ''}`;
        card.className = 'job-card status-done';

        if (msg.file_name) {
            const link = get('download-link');
            link.href = `/files/${encodeURIComponent(msg.file_name)}`;
            link.hidden = false;
            get('actions').hidden = false;
        }

        loadHistory();
    }

    if (msg.type === 'complete' && msg.status === 'error') {
        get('status').textContent = 'error';
        get('progress').textContent = 'Failed';
        card.className = 'job-card status-error';
        const errEl = get('error');
        errEl.textContent = msg.error_msg || 'Unknown error';
        errEl.hidden = false;
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
        // Cleanup after a delay
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

// --- History ---

async function loadHistory() {
    state.historyOffset = 0;
    try {
        const resp = await fetch(`/api/downloads?limit=${state.historyLimit}&offset=0`);
        if (!resp.ok) return;
        const data = await resp.json();
        renderHistory(data, false);
    } catch (e) {
        console.error('Failed to load history', e);
    }
}

async function loadMoreHistory() {
    state.historyOffset += state.historyLimit;
    try {
        const resp = await fetch(
            `/api/downloads?limit=${state.historyLimit}&offset=${state.historyOffset}`);
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
        el.className = 'history-item';
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

        el.innerHTML = `
            ${thumbHtml}
            <span class="h-title" title="${item.title || item.url}">${item.title || item.url}</span>
            <span class="h-format">${formatPresetLabel(item.format_preset)}</span>
            <span class="h-size">${item.file_size ? formatBytes(item.file_size) : ''}</span>
            <span style="${statusClass}; font-size:12px; width:60px; text-align:center">${item.status}</span>
            <span class="h-actions">
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
        // Check if history is now empty
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
    loadHistory();
    loadExtractors();

    // URL input: Enter key triggers fetch, typing checks support
    const urlInput = $('url-input');
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') fetchInfo();
    });
    urlInput.addEventListener('input', (e) => {
        onUrlInput(e.target.value);
    });
});
