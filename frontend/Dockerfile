# Build stage - use Bun to build the Svelte app
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files (explicitly use bun.lock)
COPY frontend/package.json ./
COPY frontend/bun.lock ./

# Install dependencies using frozen lockfile
RUN bun install --frozen-lockfile

# Copy source code
COPY frontend ./

# Build the frontend
RUN bun run build

# Production stage - use Nginx to serve static files
FROM nginx:alpine

# Copy built files from builder
COPY --from=builder /app/build /usr/share/nginx/html

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Set proper permissions for nginx user (nginx user already exists in alpine)
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chown -R nginx:nginx /var/cache/nginx && \
    chown -R nginx:nginx /var/log/nginx && \
    touch /var/run/nginx.pid && \
    chown nginx:nginx /var/run/nginx.pid

# Switch to non-root user
USER nginx

# Expose port 80
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost/health || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
