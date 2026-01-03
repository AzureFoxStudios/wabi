# Production backend image
FROM oven/bun:1

WORKDIR /app

# Create non-root user for security
RUN useradd -m -u 1001 -s /sbin/nologin wabi

# Copy package files (explicitly use bun.lock)
COPY backend/package.json ./
COPY backend/bun.lock ./

# Install dependencies using frozen lockfile (production only)
RUN bun install --frozen-lockfile --production

# Copy backend source code
COPY backend ./

# Build the backend
RUN bun run build

# Set proper permissions for wabi user
RUN chown -R wabi:wabi /app

# Switch to non-root user
USER wabi

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose backend port
EXPOSE 3000

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl --fail http://localhost:3000/health || exit 1

# Start the backend server
CMD ["./community-chat-server"]
