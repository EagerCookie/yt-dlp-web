import asyncio
import logging
import os
import threading
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from web.models import (
    DB_PATH,
    add_playlist_item,
    add_tag_to_download,
    bulk_add_tag,
    bulk_delete,
    bulk_pin,
    create_playlist,
    create_tag,
    delete_download,
    delete_playlist,
    delete_tag,
    get_db,
    get_download,
    get_downloads_older_than,
    get_playlist,
    get_playlist_items,
    get_tag_by_name,
    init_db,
    insert_download,
    list_downloads,
    list_playlists,
    list_tags,
    remove_playlist_item,
    remove_tag_from_download,
    reorder_playlist_items,
    toggle_pin,
    update_download,
    update_playlist,
    update_tag,
)
from web.tasks import (
    DOWNLOAD_DIR,
    FORMAT_PRESETS,
    executor,
    extract_info_only,
    run_download,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger('yt-dlp-web')

CLEANUP_HOURS = int(os.environ.get('CLEANUP_AFTER_HOURS', '0'))


def _remove_thumbnail(row: dict) -> None:
    """Remove local thumbnail file for a download row."""
    thumb = row.get('thumbnail', '') or ''
    if thumb.startswith('/files/thumbs/'):
        thumb_path = os.path.join(DOWNLOAD_DIR, thumb[len('/files/'):])
        try:
            if os.path.exists(thumb_path):
                os.remove(thumb_path)
        except OSError:
            pass


# --- WebSocket manager ---

class ConnectionManager:
    def __init__(self):
        self._sockets: dict[str, list[WebSocket]] = {}
        self._global: list[WebSocket] = []

    async def connect(self, job_id: str, ws: WebSocket) -> None:
        await ws.accept()
        self._sockets.setdefault(job_id, []).append(ws)

    async def connect_global(self, ws: WebSocket) -> None:
        await ws.accept()
        self._global.append(ws)

    def disconnect(self, job_id: str, ws: WebSocket) -> None:
        if job_id in self._sockets:
            self._sockets[job_id] = [s for s in self._sockets[job_id] if s is not ws]
            if not self._sockets[job_id]:
                del self._sockets[job_id]

    def disconnect_global(self, ws: WebSocket) -> None:
        self._global = [s for s in self._global if s is not ws]

    async def broadcast(self, job_id: str, data: dict) -> None:
        dead: list[WebSocket] = []
        for ws in self._sockets.get(job_id, []):
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(job_id, ws)

        # Also send to global listeners
        dead_global: list[WebSocket] = []
        for ws in self._global:
            try:
                await ws.send_json(data)
            except Exception:
                dead_global.append(ws)
        for ws in dead_global:
            self.disconnect_global(ws)


# --- Periodic cleanup ---

async def periodic_cleanup(db, download_dir: str, hours: int) -> None:
    while True:
        await asyncio.sleep(3600)
        try:
            cutoff = time.time() - (hours * 3600)
            old_jobs = await get_downloads_older_than(db, cutoff)
            for job in old_jobs:
                if job.get('file_path') and os.path.exists(job['file_path']):
                    try:
                        os.remove(job['file_path'])
                    except OSError:
                        pass
                _remove_thumbnail(job)
                await delete_download(db, job['id'])
            if old_jobs:
                logger.info('Cleaned up %d old downloads', len(old_jobs))
        except Exception:
            logger.exception('Cleanup error')


# --- Progress consumer ---

async def consume_progress(job_id: str, queue: asyncio.Queue,
                           db, ws_manager: ConnectionManager) -> None:
    """Drain progress queue from worker thread and update DB + broadcast WS."""
    while True:
        data = await queue.get()
        msg_type = data.get('type', '')
        status = data.get('status', '')

        try:
            if msg_type == 'status':
                await update_download(db, job_id, status=status)
            elif msg_type == 'progress':
                if status == 'downloading':
                    await update_download(db, job_id, status='downloading')
                elif status == 'finished':
                    # yt-dlp 'finished' means file written, but post-processing may follow
                    pass
            elif msg_type == 'postprocessor':
                pp_status = data.get('pp_status', '')
                pp_name = data.get('postprocessor', '')
                if pp_status == 'started' and 'Merger' in pp_name:
                    await update_download(db, job_id, status='merging')
            elif msg_type == 'complete':
                if status == 'done':
                    await update_download(
                        db, job_id,
                        status='done',
                        title=data.get('title'),
                        thumbnail=data.get('thumbnail'),
                        duration=data.get('duration'),
                        file_path=data.get('filepath'),
                        file_name=data.get('file_name'),
                        file_size=data.get('file_size'),
                        completed_at=time.time(),
                    )
                    # Auto-tag: assign Audio or Video system tag
                    try:
                        row = await get_download(db, job_id)
                        if row:
                            preset = row.get('format_preset', '')
                            if preset == 'audio_mp3':
                                tag_name = 'Audio'
                            else:
                                tag_name = 'Video'
                            tag = await get_tag_by_name(db, tag_name)
                            if tag:
                                await add_tag_to_download(db, job_id, tag['id'])
                    except Exception:
                        logger.exception('Auto-tag error for job %s', job_id)
                elif status == 'cancelled':
                    await update_download(
                        db, job_id,
                        status='cancelled',
                        error_msg=data.get('error_msg'),
                        completed_at=time.time(),
                    )
                elif status == 'error':
                    await update_download(
                        db, job_id,
                        status='error',
                        error_msg=data.get('error_msg'),
                        completed_at=time.time(),
                    )
        except Exception:
            logger.exception('Error updating DB for job %s', job_id)

        # Broadcast to WebSocket clients
        await ws_manager.broadcast(job_id, data)

        if msg_type == 'complete':
            break


# --- App lifespan ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(os.path.dirname(DB_PATH) or '.', exist_ok=True)
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)

    db = await get_db()
    await init_db(db)
    app.state.db = db
    app.state.ws_manager = ConnectionManager()
    app.state.active_tasks: dict[str, asyncio.Task] = {}
    app.state.cancel_events: dict[str, threading.Event] = {}

    cleanup_task = None
    if CLEANUP_HOURS > 0:
        cleanup_task = asyncio.create_task(
            periodic_cleanup(db, DOWNLOAD_DIR, CLEANUP_HOURS))

    yield

    if cleanup_task:
        cleanup_task.cancel()
    executor.shutdown(wait=False)
    await db.close()


