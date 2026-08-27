FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
# No docker.sock access — this container never touches Docker directly.
# It communicates with sandbox-supervisor over the internal Docker network.
USER node
EXPOSE 3002
CMD ["node", "dist/index.js"]
