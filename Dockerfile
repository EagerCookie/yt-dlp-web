FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install web dependencies
COPY web/requirements.txt ./requirements-web.txt
RUN pip install --no-cache-dir -r requirements-web.txt

# Install yt-dlp from source
COPY pyproject.toml README.md ./
COPY yt_dlp/ ./yt_dlp/
RUN pip install --no-cache-dir -e .

# Copy web application
COPY web/ ./web/

# Create data directories
RUN mkdir -p /downloads /data

EXPOSE 8000

CMD ["uvicorn", "web.app:app", "--host", "0.0.0.0", "--port", "8000"]