app = FastAPI(title='yt-dlp Web', lifespan=lifespan)

static_dir = os.path.join(os.path.dirname(__file__), 'static')
app.mount('/static', StaticFiles(directory=static_dir), name='static')


# --- Request models ---

class DownloadRequest(BaseModel):
    url: str
    format_preset: str = 'best_video'
    pinned: bool = False


class TagCreate(BaseModel):
    name: str
    color: str = '#3b82f6'


class TagUpdate(BaseModel):
    name: str | None = None
    color: str | None = None


class BulkIds(BaseModel):
    ids: list[str]


class BulkPin(BaseModel):
    ids: list[str]
    pinned: bool


class BulkTag(BaseModel):
    ids: list[str]
    tag_id: int


class PlaylistCreate(BaseModel):
    name: str
    type: str = 'manual'
    smart_tag_ids: str | None = None
    smart_sort: str = 'created_at'
    smart_order: str = 'desc'


class PlaylistUpdate(BaseModel):
    name: str | None = None
    smart_tag_ids: str | None = None
    smart_sort: str | None = None
    smart_order: str | None = None


class PlaylistAddItem(BaseModel):
    download_id: str


class PlaylistReorder(BaseModel):
    ids: list[str]


# --- API endpoints ---

@app.get('/')
async def index():
    return FileResponse(os.path.join(static_dir, 'index.html'))


@app.get('/library')
async def library():
    return FileResponse(os.path.join(static_dir, 'index.html'))


@app.get('/playlists')
async def playlists_page():
    return FileResponse(os.path.join(static_dir, 'index.html'))


@app.get('/api/version')
async def get_version():
    import yt_dlp.version
    return {'yt_dlp_version': yt_dlp.version.__version__}


_extractors_cache: list[dict] | None = None


@app.get('/api/extractors')
async def get_extractors():
    global _extractors_cache
    if _extractors_cache is None:
        from yt_dlp.extractor import list_extractor_classes
        result = []
        seen: set[str] = set()
        for ie in list_extractor_classes():
            if not ie.working() or ie.IE_DESC is False:
                continue
            name = ie.IE_NAME
            if name in seen or name == 'generic':
                continue
            seen.add(name)
            result.append({'name': name, 'description': ie.IE_DESC or ''})
        _extractors_cache = result
    return _extractors_cache


