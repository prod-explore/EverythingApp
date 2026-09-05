FROM node:20-alpine

# Avoid root-owned files in volumes (lesson learned from obsidian-mcp incident).
# The supervisor needs to call docker, but we grant that via group, not by running as root.
#
# This only actually works if the container's "docker" group has the SAME gid
# as the group that owns the host's /var/run/docker.sock — otherwise `node`
# gets EACCES connecting to it (a very common cause of "sudo docker" confusion
# on the Pi: root can reach the socket, an unprivileged container user can't).
# Find the host's gid with: stat -c '%g' /var/run/docker.sock
# and build with:            docker compose build --build-arg DOCKER_GID=<that number>
ARG DOCKER_GID=999
RUN (addgroup -g ${DOCKER_GID} -S docker 2>/dev/null || addgroup -S docker 2>/dev/null || true) \
  && adduser node docker
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/

# node user is uid 1000 in node:alpine
USER node

EXPOSE 3001
CMD ["node", "dist/index.js"]
