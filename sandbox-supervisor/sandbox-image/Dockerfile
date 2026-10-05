FROM ubuntu:24.04

# Non-interactive apt
ENV DEBIAN_FRONTEND=noninteractive

# A normal dev environment: the agent has internet and may install what it needs (apt, npm, pip).
# procps is required: the supervisor's terminal kill-tree uses pgrep.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash git curl wget ca-certificates openssh-client \
    nodejs npm python3 python3-pip python3-venv build-essential \
    procps jq ripgrep unzip less \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/lib/python3*/EXTERNALLY-MANAGED

# Git identity for commits made inside the sandbox
RUN git config --global user.email "sandbox@everythingapp" \
  && git config --global user.name "EverythingApp Sandbox"

# Workspace dir — this is the agent's working directory.
# Mounted from a named Docker volume per project/chat; never wiped by the supervisor.
RUN mkdir -p /workspace
WORKDIR /workspace

# Append-only action log — every command the agent runs is recorded here.
# read_log MCP tool reads this file.
RUN touch /var/log/sandbox-actions.log && chmod 666 /var/log/sandbox-actions.log

# No user switch — containers run as root within their own namespace.
# gVisor (on Pi) adds kernel-level isolation on top of this.
# On a host with rootless Docker (post-migration), this becomes non-root.
CMD ["bash", "-c", "tail -f /dev/null"]
