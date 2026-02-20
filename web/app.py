import asyncio
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from web.models import (
    DB_PATH,
    delete_download,
    get_db,
    get_download,
    get_downloads_older_than,
    init_db,
    insert_download,
    list_downloads,
    update_download,
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


# --- API endpoints ---

@app.get('/')
async def index():
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

    await insert_download(db, job_id, req.url, req.format_preset)

    loop = asyncio.get_event_loop()
    progress_queue: asyncio.Queue = asyncio.Queue()

    # Start worker thread
    loop.run_in_executor(
        executor,
        run_download, job_id, req.url, req.format_preset, loop, progress_queue,
    )

    # Start async consumer
    task = asyncio.create_task(consume_progress(job_id, progress_queue, db, ws_manager))
    app.state.active_tasks[job_id] = task

    return {'job_id': job_id, 'status': 'queued'}


@app.get('/api/downloads')
async def get_downloads(limit: int = Query(50, ge=1, le=200),
                        offset: int = Query(0, ge=0)):
    rows = await list_downloads(app.state.db, limit, offset)
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

    return FileResponse(
        abs_path,
        filename=filename,
        media_type='application/octet-stream',
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
