# Dockerfile for node.js backend
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Ensure runtime-writable tmp upload dir for Lambda-like environments
RUN mkdir -p /tmp/uploads \
    && chmod 1777 /tmp/uploads

# (keep running as non-root user if desired)
USER node

VOLUME ["/app/uploads"]

CMD ["node", "index.js"]
