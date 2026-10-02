FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY tracker/ tracker/
COPY config.toml .

ENV PYTHONUNBUFFERED=1 \
    KWT_DB=/data/keywords.db \
    KWT_CONFIG=/app/config.toml

EXPOSE 8090
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:8090/healthz', timeout=4)" || exit 1

# Web UI, API, and the weekly scheduler all run in this one process.
CMD ["python", "-m", "tracker", "serve"]
