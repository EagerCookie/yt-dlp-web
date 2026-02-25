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
        self._snap_process: asyncio.subprocess.Process | None = None
        self._snap_task: asyncio.Task | None = None
        self._skip_event: asyncio.Event = asyncio.Event()
        self._subscribers: list[asyncio.Queue] = []
        self._lock: asyncio.Lock = asyncio.Lock()
        self._on_track_change = None  # callback: async def(now_playing: dict)
        self._snapcast = None  # SnapcastManager instance (injected from app.py)

    def set_snapcast(self, manager):
        """Inject SnapcastManager for synchronized playback."""
        self._snapcast = manager

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

    async def jump_to(self, index: int):
        """Jump to a specific track index."""
        if index < 0 or index >= len(self.items):
            return
        # Insert the target index at the front of the remaining order
        self._order.insert(self._order_pos, index)
        self._skip_event.set()

    async def toggle_shuffle(self, shuffle: bool):
        self.shuffle = shuffle
        if shuffle:
            self._build_order()
        else:
            self._order = list(range(len(self.items)))
            # Continue from current track
            if self.current_index >= 0:
                self._order_pos = self.current_index + 1

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

    def queue(self) -> list[dict]:
        """Return the track list with current index marked."""
        result = []
        for i, item in enumerate(self.items):
            result.append({
                'index': i,
                'title': item.get('title') or 'Untitled',
                'duration': item.get('duration'),
                'file_name': item.get('file_name'),
                'current': i == self.current_index,
            })
        return result

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
        # Kill snapcast FFmpeg FIRST to stop writing to FIFO immediately
        await self._stop_snap_process()
        # Flush FIFO with silence so snapserver doesn't play leftover noise
        if self._snapcast and self._snapcast.enabled:
            self._snapcast.flush_silence()
        # Kill main MP3 FFmpeg
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
                # Wait for at least one listener (HTTP or SnapCast) before starting FFmpeg
                has_snapcast = self._snapcast and self._snapcast.enabled
                while self._running and not self._subscribers and not has_snapcast:
                    await asyncio.sleep(0.5)
                if not self._running:
                    break

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

        # Always re-encode to ensure clean MP3 frames for streaming.
        # MP3 128k encoding is ~1-2% CPU — negligible.
        # -c:a copy is unreliable for streaming (leaks ID3/Xing headers).
        try:
            self._process = await asyncio.create_subprocess_exec(
                'ffmpeg', '-hide_banner', '-loglevel', 'error',
                '-re',
                '-threads', '1',
                '-i', file_path,
                '-vn',
                '-c:a', 'libmp3lame', '-b:a', '128k', '-ac', '2', '-ar', '44100',
                '-write_xing', '0',
                '-id3v2_version', '0',
                '-f', 'mp3',
                'pipe:1',
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except Exception as e:
            log.error('Radio: failed to start ffmpeg: %s', e)
            return

        # Start a second FFmpeg for SnapCast: PCM s16le → snapfifo
        if self._snapcast and self._snapcast.enabled:
            try:
                self._snap_process = await asyncio.create_subprocess_exec(
                    'ffmpeg', '-hide_banner', '-loglevel', 'error',
                    '-re',
                    '-threads', '1',
                    '-i', file_path,
                    '-vn',
                    '-c:a', 'pcm_s16le', '-ac', '2', '-ar', '44100',
                    '-f', 's16le',
                    'pipe:1',
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                self._snap_task = asyncio.create_task(
                    self._pipe_pcm_to_snapcast(self._snap_process))
            except Exception as e:
                log.warning('Radio: failed to start snapcast ffmpeg: %s', e)

        try:
            while self._running and not self._skip_event.is_set():
                # If all listeners disconnected and no snapcast, stop FFmpeg
                if not self._subscribers and not (self._snapcast and self._snapcast.enabled):
                    break
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
            # Clean up snapcast FFmpeg
            await self._stop_snap_process()

    async def _stop_snap_process(self):
        """Kill the snapcast FFmpeg process and task if running."""
        if self._snap_task and not self._snap_task.done():
            self._snap_task.cancel()
            try:
                await self._snap_task
            except (asyncio.CancelledError, Exception):
                pass
        self._snap_task = None
        if self._snap_process and self._snap_process.returncode is None:
            try:
                self._snap_process.kill()
                await self._snap_process.wait()
            except Exception:
                pass
        self._snap_process = None

    async def _pipe_pcm_to_snapcast(self, proc: asyncio.subprocess.Process):
        """Read PCM chunks from FFmpeg and write to snapfifo."""
        try:
            while True:
                chunk = await proc.stdout.read(CHUNK_SIZE)
                if not chunk:
                    break
                self._snapcast.write_chunk(chunk)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            log.warning('Radio: snapcast PCM pipe error: %s', e)

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
