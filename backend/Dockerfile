FROM node:24-slim

WORKDIR /app

# Copy package files
COPY package.json ./
COPY package-lock.json ./

# Install all dependencies (including devDependencies)
RUN npm ci

# Ensure esbuild binary is properly built for this platform
RUN npm rebuild esbuild || npm install esbuild@latest

# Copy backend source code
COPY . .

# Build the backend with ESM format to support import.meta
RUN npm run build

# Verify build output exists
RUN test -f dist/server.js || (echo "ERROR: build file not created" && ls -la && exit 1)

# Prune devDependencies
RUN npm prune --production

# Create data directory for plugin storage and other runtime data
RUN mkdir -p /app/data /app/plugins

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data
ENV PLUGINS_DIR=/app/plugins

# Expose backend port
EXPOSE 8080

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start the backend server
CMD ["node", "dist/server.js"]
