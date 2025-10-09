# Dockerfile for node.js backend
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN mkdir -p /app/uploads \
 && chown -R node:node /app/uploads          


CMD ["node", "index.js"]
