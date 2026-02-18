FROM node:24-slim

WORKDIR /app

# Download tools for OpenMoji fetch during image build
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json ./
COPY package-lock.json ./
COPY scripts/fetch-openmoji.sh ./scripts/fetch-openmoji.sh

# Install all dependencies (including devDependencies)
RUN npm ci

# Ensure esbuild binary is properly built for this platform
RUN npm rebuild esbuild || npm install esbuild@latest

# Copy backend source code
COPY . .

# Fetch pinned OpenMoji assets so backend can build emoji index without
# depending on frontend container filesystem.
ARG OPENMOJI_VERSION=15.1.0
ARG OPENMOJI_72_SHA256=
ENV OPENMOJI_VERSION=$OPENMOJI_VERSION
ENV OPENMOJI_72_SHA256=$OPENMOJI_72_SHA256
# Strip Windows CRLF line-endings that Git may introduce on Windows hosts,
# then make executable and run.  This is a no-op on files already in LF.
RUN sed -i 's/\r$//' ./scripts/fetch-openmoji.sh \
  && chmod +x ./scripts/fetch-openmoji.sh \
  && ./scripts/fetch-openmoji.sh /app/openmoji/png

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
ENV OPENMOJI_DIR=/app/openmoji/png

# Expose backend port
EXPOSE 8080

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http=require('http');const req=http.get('http://localhost:8080/health',res=>{process.exit(res.statusCode>=200&&res.statusCode<400?0:1)});req.on('error',()=>process.exit(1));"

# Start the backend server
CMD ["node", "dist/server.js"]
