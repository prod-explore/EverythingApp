FROM ubuntu:24.04

# Non-interactive apt
ENV DEBIAN_FRONTEND=noninteractive

# A normal dev toolchain, baked in: at runtime the root filesystem is READ-ONLY and the agent is not root,
# so apt / global npm installs are not possible inside a sandbox. Project-local installs (npm i, python -m venv
# in /workspace) work and persist in the workspace volume; `pip install --user` lands in the tmpfs $HOME.
# procps is required: the supervisor's terminal kill-tree uses pgrep.
# git is required: checkpoints/rollback are git snapshots taken inside the sandbox.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash git curl wget ca-certificates openssh-client \
    nodejs npm python3 python3-pip python3-venv build-essential \
    procps jq ripgrep unzip less findutils \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/lib/python3*/EXTERNALLY-MANAGED

# Git identity for commits made inside the sandbox. System-level, because $HOME is a tmpfs at runtime.
RUN git config --system user.email "sandbox@everythingapp" \
  && git config --system user.name "EverythingApp Sandbox" \
  && git config --system safe.directory '*' \
  && git config --system init.defaultBranch main

# The unprivileged sandbox user: uid/gid 1000 (the supervisor runs containers as 1000:1000).
# ubuntu:24.04 ships an "ubuntu" user with that uid; replace it.
RUN (userdel -r ubuntu 2>/dev/null || true) \
  && groupadd -g 1000 sandbox \
  && useradd -u 1000 -g 1000 -m -d /home/sandbox -s /bin/bash sandbox

# Workspace dir — this is the agent's working directory and the ONLY persistent writable path.
# Mounted from a named Docker volume per project; Docker seeds a NEW volume with this directory's ownership,
# so it must belong to the sandbox user. /workspace/.ea-checkpoints holds the checkpoint git dir and the
# append-only action log (read_log); the supervisor creates it on demand.
RUN mkdir -p /workspace && chown 1000:1000 /workspace
WORKDIR /workspace

ENV HOME=/home/sandbox
USER 1000:1000

# At runtime (see sandbox-supervisor/src/docker.ts buildCreateOptions): read-only rootfs, tmpfs /tmp /run $HOME,
# all capabilities dropped, no-new-privileges, default seccomp, CPU/memory/pids caps, isolated network,
# optional gVisor (SANDBOX_RUNTIME=runsc).
CMD ["bash", "-c", "exec tail -f /dev/null"]
