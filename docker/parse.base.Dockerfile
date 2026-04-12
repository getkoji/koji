# Koji Parse Service — base image.
#
# This image contains the heavyweight dependencies for the parse service:
# docling, torch (CPU), transformers, and the system libraries docling
# needs (tesseract for OCR, poppler for PDF rendering, image libraries).
#
# It is expected to be ~5GB on disk and rebuild rarely. The application
# image (docker/parse.Dockerfile) extends this base and only copies the
# Python source — that image is tiny (~50MB on top of the base) and
# rebuilds in seconds.
#
# Publish target:
#   ghcr.io/getkoji/parse-base:<tag>
#   ghcr.io/getkoji/parse-base:latest
#
# Build & push manually (usually via the publish-images workflow):
#   docker buildx build \
#     --platform linux/amd64,linux/arm64 \
#     -f docker/parse.base.Dockerfile \
#     -t ghcr.io/getkoji/parse-base:latest \
#     --push .

FROM python:3.12.7-slim-bookworm

# ---------------------------------------------------------------------------
# System dependencies
# ---------------------------------------------------------------------------
# - libgl1, libglib2.0-0    : OpenCV / docling image stack
# - tesseract-ocr           : OCR backend for scanned PDFs / images
# - tesseract-ocr-eng       : English language data for tesseract
# - poppler-utils           : PDF rendering / page extraction
# - libjpeg62-turbo, libpng16-16, libtiff6 : image format support
# - fonts-dejavu-core       : baseline fonts so rendered PDFs are not blank
# - ca-certificates         : model downloads over HTTPS
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        tesseract-ocr \
        tesseract-ocr-eng \
        poppler-utils \
        libjpeg62-turbo \
        libpng16-16 \
        libtiff6 \
        fonts-dejavu-core \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Python dependencies
# ---------------------------------------------------------------------------
# All versions are pinned so both the base image and the application image
# on top of it are reproducible. Bump these deliberately and rebuild the
# base image when you do.
#
# torch is installed from the CPU-only wheel index to keep the image size
# manageable (a CUDA build is ~2GB larger and unusable on typical dev
# machines).

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN pip install --index-url https://download.pytorch.org/whl/cpu \
        torch==2.4.1

RUN pip install \
        docling==2.14.0 \
        transformers==4.44.2 \
        sentencepiece==0.2.0 \
        tokenizers==0.19.1 \
        huggingface-hub==0.25.2 \
        pillow==10.4.0 \
        pypdfium2==4.30.0

# Web framework pieces are pinned here too so the application image does
# not need to reinstall them on every rebuild.
RUN pip install \
        fastapi==0.115.0 \
        uvicorn==0.30.6 \
        python-multipart==0.0.12

WORKDIR /app
