FROM node:24-slim AS builder

WORKDIR /app

# Download tools for OpenMoji fetch during image build
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json ./
COPY package-lock.json ./
COPY scripts/fetch-openmoji.sh ./scripts/fetch-openmoji.sh

# Install dependencies with npm
RUN npm install

# Copy source code
COPY . .

# Vite build-time environment variables (passed as build args from docker-compose)
ARG VITE_TURN_SERVER
ARG VITE_TURN_PORT=3478
ARG VITE_USE_TURNS=false
ARG VITE_ENABLE_GOOGLE_STUN=true
ARG VITE_SOCKET_URL
ARG VITE_GIPHY_API_KEY
ARG OPENMOJI_VERSION=15.1.0
ARG OPENMOJI_72_SHA256=
ENV VITE_TURN_SERVER=$VITE_TURN_SERVER
ENV VITE_TURN_PORT=$VITE_TURN_PORT
ENV VITE_USE_TURNS=$VITE_USE_TURNS
ENV VITE_ENABLE_GOOGLE_STUN=$VITE_ENABLE_GOOGLE_STUN
ENV VITE_SOCKET_URL=$VITE_SOCKET_URL
ENV VITE_GIPHY_API_KEY=$VITE_GIPHY_API_KEY
ENV OPENMOJI_VERSION=$OPENMOJI_VERSION
ENV OPENMOJI_72_SHA256=$OPENMOJI_72_SHA256

# Fetch pinned OpenMoji assets into static path used by the frontend runtime.
RUN chmod +x ./scripts/fetch-openmoji.sh \
  && sed -i 's/\r$//' ./scripts/fetch-openmoji.sh \
  && ./scripts/fetch-openmoji.sh ./static/openmoji/png

# Build the frontend with adapter-node
RUN npm run build

# Verify build output exists
RUN test -d build || (echo "ERROR: build directory not created" && ls -la && exit 1)

# Prune devDependencies
RUN npm prune --production

# Production stage - run the Node.js app
FROM node:24-slim

WORKDIR /app

# Copy built app from builder
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Set environment
ENV NODE_ENV=production
ENV PORT=8080

# Expose port 8080
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http=require('http');const req=http.get('http://localhost:8080/',res=>{process.exit(res.statusCode>=200&&res.statusCode<400?0:1)});req.on('error',()=>process.exit(1));"

# Start the app
CMD ["npm", "start"]
