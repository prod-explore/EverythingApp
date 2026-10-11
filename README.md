# EverythingApp

[![CI](https://github.com/prod-explore/EverythingApp/actions/workflows/ci.yml/badge.svg)](https://github.com/prod-explore/EverythingApp/actions/workflows/ci.yml)
![tests](https://img.shields.io/badge/tests-693%20passing-brightgreen)
![node](https://img.shields.io/badge/node-22-339933)
![license](https://img.shields.io/badge/license-MIT-blue)

A **self-hosted, bring-your-own-key AI workspace**: multi-provider chat, a sandboxed code agent that can browse the web and work with Git, multi-agent delegation with cost tiers, and a human-in-the-loop inbox — designed so that the *model is never trusted*, only the action layer is.

![Chat](docs/img/chat.png)

<table>
<tr>
<td width="50%"><img src="docs/img/question.png" alt="Agent asks a question"><br><sub>Agents ask blocking questions (choices, free text, forms) or park them in the inbox.</sub></td>
<td width="50%"><img src="docs/img/agents.png" alt="Agents panel"><br><sub>Workers keep their transcript; finished agents stay under <i>Completed</i> and can be resumed.</sub></td>
</tr>
<tr>
<td><img src="docs/img/search.png" alt="Full-text search"><br><sub>SQLite FTS5 search over every message (⌘/Ctrl+K).</sub></td>
<td><img src="docs/img/slash.png" alt="Slash commands"><br><sub>Slash commands in the composer.</sub></td>
</tr>
</table>

<p align="center"><img src="docs/img/mobile.png" alt="Mobile" width="260"></p>

## Highlights

| Area | What it does |
|---|---|
| **Providers** | Anthropic, Gemini, DeepSeek, MindGate (local) and any OpenAI-compatible endpoint. One canonical Anthropic-shaped message format; an adapter translates the rest. Keys are AES-256-GCM encrypted at rest. |
| **Cost tiers** | `free → cheap → standard → strong`. Chats default to the free tier, workers cannot out-rank their parent, background chores (titles, daily digest) never leave `free`. |
| **Agents** | `spawn_agent` / `wait_agents` / `send_message`. Per-tree budgets, depth and spawn limits, kill switch. Finished workers can be resumed with a follow-up. |
| **Batch** | Plain chat turns can be queued via the Batch API; **tool-using workers** run as a chain of one-request batches (every step −50 %, tools execute locally behind the approval gate). |
| **Sandbox** | Per-project Docker container, no secrets, no `docker.sock`. Files explorer + editor with a checkpoint before every edit, rollback, Source Control, GitHub. |
| **Browser** | Playwright agent with domain/JS policy, SSRF guard and a quarantined extraction model; live view in the UI. |
| **Human in the loop** | Approval gate (inline cards), Gazeta inbox (blocking and async questions, reports, urgent → Web Push), `policy.json` for always-allow / always-block. |
| **UX** | FTS5 search, Markdown/JSON export, message branching, quote-selection, slash commands, PWA, WCAG-AA clean (axe: 0 violations at 1440×900 and 390×844). |

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI[React 19 PWA<br/>assistant-ui · SSE]
  end
  subgraph Orchestrator["Orchestrator (Node/Express)"]
    API[REST + SSE]
    LOOP[Agent loop<br/>tool registry · virtual tools]
    GATE[Approval gate<br/>+ policy.json]
    ROUTER[Provider router<br/>tiers · key vault · retry]
    AGENTS[AgentManager<br/>runs · budgets · batch]
    DB[(SQLite<br/>FTS5)]
  end
  subgraph Isolated["Isolated networks"]
    SUP[sandbox-supervisor] --> SBX[(sandbox<br/>container)]
    PW[playwright-mcp]
    GP[git-proxy<br/>scoped tokens]
  end
  UI <--> API
  API --> LOOP --> ROUTER --> LLM{{Anthropic · Gemini · DeepSeek · local}}
  LOOP --> GATE --> MCP[MCP: sandbox · browser · GitHub · custom]
  LOOP --> AGENTS --> LOOP
  API --- DB
  MCP --> SUP
  MCP --> PW
  SBX -. git over HTTP, no credentials .-> GP --> GH[(github.com)]
  GP -- push approval --> GATE
```

Packages: `cli` (orchestrator), `web` (UI), `sandbox-supervisor` + `sandbox-mcp` (container lifecycle and its MCP tools), `playwright-mcp` (browser agent), `git-proxy` (the only thing that ever sees a GitHub token), `tools/mock-llm` (deterministic fake model used by E2E and the screenshots above).

## Security model

The model is treated as an untrusted component. The boundary is the **action layer**, not the prompt.

1. **Approval gate** – every tool call with a side effect becomes an approval card; grants are scoped (this call / this project / this prefix). Shell commands go through a policy engine (`strict`, `allowlist`, `auto-in-sandbox`); destructive patterns are always blocked.
2. **No secrets in the sandbox** – the container has no API keys, no `docker.sock`, no database. Git goes through `git-proxy`, which holds the token, mints short-lived scoped tokens and asks a human before any push to a protected branch.
3. **Deterministic filter before any LLM** – the browser's observations are sanitised by code first; the optional quarantine model only ever sees already-filtered text and has no tools.
4. **Sessions** – password login, HttpOnly cookie; no token in `localStorage` or URLs. WebSocket/SSE accept the cookie only (cross-origin upgrades are rejected).
5. **Audit log** – approvals, grants, pushes and file edits are recorded.
6. **Policy as a file** – always-allow / always-block prefixes and known domains live in `policy.json` (hot-reloaded), not in a UI an agent could be talked into editing. Details in [ADR 0002](docs/adr/0002-policy-file-not-ui.md).

## Quickstart (no Docker, no API key)

Runs the whole UI against the deterministic mock model:

```bash
git clone https://github.com/prod-explore/EverythingApp && cd EverythingApp
(cd cli && npm ci && npm run build)
(cd web && npm ci && npx vite build)

node tools/mock-llm/server.mjs &                      # fake OpenAI-compatible model on :4010
cd cli
SERVER_AUTH_TOKEN=dev SERVER_PASSWORD=dev \
KEY_VAULT_SECRET=$(openssl rand -hex 32) \
MINDGATE_BASE_URL=http://127.0.0.1:4010/v1 PORT=3000 node dist/server.js
```

Open <http://localhost:3000>, log in with `dev`, then **Settings → Models → MindGate**: save any key and pick the `flash` model. Try `ask: which database?`, `report`, `spawn`, `long`.

### Full stack (sandbox, browser, git)

```bash
cp .env.example .env     # set KEY_VAULT_SECRET, SERVER_AUTH_TOKEN, MCP_API_KEY, GIT_PROXY_ADMIN_TOKEN, DOCKER_GID
docker build -t everything-sandbox:latest ./sandbox-supervisor/sandbox-image/
docker compose up --build
```

Deployment notes for a Raspberry Pi (egress guard, Nginx + HTTPS) are in [`deploy/`](deploy).

## Development

```bash
cd cli && npm test            # 307 tests (node:test, in-memory SQLite, fake providers)
cd git-proxy && npm test      #  40
cd sandbox-mcp && npm test    #  18
cd sandbox-supervisor && npm test  # 78
cd playwright-mcp && npm test #  250
cd web && npx tsc -b && npx vite build
```

CI runs all of the above on every push. The browser E2E (Playwright against the mock stack) checks the main flows plus console errors at 1440×900 and 390×844.

## Design decisions

Short ADRs in [`docs/adr`](docs/adr): canonical message format, policy file, sandbox/Git credentials, cost tiers, batch for tool workers, session cookies, lazy FTS5 index.

## License

[MIT](LICENSE)