@app.get('/api/info')
async def get_info(url: str = Query(..., description='Video URL')):
    loop = asyncio.get_event_loop()
    try:
        info = await loop.run_in_executor(executor, extract_info_only, url)
        return info
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post('/api/download')
async def start_download(req: DownloadRequest):
    if req.format_preset not in FORMAT_PRESETS:
        raise HTTPException(
            status_code=400,
            detail=f'Invalid format_preset. Must be one of: {list(FORMAT_PRESETS.keys())}',
        )

    job_id = str(uuid.uuid4())
    db = app.state.db
    ws_manager = app.state.ws_manager

    await insert_download(db, job_id, req.url, req.format_preset, pinned=req.pinned)

    loop = asyncio.get_event_loop()
    progress_queue: asyncio.Queue = asyncio.Queue()
    cancel_event = threading.Event()

    # Start worker thread
    loop.run_in_executor(
        executor,
        run_download, job_id, req.url, req.format_preset, loop, progress_queue, cancel_event,
    )

    # Start async consumer
    async def _consume_and_cleanup():
        await consume_progress(job_id, progress_queue, db, ws_manager)
        app.state.active_tasks.pop(job_id, None)
        app.state.cancel_events.pop(job_id, None)

    task = asyncio.create_task(_consume_and_cleanup())
    app.state.active_tasks[job_id] = task
    app.state.cancel_events[job_id] = cancel_event

    return {'job_id': job_id, 'status': 'queued'}


@app.post('/api/downloads/{job_id}/cancel')
async def cancel_download(job_id: str):
    cancel_event = app.state.cancel_events.get(job_id)
    if not cancel_event:
        row = await get_download(app.state.db, job_id)
        if not row:
            raise HTTPException(status_code=404, detail='Download not found')
        raise HTTPException(status_code=400, detail='Download is not active')
    cancel_event.set()
    return {'status': 'cancelling'}


@app.get('/api/downloads')
async def get_downloads(limit: int = Query(50, ge=1, le=200),
                        offset: int = Query(0, ge=0),
                        tag_id: int | None = Query(None),
                        tag_ids: str | None = Query(None),
                        search: str | None = Query(None),
                        sort_by: str = Query('created_at'),
                        sort_order: str = Query('desc'),
                        pinned_only: bool = Query(False),
                        format_preset: str | None = Query(None),
                        status: str | None = Query(None)):
    # Parse comma-separated tag_ids
    parsed_tag_ids = None
    if tag_ids:
        try:
            parsed_tag_ids = [int(x) for x in tag_ids.split(',') if x.strip()]
        except ValueError:
            pass

    rows = await list_downloads(
        app.state.db, limit, offset,
        tag_id=tag_id, tag_ids=parsed_tag_ids, search=search,
        sort_by=sort_by, sort_order=sort_order,
        pinned_only=pinned_only, format_preset=format_preset,
        status=status,
    )
    return rows


@app.get('/api/downloads/{job_id}')
async def get_download_status(job_id: str):
    row = await get_download(app.state.db, job_id)
    if not row:
        raise HTTPException(status_code=404, detail='Download not found')
    return row


@app.delete('/api/downloads/{job_id}')
async def remove_download(job_id: str, delete_file: bool = Query(False)):
    row = await get_download(app.state.db, job_id)
    if not row:
        raise HTTPException(status_code=404, detail='Download not found')

    if delete_file and row.get('file_path'):
        try:
            if os.path.exists(row['file_path']):
                os.remove(row['file_path'])
        except OSError:
            pass
    # Remove local thumbnail
    _remove_thumbnail(row)

    await delete_download(app.state.db, job_id)
    return {'status': 'deleted'}


@app.get('/files/{filename:path}')
async def serve_file(filename: str):
    # Security: prevent path traversal
    if '..' in filename or filename.startswith('/'):
        raise HTTPException(status_code=400, detail='Invalid filename')

    filepath = os.path.join(DOWNLOAD_DIR, filename)
    abs_path = os.path.abspath(filepath)
    abs_dir = os.path.abspath(DOWNLOAD_DIR)

    if not abs_path.startswith(abs_dir):
        raise HTTPException(status_code=400, detail='Invalid filename')

    if not os.path.exists(abs_path):
        raise HTTPException(status_code=404, detail='File not found')

    # Use correct MIME type for thumbnails
    media_type = 'application/octet-stream'
    lower = filename.lower()
    if lower.endswith(('.jpg', '.jpeg')):
        media_type = 'image/jpeg'
    elif lower.endswith('.png'):
        media_type = 'image/png'
    elif lower.endswith('.webp'):
        media_type = 'image/webp'

    return FileResponse(
        abs_path,
        filename=os.path.basename(filename),
        media_type=media_type,
    )


# --- Pin ---

@app.patch('/api/downloads/{job_id}/pin')
async def toggle_pin_download(job_id: str):
    row = await get_download(app.state.db, job_id)
    if not row:
        raise HTTPException(status_code=404, detail='Download not found')
    new_state = await toggle_pin(app.state.db, job_id)
    return {'pinned': new_state}


