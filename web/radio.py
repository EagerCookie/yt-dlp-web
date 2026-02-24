"""Radio engine — streams a playlist as continuous MP3 via FFmpeg."""

import asyncio
import logging
import os
import random

DOWNLOAD_DIR = os.environ.get('DOWNLOAD_DIR', '/downloads')
CHUNK_SIZE = 4096
BUFFER_MAX = 64

log = logging.getLogger(__name__)


class RadioEngine:
    def __init__(self):
        self.playlist_id: int | None = None
        self.playlist_name: str = ''
        self.items: list[dict] = []
        self.current_index: int = -1
        self.shuffle: bool = False
        self._order: list[int] = []
        self._order_pos: int = 0
        self._running: bool = False
        self._task: asyncio.Task | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._skip_event: asyncio.Event = asyncio.Event()
        self._subscribers: list[asyncio.Queue] = []
        self._lock: asyncio.Lock = asyncio.Lock()
        self._on_track_change = None  # callback: async def(now_playing: dict)

    # --- Public API ---

    async def start(self, playlist_id: int, playlist_name: str,
                    items: list[dict], shuffle: bool = False,
                    on_track_change=None):
        async with self._lock:
            await self._stop_internal()
            self.playlist_id = playlist_id
            self.playlist_name = playlist_name
            self.items = [i for i in items if i.get('file_name')]
            self.shuffle = shuffle
            self._on_track_change = on_track_change
            if not self.items:
                return
            self._build_order()
            self._running = True
            self._task = asyncio.create_task(self._stream_loop())

    async def stop(self):
        async with self._lock:
            await self._stop_internal()

    async def skip(self):
        self._skip_event.set()

    @property
    def active(self) -> bool:
        return self._running

    @property
    def listeners(self) -> int:
        return len(self._subscribers)

    def now_playing(self) -> dict:
        if not self._running or self.current_index < 0:
            return {}
        item = self.items[self.current_index]
        return {
            'title': item.get('title') or 'Untitled',
            'duration': item.get('duration'),
            'index': self.current_index,
            'total': len(self.items),
            'playlist_id': self.playlist_id,
            'playlist_name': self.playlist_name,
        }

    def status(self) -> dict:
        return {
            'active': self._running,
            'playlist_id': self.playlist_id,
            'playlist_name': self.playlist_name,
            'now_playing': self.now_playing() if self._running else None,
            'listeners': self.listeners,
            'shuffle': self.shuffle,
        }

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=BUFFER_MAX)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        if q in self._subscribers:
            self._subscribers.remove(q)

    # --- Internal ---

    def _build_order(self):
        self._order = list(range(len(self.items)))
        if self.shuffle:
            random.shuffle(self._order)
        self._order_pos = 0

    async def _stop_internal(self):
        self._running = False
        self._skip_event.set()
        if self._process and self._process.returncode is None:
            try:
                self._process.kill()
                await self._process.wait()
            except Exception:
                pass
            self._process = None
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        # Send empty sentinel to all subscribers so they disconnect
        for q in self._subscribers:
            try:
                q.put_nowait(b'')
            except asyncio.QueueFull:
                pass
        self._subscribers.clear()
        self.playlist_id = None
        self.current_index = -1

    async def _stream_loop(self):
        try:
            while self._running:
                if self._order_pos >= len(self._order):
                    # Loop playlist
                    self._build_order()
                idx = self._order[self._order_pos]
                self._order_pos += 1
                self.current_index = idx
                item = self.items[idx]

                if self._on_track_change:
                    try:
                        await self._on_track_change(self.now_playing())
                    except Exception:
                        pass

                await self._feed_track(item)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            log.error('Radio stream loop error: %s', e)
        finally:
            self._running = False

    async def _feed_track(self, item: dict):
        file_path = os.path.join(DOWNLOAD_DIR, item['file_name'])
        if not os.path.isfile(file_path):
            log.warning('Radio: file not found %s', file_path)
            return

        self._skip_event.clear()
        try:
            self._process = await asyncio.create_subprocess_exec(
                'ffmpeg', '-hide_banner', '-loglevel', 'error',
                '-i', file_path,
                '-f', 'mp3', '-ab', '128k', '-ac', '2', '-ar', '44100',
                '-vn', 'pipe:1',
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except Exception as e:
            log.error('Radio: failed to start ffmpeg: %s', e)
            return

        try:
            while self._running and not self._skip_event.is_set():
                try:
                    chunk = await asyncio.wait_for(
                        self._process.stdout.read(CHUNK_SIZE), timeout=5.0)
                except asyncio.TimeoutError:
                    continue
                if not chunk:
                    break  # Track finished
                self._broadcast_chunk(chunk)
        finally:
            if self._process and self._process.returncode is None:
                try:
                    self._process.kill()
                    await self._process.wait()
                except Exception:
                    pass
            self._process = None

    def _broadcast_chunk(self, chunk: bytes):
        dead = []
        for q in self._subscribers:
            try:
                q.put_nowait(chunk)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self._subscribers.remove(q)

    async def iter_chunks(self, q: asyncio.Queue):
        """Async generator for StreamingResponse. Yields MP3 chunks."""
        try:
            while True:
                chunk = await q.get()
                if not chunk:
                    break  # Sentinel — radio stopped
                yield chunk
        finally:
            self.unsubscribe(q)
