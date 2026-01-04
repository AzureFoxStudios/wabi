FROM node:24-slim

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S wabi && adduser -S wabi -u 1001

# Copy package files
COPY package.json ./
COPY package-lock.json ./

# Install dependencies with npm (not bun)
RUN npm ci --production

# Copy backend source code
COPY . .

# Build the backend
RUN npm run build

# Set proper permissions
RUN chown -R wabi:wabi /app

# Switch to non-root user
USER wabi

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Expose backend port
EXPOSE 8080

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start the backend server
CMD ["node", "build"]
