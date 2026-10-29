# Round 4 research image: model training and cross-validation, run on the VPS only.
# Build from this directory:
#   docker build --target runtime -t crypto-ops:round4-py .
#   docker build --target test -t crypto-ops:round4-py-test .
# Run research with --network none, a memory cap and --user so outputs are not root-owned.

FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704 AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app
# LightGBM's Linux wheel links the system OpenMP runtime.
# Pinned to the version in the digest-pinned base (Debian 13). Bump it together with the base image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1=14.2.0-19 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.lock ./
RUN pip install --require-hashes --only-binary=:all: --no-deps -r requirements.lock
COPY pyproject.toml ./
COPY r4 ./r4

FROM runtime AS test
COPY requirements-test.lock ./
RUN pip install --require-hashes --only-binary=:all: --no-deps -r requirements-test.lock
COPY lock.py ./
COPY tests ./tests
CMD ["sh", "-c", "ruff check . && ruff format --check . && pytest -q"]
