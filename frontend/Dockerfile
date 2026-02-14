FROM node:24-slim AS builder

WORKDIR /app

# Copy package files
COPY package.json ./
COPY package-lock.json ./

# Install dependencies with npm
RUN npm ci

# Copy source code
COPY . .

# Vite build-time environment variables (passed as build args from docker-compose)
ARG VITE_TURN_SERVER
ARG VITE_TURN_PORT=3478
ARG VITE_TURN_USERNAME
ARG VITE_TURN_PASSWORD
ARG VITE_USE_TURNS=false
ARG VITE_ENABLE_GOOGLE_STUN=true
ARG VITE_SOCKET_URL
ARG VITE_GIPHY_API_KEY
ENV VITE_TURN_SERVER=$VITE_TURN_SERVER
ENV VITE_TURN_PORT=$VITE_TURN_PORT
ENV VITE_TURN_USERNAME=$VITE_TURN_USERNAME
ENV VITE_TURN_PASSWORD=$VITE_TURN_PASSWORD
ENV VITE_USE_TURNS=$VITE_USE_TURNS
ENV VITE_ENABLE_GOOGLE_STUN=$VITE_ENABLE_GOOGLE_STUN
ENV VITE_SOCKET_URL=$VITE_SOCKET_URL
ENV VITE_GIPHY_API_KEY=$VITE_GIPHY_API_KEY

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
