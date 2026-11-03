FROM node:22.23.4-slim

WORKDIR /app

COPY package.json ./
COPY src ./src

EXPOSE 8095

CMD ["node", "src/server.mjs"]
