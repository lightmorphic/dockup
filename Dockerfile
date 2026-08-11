FROM python:3.13-alpine

# docker-cli + compose plugin talk to whichever socket is mounted
# (Docker's or Podman's) - Dockle itself never needs a daemon of its own.
RUN apk add --no-cache docker-cli docker-cli-compose tzdata

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY run.py .

ENV DOCKLE_DATA=/app/data \
    DOCKLE_STACKS=/opt/stacks \
    PYTHONUNBUFFERED=1

EXPOSE 5001

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:5001/health',timeout=4)"

CMD ["gunicorn", "-w", "1", "--threads", "32", "-b", "0.0.0.0:5001", "run:app"]
