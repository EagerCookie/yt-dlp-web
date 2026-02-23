import asyncio
import logging
import os
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from yt_dlp import YoutubeDL

logger = logging.getLogger('yt-dlp-web')

DOWNLOAD_DIR = os.environ.get('DOWNLOAD_DIR', '/downloads')
MAX_CONCURRENT = int(os.environ.get('MAX_CONCURRENT_DOWNLOADS', '3'))

FORMAT_PRESETS = {
    'best_video': {
        'format': 'bestvideo+bestaudio/best',
        'merge_output_format': 'mp4',
        'postprocessors': [],
    },
    'audio_mp3': {
        'format': 'bestaudio/best',
        'merge_output_format': None,
        'postprocessors': [
            {
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'mp3',
                'preferredquality': '192',
            },
        ],
    },
    'video_720p': {
        'format': 'bestvideo[height<=720]+bestaudio/best[height<=720]',
        'merge_output_format': 'mp4',
        'postprocessors': [],
    },
    'video_1080p': {
        'format': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
        'merge_output_format': 'mp4',
        'postprocessors': [],
    },
}

executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENT)


class JobLogger:
    def __init__(self):
        self.lines: list[str] = []

    def debug(self, msg: str) -> None:
        if not msg.startswith('[debug] '):
            self.lines.append(msg)

    def warning(self, msg: str) -> None:
        self.lines.append(f'WARNING: {msg}')

    def error(self, msg: str) -> None:
        self.lines.append(f'ERROR: {msg}')


def verify_download(filepath: str) -> str | None:
    """Verify that the downloaded file is valid. Returns error message or None."""
    if not filepath or not os.path.exists(filepath):
        return 'Downloaded file not found on disk'
    size = os.path.getsize(filepath)
    if size == 0:
        return 'Downloaded file is empty (0 bytes)'
    # Use ffprobe to verify file integrity (more reliable than size comparison,
    # because postprocessors like FFmpegExtractAudio change the file size)
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'json', filepath],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return f'File integrity check failed: {result.stderr.strip()}'
    except FileNotFoundError:
        pass  # ffprobe not available, skip check
    except subprocess.TimeoutExpired:
        return 'File integrity check timed out'
    return None


def _estimate_preset_sizes(formats: list[dict]) -> dict[str, int | None]:
    """Estimate download size for each format preset from the formats list."""
    if not formats:
        return {k: None for k in FORMAT_PRESETS}

    def _size(f):
        return f.get('filesize') or f.get('filesize_approx')

    # Separate video-only, audio-only, and combined streams
    video_formats = [f for f in formats
                     if f.get('vcodec', 'none') != 'none'
                     and f.get('acodec', 'none') == 'none']
    audio_formats = [f for f in formats
                     if f.get('acodec', 'none') != 'none'
                     and f.get('vcodec', 'none') == 'none']
    combined = [f for f in formats
                if f.get('vcodec', 'none') != 'none'
                and f.get('acodec', 'none') != 'none']

    best_audio_size = None
    if audio_formats:
        # Best audio = last in list (sorted worst→best by yt-dlp)
        best_audio_size = _size(audio_formats[-1])

    def _best_video_size(max_height=None):
        candidates = video_formats
        if max_height:
            candidates = [f for f in candidates
                          if (f.get('height') or 0) <= max_height]
        if not candidates:
            # Fallback to combined formats
            fb = combined
            if max_height:
                fb = [f for f in fb if (f.get('height') or 0) <= max_height]
            return _size(fb[-1]) if fb else None
        vid_size = _size(candidates[-1])
        if vid_size and best_audio_size:
            return vid_size + best_audio_size
        return vid_size

    return {
        'best_video': _best_video_size(),
        'audio_mp3': best_audio_size,  # approximate — MP3 conversion changes size
        'video_720p': _best_video_size(720),
        'video_1080p': _best_video_size(1080),
    }


def extract_info_only(url: str) -> dict:
    """Extract video metadata without downloading."""
    ydl_logger = JobLogger()
    params = {
        'quiet': True,
        'no_warnings': True,
        'logger': ydl_logger,
        'skip_download': True,
    }
    with YoutubeDL(params) as ydl:
        info = ydl.extract_info(url, download=False)
        if info is None:
            raise ValueError('Could not extract info from URL')
        safe = YoutubeDL.sanitize_info(info, remove_private_keys=True)
        preset_sizes = _estimate_preset_sizes(safe.get('formats') or [])
        return {
            'title': safe.get('title'),
            'thumbnail': safe.get('thumbnail'),
            'duration': safe.get('duration'),
            'uploader': safe.get('uploader'),
            'is_playlist': safe.get('_type') in ('playlist', 'multi_video'),
            'preset_sizes': preset_sizes,
        }


class CancelledError(Exception):
    pass


