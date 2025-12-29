name: wabi-dockerfile
services:
- name: wabi
  git:
    repo_clone_url: https://github.com/azurefoxstudios/wabi
    branch: main
  dockerfile_path: Dockerfile
# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./
COPY frontend/package.json ./frontend/
COPY backend/package.json ./backend/

# Install dependencies
RUN cd frontend && bun install
RUN cd backend && bun install

# Copy source code
COPY frontend ./frontend
COPY backend ./backend

# Build frontend
RUN cd frontend && bun run build

# Production stage
FROM oven/bun:1

WORKDIR /app

# Copy built frontend
COPY --from=builder /app/frontend/build ./frontend/build

# Copy backend source
COPY --from=builder /app/backend ./backend

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Start backend server
CMD ["bun", "run", "backend/src/server.ts"]
