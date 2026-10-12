# Stage 1: Build web frontend
FROM node:20-alpine AS web-builder
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: Build cli backend
FROM node:20-alpine AS cli-builder
WORKDIR /cli
COPY cli/package*.json cli/tsconfig*.json ./
RUN apk add --no-cache python3 make g++ \
  && npm ci
COPY cli/src/ ./src/
RUN npm run build

# Stage 3: Runtime image
FROM node:20-alpine

WORKDIR /app

COPY cli/package*.json ./
# better-sqlite3 is a native module. Prebuilt binaries exist for linux-arm64
# (Raspberry Pi 4/5 on a 64-bit OS) and should be picked up automatically,
# but python3/make/g++ are kept here as a fallback so a missing prebuild
# falls back to compiling from source instead of failing the image build.
RUN apk add --no-cache python3 make g++ \
  && npm ci --omit=dev \
  && apk del python3 make g++

COPY --from=cli-builder /cli/dist/ ./dist/
COPY --from=web-builder /web/dist/ /web/dist/
COPY --from=web-builder /web/dist/ /app/web/dist/

# node user is uid 1000 in node:alpine — no special group needed here,
# unlike sandbox-supervisor (no docker.sock access from this container).
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/server.js"]
