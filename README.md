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

# Find the group that owns docker.sock on THIS host — it varies by OS/distro
# (this is also the thing to check first during the Pi audit if the
# supervisor logs EACCES / "permission denied" talking to Docker).
stat -c '%g' /var/run/docker.sock
# Put that number in .env as DOCKER_GID, then:

# Start supervisor + mcp server
docker compose up --build

# Test the MCP server with the inspector
npx @modelcontextprotocol/inspector http://localhost:3002/mcp/sse
```

### Environment variables

Copy `.env.example` to `.env` and fill in values before running.

| Variable | Default | Description |
|---|---|---|
| `DOCKER_GID` | `999` | Build-time gid of the host's docker group, so the non-root supervisor container can reach `docker.sock` — get it with `stat -c '%g' /var/run/docker.sock` |
| `SUPERVISOR_PORT` | `3001` | Port for the local supervisor HTTP API |
| `MCP_PORT` | `3002` | Port for the MCP server |
| `POOL_SIZE` | `2` | Number of pre-warmed sandbox containers |
| `SANDBOX_IMAGE` | `everything-sandbox:latest` | Docker image for sandbox containers |
| `SANDBOX_TIMEOUT_MS` | `30000` | Max execution time per `run_bash` call |
| `AUTO_APPROVE_TOOLS` | *(empty)* | Comma-separated list of tools to auto-approve (leave empty in production) |
| `MCP_API_KEY` | *(required)* | Bearer token for MCP server authentication |

---

## CLI — minimal chat client (interim scope, pre-Phase-3/4)

Given a tight timeline, this ships before the full Phase 3 Orchestrator / Phase 4
PWA: a terminal chat client instead of a web UI, one provider (Anthropic) instead
of the full BYOK router, and a plain `.env` key instead of an encrypted vault with
spend caps. Nothing here is a dead end — the tool registry and Approval Gate are
written so a future Orchestrator/PWA can reuse them; this just skips the UI and
multi-provider normalization work to get something usable now. n8n (Phase 2) is
intentionally not wired in yet.

It connects to any number of MCP servers via a **generic, config-driven connector
list** — `MCP_CONNECTORS=sandbox,obsidian` in `.env`, plus a URL/key pair per
name. Adding GitHub's official remote MCP server (OAuth or PAT, full read/write
including private repos) or n8n's MCP Server Trigger (once n8n is deployed —
n8n workflows can also call *out* to other MCP servers like `obsidian` via its
own MCP Client Tool node, so no custom glue code is needed either direction)
is just adding a name and two env vars, not writing code. It gives Claude their
tools, plus Anthropic's own hosted `web_search` tool (toggle with
`WEB_SEARCH_ENABLED`), and gates every side-effecting call behind a `[y/N/a]`
prompt in the terminal — the same Approval Gate principle from §7 of the Master
Brief, just with a terminal prompt standing in for the Phase 4 push-notification
queue. `a` remembers "always allow" for that tool for the rest of the session
(same pattern as Claude Code — not reinvented here) — **except** for a call
that looks potentially destructive (`rm -rf`, `git push --force`,
`git reset --hard`, `DROP TABLE`/`DATABASE`, a fork-bomb shape): those always
re-prompt even on an "always allowed" tool, and approving one never grants
future always-allow, since "always allow git_op" was granted for routine use,
not for a specific unseen `--force` push (§12 pt.5 of the Master Brief — this
is a UI hint, not the security boundary itself; the boundary is that the call
needs a human "y" at all). Read-only tools (currently `read_log`, `get_path`,
`search_notes`, override with `AUTO_APPROVE_TOOLS`) skip the prompt entirely;
**everything else requires approval by default**, including tools this
doesn't know about yet.

Conversation history persists to disk (`~/.everythingapp/history.json` by default,
override with `EVERYTHINGAPP_HISTORY_PATH`) so it survives restarts — `/clear`
wipes it. System prompt and tool definitions are marked for Anthropic prompt
caching (Master Brief §8), since both are identical on every request in a session.

Not done yet, deliberately: this is a single continuous conversation (no
Claude.ai-style sidebar of separate past chats), and it's still a terminal, not
a web UI — see §11-§12 of the Master Brief for the full frontend/PWA spec,
written up but intentionally not built yet.

Web search costs $10/1,000 searches plus normal token cost for the results —
worth knowing since it's on by default.

### Usage/cost tracking (`/usage`)

Every response prints its own cost estimate plus a running session total
(input/output/cache tokens × per-model rates — §12 pt.1 of the Master Brief:
this is BYOK, so unlike Claude.ai's flat subscription, tokens are a direct
out-of-pocket cost). `/usage` shows the running total on demand. Rates default
to Sonnet 5's current pricing but are just a starting point — override with
`PRICE_INPUT_PER_MTOK` / `PRICE_OUTPUT_PER_MTOK` / `PRICE_CACHE_WRITE_PER_MTOK`
/ `PRICE_CACHE_READ_PER_MTOK` if the model or its price changes, rather than
trusting a hardcoded number to stay current.

### Batch mode (`/schedule`)

`/schedule <wiadomość>` queues the current turn as an Anthropic Batch job
(-50% cost) instead of a live call, per §8/§11.3 of the Master Brief. Full
prior history is sent so it's a real continuation, not an isolated question —
but **no tools are included**: the Batch API has no live round trip, so a
tool call the model asked for could never actually get executed/approved
before the batch "completes." That combination is explicitly out of scope,
not an oversight. Typically resolves in 1-6h (up to 24h) — checked
automatically on CLI startup, or manually with `/batches`. The CLI keeps
chatting normally while a batch is pending; the result lands in history
whenever it's ready, in whatever position the conversation is at by then
(not retroactively inserted where you asked).

### Setup

```bash
cd cli
cp .env.example .env
# fill in ANTHROPIC_API_KEY, and SANDBOX_MCP_URL / OBSIDIAN_MCP_URL if you want those tools
npm install
npm run build
npm start
```

**Important:** because the CLI is now the human-in-the-loop gate, set
`AUTO_APPROVE_TOOLS=run_bash,git_op` on `sandbox-mcp` itself (see its own env
vars above) — otherwise you'd be approving every call twice, once server-side
and once in the CLI. The CLI's own default-deny list is what actually protects
you here.

### Repo layout

```
cli/
├── src/
│   ├── config.ts          # env loading, which tools are auto-approved
│   ├── mcp-client.ts       # one connection to one MCP server (Streamable HTTP)
│   ├── tool-registry.ts    # aggregates tools across servers, routes calls, approval logic
│   ├── approval.ts         # ApprovalGate — [y/N/a] terminal prompt, per-tool "always allow"
│   ├── anthropic-loop.ts    # the tool_use round-trip loop + prompt caching
│   ├── history-store.ts    # JSON-file conversation persistence
│   ├── batch-store.ts      # JSON-file pending-batch tracking
│   ├── batch.ts             # /schedule — Anthropic Batches API (submit + check)
│   ├── usage-tracker.ts    # /usage — per-turn + running session cost estimate
│   └── index.ts            # REPL entrypoint
└── .env.example
```

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
├── cli/                  # interim: terminal chat client (Anthropic + MCP tools + approval gate)
└── .env.example
```
