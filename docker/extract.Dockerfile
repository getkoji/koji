FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    fastapi>=0.115 \
    uvicorn>=0.30 \
    pydantic>=2.0 \
    httpx>=0.27 \
    botocore>=1.35.0

COPY services/extract/ /app/services/extract/

EXPOSE 9420

CMD ["uvicorn", "services.extract.main:app", "--host", "0.0.0.0", "--port", "9420", "--timeout-keep-alive", "300"]
