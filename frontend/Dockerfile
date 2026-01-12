FROM node:24-slim AS builder

WORKDIR /app

# Copy package files
COPY package.json ./
COPY package-lock.json ./

# Install dependencies with npm
RUN npm ci

# Copy source code
COPY . .

# Build the frontend with adapter-static
RUN npm run build

# Production stage - serve static files
FROM nginx:alpine

# Copy built static site
COPY --from=builder /app/build /usr/share/nginx/html

# Expose nginx default port
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:80/ || exit 1
