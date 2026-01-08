FROM node:24-slim AS builder

WORKDIR /app

# Copy package files
COPY package.json ./
COPY package-lock.json ./

# Install dependencies with npm
RUN npm ci

# Copy source code
COPY . .

# Build the frontend with adapter-node
RUN npm run build

# Production stage - run the Node.js app
FROM node:24-slim

WORKDIR /app

# Create non-root user for security (Debian syntax, not Alpine)
RUN groupadd -g 1001 wabi && useradd -u 1001 -g wabi wabi

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
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/ || exit 1

# Set proper permissions
RUN chown -R wabi:wabi /app

# Switch to non-root user
USER wabi

# Start the app
CMD ["npm", "start"]
