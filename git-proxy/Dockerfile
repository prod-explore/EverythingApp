FROM node:20-alpine

# No docker.sock, no volumes: proxy tokens live in memory, GitHub credentials are fetched from the
# orchestrator (or GITHUB_PAT) and never leave this container.
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/

# node user is uid 1000 in node:alpine
USER node

EXPOSE 8080
CMD ["node", "dist/index.js"]
