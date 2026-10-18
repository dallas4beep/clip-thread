FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
ARG REQUIREMENTS=requirements.txt
COPY requirements*.txt ./
RUN pip install --no-cache-dir -r ${REQUIREMENTS}

COPY app ./app
RUN useradd --system --uid 10001 worker
USER worker

ENV PYTHONUNBUFFERED=1
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz').status==200 else 1)"
# One process: the in-memory queue + startup sweep assume a single worker per container.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
