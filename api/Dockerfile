# syntax=docker/dockerfile:1.7
FROM python:3.12-slim AS base
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

# System deps you’ll likely need on Pi for building some wheels
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# If you use uv (fast Python package manager), great; fallback is pip
# COPY uv.lock pyproject.toml ./
# RUN pip install uv && uv sync --frozen --no-dev

COPY pyproject.toml ./
RUN pip install --no-cache-dir -U pip \
    && pip wheel --no-deps --wheel-dir /wheels \
    "fastapi[standard]" "uvicorn[standard]" "httpx>=0.27" \
    "pydantic>=2.7" "SQLAlchemy>=2.0" "alembic>=1.13" \
    "apscheduler>=3.10" "python-multipart>=0.0.9"

COPY . .
RUN pip install --no-cache-dir /wheels/*

EXPOSE 8000