def run_download(job_id: str, url: str, format_preset: str,
                 loop: asyncio.AbstractEventLoop,
                 progress_queue: asyncio.Queue,
                 cancel_event: threading.Event | None = None) -> None:
    """Run a download in a worker thread. Sends progress via queue."""
    preset = FORMAT_PRESETS[format_preset]
    ydl_logger = JobLogger()

    def _check_cancel():
        if cancel_event and cancel_event.is_set():
            raise CancelledError('Download cancelled by user')

    def progress_hook(d: dict) -> None:
        _check_cancel()
        total = d.get('total_bytes') or d.get('total_bytes_estimate')
        payload: dict = {
            'job_id': job_id,
            'type': 'progress',
            'status': d['status'],
            'downloaded_bytes': d.get('downloaded_bytes'),
            'total_bytes': total,
            'speed': d.get('speed'),
            'eta': d.get('eta'),
            'filename': d.get('filename'),
        }
        if total and d.get('downloaded_bytes'):
            payload['percent'] = round(d['downloaded_bytes'] / total * 100, 1)
        loop.call_soon_threadsafe(progress_queue.put_nowait, payload)

    def postprocessor_hook(d: dict) -> None:
        payload = {
            'job_id': job_id,
            'type': 'postprocessor',
            'pp_status': d['status'],
            'postprocessor': d.get('postprocessor', ''),
        }
        loop.call_soon_threadsafe(progress_queue.put_nowait, payload)

    os.makedirs(DOWNLOAD_DIR, exist_ok=True)

    # Lower process priority so FFmpeg doesn't starve other tasks
    try:
        os.nice(10)  # lower priority (higher nice = lower priority)
    except (OSError, AttributeError):
        pass  # Windows or permission error, skip

    params: dict = {
        'quiet': True,
        'no_warnings': False,
        'logger': ydl_logger,
        'progress_hooks': [progress_hook],
        'postprocessor_hooks': [postprocessor_hook],
        'outtmpl': os.path.join(DOWNLOAD_DIR, '%(title)s [%(id)s].%(ext)s'),
        'restrictfilenames': True,
        'format': preset['format'],
        'postprocessors': list(preset.get('postprocessors', [])),
        'overwrites': False,
        'ignoreerrors': False,
        # Limit FFmpeg to 1 thread to avoid CPU overload
        'postprocessor_args': {'ffmpeg': ['-threads', '1']},
    }
    if preset.get('merge_output_format'):
        params['merge_output_format'] = preset['merge_output_format']

    # Send extracting status
    loop.call_soon_threadsafe(progress_queue.put_nowait, {
        'job_id': job_id,
        'type': 'status',
        'status': 'extracting',
    })

    try:
        _check_cancel()
        with YoutubeDL(params) as ydl:
            info = ydl.extract_info(url, download=True)

        if info is None:
            raise RuntimeError('Extraction failed — no info returned')

        # Get final file path
        filepath = None
        requested = info.get('requested_downloads')
        if requested and len(requested) > 0:
            filepath = requested[0].get('filepath')
        if not filepath:
            filepath = info.get('_filename') or info.get('filename')

        # Verify download
        error = verify_download(filepath)
        if error:
            if filepath and os.path.exists(filepath):
                try:
                    os.remove(filepath)
                except OSError:
                    pass
            raise RuntimeError(error)

        file_size = os.path.getsize(filepath) if filepath and os.path.exists(filepath) else None
        safe_info = YoutubeDL.sanitize_info(info, remove_private_keys=True)

        loop.call_soon_threadsafe(progress_queue.put_nowait, {
            'job_id': job_id,
            'type': 'complete',
            'status': 'done',
            'filepath': filepath,
            'file_name': os.path.basename(filepath) if filepath else None,
            'file_size': file_size,
            'title': safe_info.get('title'),
            'thumbnail': safe_info.get('thumbnail'),
            'duration': safe_info.get('duration'),
        })

    except CancelledError:
        logger.info('Download cancelled for job %s', job_id)
        # Clean up partial file
        _cleanup_partial(job_id, DOWNLOAD_DIR)
        loop.call_soon_threadsafe(progress_queue.put_nowait, {
            'job_id': job_id,
            'type': 'complete',
            'status': 'cancelled',
            'error_msg': 'Cancelled by user',
        })
    except Exception as e:
        logger.exception('Download failed for job %s', job_id)
        loop.call_soon_threadsafe(progress_queue.put_nowait, {
            'job_id': job_id,
            'type': 'complete',
            'status': 'error',
            'error_msg': str(e),
        })


def _cleanup_partial(job_id: str, download_dir: str) -> None:
    """Remove partial/temp files left by a cancelled download."""
    try:
        for fname in os.listdir(download_dir):
            if fname.endswith('.part') or fname.endswith('.ytdl'):
                try:
                    os.remove(os.path.join(download_dir, fname))
                except OSError:
                    pass
    except OSError:
        pass
