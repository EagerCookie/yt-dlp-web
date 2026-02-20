FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install web dependencies + yt-dlp from PyPI (not from source)
COPY web/requirements.txt ./requirements-web.txt
RUN pip install --no-cache-dir -r requirements-web.txt yt-dlp

# Copy web application only (yt-dlp source no longer needed)
COPY web/ ./web/

# Create data directories
RUN mkdir -p /downloads /data

# Entrypoint handles optional auto-update of yt-dlp before starting the server
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
