# syntax=docker/dockerfile:1
# Multi-stage build: the image compiles the frontend and the wabi-server
# binary from source, so a fresh clone + `docker compose up -d --build`
# produces a working server with no host toolchain.
#
#   1. frontend-builder  — STATIC_BUILD=1 SvelteKit SPA (adapter-static)
#   2. rust-builder      — release wabi-server (embeds frontend/build via rust_embed)
#   3. runtime           — fedora + openssl/ca-certificates/wget, non-root (UID 1000)
#
# Dev override: to test a host-built binary instead, mount it over
# /wabi-server (read-only) and restart the container.

# ---------------------------------------------------------- frontend ----
FROM node:20-slim AS frontend-builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/scripts/fetch-openmoji.sh ./scripts/fetch-openmoji.sh

RUN npm ci --no-audit --no-fund

# Source + shared types (Vite resolves ../../../shared from src/lib).
COPY frontend/ ./
COPY shared /shared

# Fetch pinned OpenMoji assets used by the frontend runtime.
RUN chmod +x ./scripts/fetch-openmoji.sh \
 && sed -i 's/\r$//' ./scripts/fetch-openmoji.sh \
 && ./scripts/fetch-openmoji.sh ./static/openmoji/png

# STATIC_BUILD=1 is REQUIRED: adapter-node output cannot be embedded by rust_embed.
ENV STATIC_BUILD=1
RUN npm run build && test -f build/index.html

# --------------------------------------------------------------- rust ----
FROM rust:1.93 AS rust-builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY core ./core

# Embedded frontend: rust_embed includes frontend/build at compile time.
COPY --from=frontend-builder /app/build ./frontend/build

# No cache mounts on purpose: they require BuildKit/buildx, which is not
# always available (e.g. legacy docker daemons). Rebuilds are slower but the
# quick start works everywhere.
RUN cargo build --release -p wabi-server \
 && cp target/release/wabi-server /wabi-server

# ----------------------------------------------------------- runtime ----
FROM fedora:44
RUN dnf -y install openssl-libs ca-certificates wget \
 && dnf clean all
WORKDIR /app

# Pre-create runtime directories and grant ownership to the non-root user
# (UID/GID 1000). /data, /app/uploads and /app/plugins are bind-mounted from
# the host by docker-compose; the ownership here is what wabi-server (running
# as UID 1000) needs to read/write inside the container.
RUN groupadd -g 1000 wabi \
 && useradd -u 1000 -g 1000 -M -s /sbin/nologin wabi \
 && mkdir -p /data /app/uploads /app/plugins /home/wabi/.config/lore /var/wabi/lore \
 && chown -R 1000:1000 /data /app /home/wabi /var/wabi 2>/dev/null || true \
 && chmod 750 /data /app/uploads /app/plugins /var/wabi/lore

COPY --from=rust-builder /wabi-server /wabi-server
RUN chmod 755 /wabi-server && chown 1000:1000 /wabi-server

# Drop root privileges. wabi-server runs as UID 1000 going forward.
USER 1000:1000

ENTRYPOINT ["/wabi-server"]
