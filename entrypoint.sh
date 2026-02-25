#!/bin/sh
set -e

# Auto-update yt-dlp on container start (if enabled)
if [ "${UPDATE_YTDLP_ON_START:-true}" = "true" ]; then
    echo "[entrypoint] Checking for yt-dlp updates..."
    pip install --quiet --upgrade yt-dlp && echo "[entrypoint] yt-dlp updated to $(yt-dlp --version)" \
        || echo "[entrypoint] WARNING: Failed to update yt-dlp, using existing version"
fi

echo "[entrypoint] yt-dlp version: $(python -c 'import yt_dlp; print(yt_dlp.version.__version__)')"

# Create named pipe for SnapCast if not exists
if [ ! -p /tmp/snapfifo ]; then
    mkfifo /tmp/snapfifo
    echo "[entrypoint] Created /tmp/snapfifo"
fi

# Start snapserver in background
echo "[entrypoint] Starting snapserver..."
snapserver -c /etc/snapserver.conf --daemon 2>/dev/null \
    && echo "[entrypoint] snapserver started" \
    || echo "[entrypoint] WARNING: Failed to start snapserver"

echo "[entrypoint] Starting web server..."
exec uvicorn web.app:app --host 0.0.0.0 --port 8000
