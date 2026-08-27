FROM ubuntu:24.04

# Non-interactive apt
ENV DEBIAN_FRONTEND=noninteractive

# Only whitelisted tools — no apt/pip/npm install available to the agent.
# The agent can use what's here; it cannot expand the surface.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    git \
    curl \
    ca-certificates \
    nodejs \
    && rm -rf /var/lib/apt/lists/*

# Git identity for commits made inside the sandbox
RUN git config --global user.email "sandbox@everythingapp" \
  && git config --global user.name "EverythingApp Sandbox"

# Workspace dir — this is the agent's working directory.
# The supervisor's releaseContainer() wipes this between sessions.
RUN mkdir -p /workspace
WORKDIR /workspace

# Append-only action log — every command the agent runs is recorded here.
# read_log MCP tool reads this file.
RUN touch /var/log/sandbox-actions.log && chmod 666 /var/log/sandbox-actions.log

# No user switch — containers run as root within their own namespace.
# gVisor (on Pi) adds kernel-level isolation on top of this.
# On a host with rootless Docker (post-migration), this becomes non-root.
CMD ["bash", "-c", "tail -f /dev/null"]
