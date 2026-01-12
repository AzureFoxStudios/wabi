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

# Expose port 8080 (nginx default is 80)
EXPOSE 8080

# Run nginx on 8080 to match docker-compose
RUN sed -i 's/listen\\s\\+80;/listen 8080;/' /etc/nginx/conf.d/default.conf

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/ || exit 1
