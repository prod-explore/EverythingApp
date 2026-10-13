# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

# Runtime stage
FROM node:22-alpine

# No docker.sock, no volumes: proxy tokens live in memory, GitHub credentials are fetched from the
# orchestrator (or GITHUB_PAT) and never leave this container.
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# node user is uid 1000 in node:alpine
USER node

EXPOSE 8080
CMD ["node", "dist/index.js"]
