# The image's bundled Chromium must be the one the locked `playwright` package expects: keep this tag equal to the
# playwright version in package-lock.json (src/__tests__/dockerfile.test.ts checks it). Global ARG: before the first FROM.
ARG PLAYWRIGHT_IMAGE_TAG=v1.63.0-noble

FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_IMAGE_TAG}

# Install Node.js 22
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Playwright browsers are bundled in the base image.
# Only Chromium is needed; others are excluded to save ~500MB.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# No docker.sock — this container only has outbound HTTP access.
# Controlled via Docker network rules; does NOT touch the bash sandbox.
USER pwuser

EXPOSE 3003
CMD ["node", "dist/index.js"]
