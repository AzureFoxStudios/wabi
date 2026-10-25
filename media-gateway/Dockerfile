FROM node:22-slim

WORKDIR /app

COPY package.json ./
COPY src ./src

EXPOSE 8095

CMD ["node", "src/server.mjs"]