# --- Tags ---

@app.get('/api/tags')
async def get_tags():
    return await list_tags(app.state.db)


@app.post('/api/tags')
async def create_tag_endpoint(req: TagCreate):
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail='Tag name cannot be empty')
    try:
        tag = await create_tag(app.state.db, name, req.color)
        return tag
    except Exception:
        raise HTTPException(status_code=400, detail='Tag name already exists')


@app.patch('/api/tags/{tag_id}')
async def update_tag_endpoint(tag_id: int, req: TagUpdate):
    # Check if system tag — only allow color change, not rename
    tags = await list_tags(app.state.db)
    tag = next((t for t in tags if t['id'] == tag_id), None)
    if tag and tag.get('system'):
        if req.name is not None and req.name.strip() != tag['name']:
            raise HTTPException(status_code=400, detail='Cannot rename system tag')

    fields = {}
    if req.name is not None:
        fields['name'] = req.name.strip()
    if req.color is not None:
        fields['color'] = req.color
    if not fields:
        raise HTTPException(status_code=400, detail='No fields to update')
    await update_tag(app.state.db, tag_id, **fields)
    return {'status': 'updated'}


@app.delete('/api/tags/{tag_id}')
async def delete_tag_endpoint(tag_id: int):
    tags = await list_tags(app.state.db)
    tag = next((t for t in tags if t['id'] == tag_id), None)
    if tag and tag.get('system'):
        raise HTTPException(status_code=400, detail='Cannot delete system tag')
    await delete_tag(app.state.db, tag_id)
    return {'status': 'deleted'}


@app.post('/api/downloads/{job_id}/tags/{tag_id}')
async def assign_tag(job_id: str, tag_id: int):
    row = await get_download(app.state.db, job_id)
    if not row:
        raise HTTPException(status_code=404, detail='Download not found')
    await add_tag_to_download(app.state.db, job_id, tag_id)
    return {'status': 'added'}


@app.delete('/api/downloads/{job_id}/tags/{tag_id}')
async def unassign_tag(job_id: str, tag_id: int):
    await remove_tag_from_download(app.state.db, job_id, tag_id)
    return {'status': 'removed'}


# --- Bulk operations ---

@app.post('/api/downloads/bulk/pin')
async def bulk_pin_endpoint(req: BulkPin):
    await bulk_pin(app.state.db, req.ids, req.pinned)
    return {'status': 'updated', 'count': len(req.ids)}


@app.post('/api/downloads/bulk/tags')
async def bulk_tag_endpoint(req: BulkTag):
    await bulk_add_tag(app.state.db, req.ids, req.tag_id)
    return {'status': 'updated', 'count': len(req.ids)}


@app.post('/api/downloads/bulk/delete')
async def bulk_delete_endpoint(req: BulkIds):
    deleted = await bulk_delete(app.state.db, req.ids)
    for d in deleted:
        if d.get('file_path') and os.path.exists(d['file_path']):
            try:
                os.remove(d['file_path'])
            except OSError:
                pass
        _remove_thumbnail(d)
    return {'status': 'deleted', 'count': len(deleted)}


# --- Playlists ---

@app.get('/api/playlists')
async def get_playlists():
    return await list_playlists(app.state.db)


@app.post('/api/playlists')
async def create_playlist_endpoint(req: PlaylistCreate):
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail='Playlist name cannot be empty')
    if req.type not in ('manual', 'smart'):
        raise HTTPException(status_code=400, detail='Type must be manual or smart')
    pl = await create_playlist(
        app.state.db, name, pl_type=req.type,
        smart_tag_ids=req.smart_tag_ids,
        smart_sort=req.smart_sort, smart_order=req.smart_order,
    )
    return pl


@app.get('/api/playlists/{playlist_id}')
async def get_playlist_endpoint(playlist_id: int):
    pl = await get_playlist(app.state.db, playlist_id)
    if not pl:
        raise HTTPException(status_code=404, detail='Playlist not found')
    items = await get_playlist_items(app.state.db, playlist_id)
    pl['items'] = items
    return pl


@app.patch('/api/playlists/{playlist_id}')
async def update_playlist_endpoint(playlist_id: int, req: PlaylistUpdate):
    pl = await get_playlist(app.state.db, playlist_id)
    if not pl:
        raise HTTPException(status_code=404, detail='Playlist not found')
    fields = {}
    if req.name is not None:
        fields['name'] = req.name.strip()
    if req.smart_tag_ids is not None:
        fields['smart_tag_ids'] = req.smart_tag_ids
    if req.smart_sort is not None:
        fields['smart_sort'] = req.smart_sort
    if req.smart_order is not None:
        fields['smart_order'] = req.smart_order
    if not fields:
        raise HTTPException(status_code=400, detail='No fields to update')
    await update_playlist(app.state.db, playlist_id, **fields)
    return {'status': 'updated'}


