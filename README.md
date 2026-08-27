# EverythingApp

> Personal, fully self-hosted AI system — chat with multiple providers, a code agent running in a sandboxed container, and pipeline orchestration via n8n. Bring your own API keys.

**Status:** Phase 1 (Agent Sandbox) — active development  
**Host target:** Raspberry Pi (ARM64), alongside existing production services  
**Architecture constraint:** The Pi runs Skarpa Bytom (100 real users, GDPR). Every component of this project is isolated by separate Docker networks, volumes, and Postgres instances — see §0 of the Master Brief.

---

## Why this exists

1. **Real tool:** A personal AI assistant with capabilities beyond hosted products — MCP integration (Obsidian vault, sandbox shell, n8n pipelines), conversation branching, batch-mode cost savings, PWA for mobile.
2. **Portfolio:** Code that actually runs in production, with deliberate architectural decisions. If something here looks unusual, it's intentional — check the commit messages.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────┐
│  FRONTEND — Next.js PWA (Phase 4)                   │
│  Multi-provider chat, Approval Gate UI, Batch toggle │
└────────────────────┬────────────────────────────────┘
                     │ HTTPS (Nginx)
┌────────────────────▼────────────────────────────────┐
│  ORCHESTRATOR — Node/Express (Phase 3)              │
│  BYOK key vault · model router · MCP client manager │
│  prompt cache manager · batch-mode manager          │
└──────┬──────────────────────────────────┬───────────┘
       │                                  │
┌──────▼──────────────┐   ┌──────────────▼────────────┐
│  AGENT SANDBOX      │   │  n8n (Phase 2)            │
│  Phase 1 — this     │   │  Daily Routine pipeline    │
│  sandbox-supervisor │   │  Tracking Confession pipe  │
│  + sandbox-mcp      │   │  MCP Server Trigger        │
│  NO docker.sock in  │   └───────────────────────────┘
│  the MCP server     │
└─────────────────────┘
```

---

## Phasing

| Phase | Scope | Status |
|---|---|---|
| **1** | Agent Sandbox: `sandbox-supervisor` + `sandbox-mcp` MCP server | 🔨 In progress |
| **2** | n8n self-hosted + 2 pipelines exposed as MCP tools | — |
| **3** | Orchestrator: BYOK vault + model router + prompt caching | — |
| **4** | Next.js PWA frontend + Approval Gate UI + Batch toggle | — |

---

## Phase 1 — Local dev quickstart

### Prerequisites
- Docker Desktop (or Docker Engine on Linux/macOS)
- Node.js ≥ 20
- `npm`

### Run

```bash
# Build sandbox image first (done once)
docker build -t everything-sandbox:latest ./sandbox-supervisor/sandbox-image/

# Start supervisor + mcp server
docker compose up

# Test the MCP server with the inspector
npx @modelcontextprotocol/inspector http://localhost:3002/mcp/sse
```

### Environment variables

Copy `.env.example` to `.env` and fill in values before running.

| Variable | Default | Description |
|---|---|---|
| `SUPERVISOR_PORT` | `3001` | Port for the local supervisor HTTP API |
| `MCP_PORT` | `3002` | Port for the MCP server |
| `POOL_SIZE` | `2` | Number of pre-warmed sandbox containers |
| `SANDBOX_IMAGE` | `everything-sandbox:latest` | Docker image for sandbox containers |
| `SANDBOX_TIMEOUT_MS` | `30000` | Max execution time per `run_bash` call |
| `AUTO_APPROVE_TOOLS` | *(empty)* | Comma-separated list of tools to auto-approve (leave empty in production) |
| `MCP_API_KEY` | *(required)* | Bearer token for MCP server authentication |

---

## Security model

The sandbox is a Docker container with `bash` + `git` + `curl`. The critical isolation property is:

**`docker.sock` is mounted only into `sandbox-supervisor`, never into `sandbox-mcp`.**

The MCP server talks to the supervisor over local HTTP (`127.0.0.1:3001`). The supervisor owns the container lifecycle. This means a compromised or prompt-injected MCP call can run arbitrary code inside a container — but it cannot escape to the Docker daemon, and therefore cannot reach other containers (including Skarpa Bytom on the Pi).

On the Pi: containers run with `--runtime=runsc` (gVisor). Locally: plain Docker. Zero code change required for that switch.

Every tool call with a side effect (`run_bash`, `git_op`) goes through the **Approval Gate**. In Phase 1 this is a programmatic gate (env var). In Phase 4 it becomes a live UI queue requiring manual Approve/Deny.

---

## Repo structure

```
├── sandbox-supervisor/   # Phase 1: host-side container pool manager
│   ├── sandbox-image/    # Dockerfile for the sandbox containers themselves
│   └── src/
│       ├── docker.ts     # dockerode wrapper
│       ├── pool.ts       # pre-warmed container pool
│       ├── api.ts        # local HTTP API (127.0.0.1 only)
│       └── index.ts      # entrypoint
├── sandbox-mcp/          # Phase 1: MCP server exposing sandbox tools
│   └── src/
│       ├── tools/        # run_bash · git_op · read_log
│       ├── approval.ts   # approval gate middleware
│       ├── supervisor-client.ts
│       └── server.ts
├── docker-compose.yml    # dev: supervisor + mcp server
└── .env.example
```
