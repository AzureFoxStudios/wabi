FROM node:20-slim AS build

WORKDIR /app

# Build tools only in builder stage (not shipped in runtime image).
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl unzip ca-certificates build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY scripts/fetch-openmoji.sh ./scripts/fetch-openmoji.sh

# Install all deps required for building (dev deps included).
RUN npm install

COPY src ./src
COPY scripts ./scripts

ARG OPENMOJI_VERSION=15.1.0
ARG OPENMOJI_72_SHA256=
ENV OPENMOJI_VERSION=$OPENMOJI_VERSION
ENV OPENMOJI_72_SHA256=$OPENMOJI_72_SHA256

# Fetch pinned OpenMoji assets used by the backend emoji index.
RUN sed -i 's/\r$//' ./scripts/fetch-openmoji.sh \
  && chmod +x ./scripts/fetch-openmoji.sh \
  && ./scripts/fetch-openmoji.sh /app/openmoji/png

# Build backend output.
RUN npm run build
RUN test -f dist/server.js || (echo "ERROR: build file not created" && ls -la && exit 1)

# Keep only production dependencies.
RUN npm prune --omit=dev

FROM node:20-slim AS runtime-base

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data
ENV PLUGINS_DIR=/app/plugins
ENV OPENMOJI_DIR=/app/openmoji/png

COPY --from=build /app/dist ./dist
COPY --from=build /app/openmoji ./openmoji
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules

RUN mkdir -p /app/data /app/plugins

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http=require('http');const req=http.get('http://localhost:8080/health',res=>{process.exit(res.statusCode>=200&&res.statusCode<400?0:1)});req.on('error',()=>process.exit(1));"

CMD ["node", "dist/server.js"]

# SQLite target (default for normal mode).
FROM runtime-base AS backend-sqlite

# Postgres-only target strips SQLite native dependency.
FROM runtime-base AS backend-postgres
RUN rm -rf /app/node_modules/better-sqlite3
