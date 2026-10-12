# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

# Runtime stage
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
# No docker.sock access — this container never touches Docker directly.
# It communicates with sandbox-supervisor over the internal Docker network.
USER node
EXPOSE 3002
CMD ["node", "dist/index.js"]
