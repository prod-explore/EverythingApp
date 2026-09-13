FROM node:20-alpine

WORKDIR /app

# Build context is the repo root (see docker-compose.yml) so this can reach
# both cli/ and the sibling web/dist/ — Docker can't COPY from outside its
# build context, and web/dist lives one level up from cli/.

COPY cli/package*.json ./
# better-sqlite3 is a native module. Prebuilt binaries exist for linux-arm64
# (Raspberry Pi 4/5 on a 64-bit OS) and should be picked up automatically,
# but python3/make/g++ are kept here as a fallback so a missing prebuild
# falls back to compiling from source instead of failing the image build.
RUN apk add --no-cache python3 make g++ \
  && npm ci --omit=dev \
  && apk del python3 make g++

COPY cli/dist/ ./dist/
COPY web/dist/ ./web/dist/

# node user is uid 1000 in node:alpine — no special group needed here,
# unlike sandbox-supervisor (no docker.sock access from this container).
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/server.js"]
