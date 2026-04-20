# Koji Parse Service — application image.
#
# This image extends the parse base image (docker/parse.base.Dockerfile),
# which carries the heavyweight dependencies (docling, torch, OCR stack).
# All we do here is copy the Python source and set the entrypoint, so
# rebuilds are fast (seconds, not minutes) whenever only the application
# code changes.
#
# The base image must be published to ghcr.io/getkoji/parse-base:latest
# (see .github/workflows/publish-images.yml — `publish-parse-base`) before
# this image can be built. Local contributors building from source can
# also `docker pull ghcr.io/getkoji/parse-base:latest` — docker compose
# will do this automatically via the `FROM` line below.

FROM ghcr.io/getkoji/parse-base:latest

WORKDIR /app

# Additional deps not in the base image
RUN pip install --no-cache-dir sse-starlette==2.1.3

# Copy only what the parse service needs. Keeping this list minimal means
# touching unrelated files in the repo does not invalidate the cache.
COPY services/parse/ /app/services/parse/

EXPOSE 9410

CMD ["uvicorn", "services.parse.main:app", "--host", "0.0.0.0", "--port", "9410", "--timeout-keep-alive", "300"]
