FROM node:20-alpine

# Avoid root-owned files in volumes (lesson learned from obsidian-mcp incident).
# The supervisor needs to call docker, but we grant that via group, not by running as root.
RUN addgroup -S docker 2>/dev/null || true
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/

# node user is uid 1000 in node:alpine
USER node

EXPOSE 3001
CMD ["node", "dist/index.js"]
