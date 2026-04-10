FROM python:3.12-slim

WORKDIR /app

# System deps for docling (PDF rendering, image handling)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    fastapi>=0.115 \
    uvicorn>=0.30 \
    python-multipart>=0.0.9 \
    docling>=2.0

COPY services/parse/ /app/services/parse/

EXPOSE 9410

CMD ["uvicorn", "services.parse.main:app", "--host", "0.0.0.0", "--port", "9410", "--timeout-keep-alive", "300"]