@app.delete('/api/playlists/{playlist_id}')
async def delete_playlist_endpoint(playlist_id: int):
    pl = await get_playlist(app.state.db, playlist_id)
    if not pl:
        raise HTTPException(status_code=404, detail='Playlist not found')
    await delete_playlist(app.state.db, playlist_id)
    return {'status': 'deleted'}


@app.post('/api/playlists/{playlist_id}/items')
async def add_playlist_item_endpoint(playlist_id: int, req: PlaylistAddItem):
    pl = await get_playlist(app.state.db, playlist_id)
    if not pl:
        raise HTTPException(status_code=404, detail='Playlist not found')
    if pl['type'] != 'manual':
        raise HTTPException(status_code=400, detail='Cannot add items to smart playlist')
    dl = await get_download(app.state.db, req.download_id)
    if not dl:
        raise HTTPException(status_code=404, detail='Download not found')
    await add_playlist_item(app.state.db, playlist_id, req.download_id)
    return {'status': 'added'}


@app.delete('/api/playlists/{playlist_id}/items/{download_id}')
async def remove_playlist_item_endpoint(playlist_id: int, download_id: str):
    pl = await get_playlist(app.state.db, playlist_id)
    if not pl:
        raise HTTPException(status_code=404, detail='Playlist not found')
    await remove_playlist_item(app.state.db, playlist_id, download_id)
    return {'status': 'removed'}


@app.put('/api/playlists/{playlist_id}/reorder')
async def reorder_playlist_endpoint(playlist_id: int, req: PlaylistReorder):
    pl = await get_playlist(app.state.db, playlist_id)
    if not pl:
        raise HTTPException(status_code=404, detail='Playlist not found')
    if pl['type'] != 'manual':
        raise HTTPException(status_code=400, detail='Cannot reorder smart playlist')
    await reorder_playlist_items(app.state.db, playlist_id, req.ids)
    return {'status': 'reordered'}


@app.post('/api/playlists/{playlist_id}/pin-all')
async def pin_all_playlist_files(playlist_id: int):
    pl = await get_playlist(app.state.db, playlist_id)
    if not pl:
        raise HTTPException(status_code=404, detail='Playlist not found')
    items = await get_playlist_items(app.state.db, playlist_id)
    ids = [item['id'] for item in items if not item.get('pinned')]
    if ids:
        await bulk_pin(app.state.db, ids, True)
    return {'status': 'pinned', 'count': len(ids)}


@app.get('/api/playlists/{playlist_id}/m3u')
async def export_playlist_m3u(playlist_id: int, request: Request):
    pl = await get_playlist(app.state.db, playlist_id)
    if not pl:
        raise HTTPException(status_code=404, detail='Playlist not found')
    items = await get_playlist_items(app.state.db, playlist_id)
    lines = ['#EXTM3U', f'#PLAYLIST:{pl["name"]}']
    base = str(request.base_url).rstrip('/')
    for item in items:
        if item.get('file_name'):
            dur = item.get('duration') or -1
            title = item.get('title') or item['file_name']
            lines.append(f'#EXTINF:{dur},{title}')
            lines.append(f'{base}/files/{item["file_name"]}')
    content = '\n'.join(lines) + '\n'
    return Response(
        content,
        media_type='audio/x-mpegurl',
        headers={'Content-Disposition': f'attachment; filename="{pl["name"]}.m3u"'},
    )


# --- WebSocket endpoints ---

@app.websocket('/ws/{job_id}')
async def ws_job(ws: WebSocket, job_id: str):
    manager = app.state.ws_manager
    await manager.connect(job_id, ws)

    # If job is already done/error, send current state immediately
    row = await get_download(app.state.db, job_id)
    if row and row['status'] in ('done', 'error'):
        await ws.send_json({
            'job_id': job_id,
            'type': 'complete',
            'status': row['status'],
            'file_name': row.get('file_name'),
            'file_size': row.get('file_size'),
            'error_msg': row.get('error_msg'),
        })

    try:
        while True:
            await ws.receive_text()  # keep alive, client sends pings
    except WebSocketDisconnect:
        manager.disconnect(job_id, ws)


@app.websocket('/ws')
async def ws_global(ws: WebSocket):
    """Global WebSocket — receives progress for ALL jobs."""
    manager = app.state.ws_manager
    await manager.connect_global(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        manager.disconnect_global(ws)
