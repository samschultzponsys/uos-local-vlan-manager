# Built by the GitHub Action (.github/workflows/release.yml) and published to GHCR.
# Deploy with compose.yaml.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VLANMGR_DB=/data/vlanmgr.db \
    PORT=20090 \
    PUID=1000 \
    PGID=1000

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./
# the newest "## x.y" heading is the app's version and the in-app changelog
COPY CHANGELOG.md ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

# /data holds everything that must survive updates: the database and backups/.
VOLUME ["/data"]
EXPOSE 20090

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT','20090'), timeout=4)" || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "/app/main.py"]
