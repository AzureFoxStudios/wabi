FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json ./
COPY package-lock.json ./

# Install dependencies with npm (not bun)
RUN npm ci

# Copy source code
COPY . .

# Build the frontend with adapter-node
RUN npm run build

# Production stage - run the Node.js app
FROM node:20-alpine

WORKDIR /app

# Copy built app from builder
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Set environment
ENV NODE_ENV=production

# Expose port 3000
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Start the app
CMD ["npm", "start"]
