FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY src ./src
COPY workspace ./workspace

RUN mkdir -p /data/workspace

EXPOSE 8080

CMD ["node", "src/server.js"]
