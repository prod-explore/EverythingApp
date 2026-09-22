FROM mcr.microsoft.com/playwright:v1.48.0-noble

# Install Node.js 20
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/

# Playwright browsers are bundled in the base image.
# Only Chromium is needed; others are excluded to save ~500MB.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# No docker.sock — this container only has outbound HTTP access.
# Controlled via Docker network rules; does NOT touch the bash sandbox.
USER pwuser

EXPOSE 3003
CMD ["node", "dist/index.js"]
