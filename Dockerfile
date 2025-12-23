# Build stage
FROM oven/bun:1 as builder

WORKDIR /app

# Copy package files
COPY package.json ./
COPY bun.lock ./
COPY frontend/package.json ./frontend/
COPY frontend/package-lock.json ./frontend/
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

# Copy backend source and dependencies
COPY --from=builder /app/backend ./backend
COPY --from=builder /app/bun.lock ./

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://localhost:3000/health'); process.exit(r.ok ? 0 : 1)"

# Start backend server
CMD ["bun", "run", "backend/src/server.ts"]
