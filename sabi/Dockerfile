# Sabi — single container: Node 22 serves the API and the static web app; data lives in /data.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci && npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production SABI_DATA=/data PORT=8080
COPY --from=build /app/package.json /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/build ./apps/web/build
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/src/cli.ts", "serve"]
