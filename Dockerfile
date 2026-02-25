FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    snapserver \
    unzip \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install snapweb (browser-based SnapCast client)
RUN curl -fsSL -L https://github.com/snapcast/snapweb/releases/download/v0.9.3/snapweb.zip -o /tmp/snapweb.zip \
    && mkdir -p /usr/share/snapserver/snapweb \
    && unzip /tmp/snapweb.zip -d /usr/share/snapserver/snapweb \
    && rm /tmp/snapweb.zip

WORKDIR /app

# Install web dependencies + yt-dlp from PyPI (not from source)
COPY web/requirements.txt ./requirements-web.txt
RUN pip install --no-cache-dir -r requirements-web.txt yt-dlp

# Copy web application only (yt-dlp source no longer needed)
COPY web/ ./web/

# Copy snapserver config
COPY snapserver.conf /etc/snapserver.conf

# Create data directories and named pipe for SnapCast
RUN mkdir -p /downloads /data

# Entrypoint handles optional auto-update of yt-dlp before starting the server
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

EXPOSE 8000 1704 1705 1780

ENTRYPOINT ["/entrypoint.sh"]
