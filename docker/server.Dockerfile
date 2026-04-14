FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    fastapi>=0.115 \
    uvicorn>=0.30 \
    pydantic>=2.0 \
    pyyaml>=6.0 \
    httpx>=0.27 \
    python-multipart>=0.0.9

COPY server/ /app/server/
COPY services/ /app/services/

EXPOSE 9401

CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "9401"]
