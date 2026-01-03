# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files
# Copy root manifests first to maximize cache hits
COPY package.json bun.lockb* bun.lock* ./


# Copy per-app manifests (lock first, then package.json)
COPY frontend/bun.lockb* frontend/bun.lock* frontend/package.json ./frontend/
COPY backend/bun.lockb* backend/bun.lock* backend/package.json ./backend/

# Install deps
WORKDIR /app/frontend
RUN bun install --frozen-lockfile
WORKDIR /app/backend
RUN bun install --frozen-lockfile

# Copy sources and build
WORKDIR /app
COPY frontend ./frontend
COPY backend ./backend
RUN bun run --cwd ./frontend build

# Production stage
FROM oven/bun:1 AS runtime

WORKDIR /app

# Bring in build artifacts
COPY --from=builder /app/frontend/build ./frontend/build
COPY --from=builder /app/backend ./backend

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Start backend server
CMD ["bun", "run", "backend/src/server.ts"]
