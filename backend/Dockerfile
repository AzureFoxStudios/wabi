# Stage 1: Build frontend
FROM node:24-slim AS frontend-builder
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci
COPY frontend/ .
RUN npm run build

# Stage 2: Build backend
FROM node:24-slim AS backend-builder
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci
COPY backend/ .
RUN cd backend && npm run build

# Stage 3: Final image
FROM node:24-slim
WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S wabi && adduser -S wabi -u 1001

# Copy built backend and dependencies from backend-builder
COPY --from=backend-builder /app/backend/build ./backend/build
COPY --from=backend-builder /app/backend/node_modules ./backend/node_modules
COPY --from=backend-builder /app/backend/package.json ./backend/package.json

# Copy built frontend from frontend-builder
COPY --from=frontend-builder /app/frontend/build ./frontend/build

# Set proper permissions
RUN chown -R wabi:wabi /app

# Switch to non-root user
USER wabi

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080
ENV STATIC_DIR=/app/frontend/build

# Expose backend port
EXPOSE 8080

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start the backend server
CMD ["node", "backend/build"]