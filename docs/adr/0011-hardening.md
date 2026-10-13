# ADR 0011 — Service secrets, supervisor token and deployment hardening

Status: accepted (phase F)

## Context

An audit of phase E (2026-10-13) found weaknesses around the code rather than in it:

- `.env.example` shipped placeholder secrets (`change-me`, `your-secret-key-here`, …) and docker-compose only checked that a value was non-empty. A copied example started happily with a secret everybody knows. The example nginx config proxied everything, so `/internal/*` (git-proxy → orchestrator, including a route that hands out GitHub tokens) was reachable from the internet with that known token.
- The sandbox-supervisor API had no authentication. It cannot create arbitrary containers or host mounts, but it can run commands in, read files of and delete the volumes of every managed sandbox, and it listens on a network shared with other services and on the host's loopback.
- The SSE route and the live-view WebSocket accepted the master token as `?token=`. The browser uses the session cookie; the query parameter only put the token into proxy logs and Referer headers.
- Subagents had no file tools, so editing a text file meant a shell command and an approval per command.
- All images were `node:20-alpine` (end of life) while CI ran Node 22, and the Playwright image (1.48) did not match the locked `playwright` package (1.63) whose Chromium revision it must carry.

## Decision

1. **Secrets are checked at startup** (`secret-check.ts`, one copy per package because each package is built on its own in Docker): placeholders, values shorter than 24 characters and values with fewer than 8 distinct characters are refused. `ALLOW_WEAK_SECRETS=true` downgrades the refusal to a warning for local development. `.env.example` now has empty values, so compose's `:?` check also fails loudly. `KEY_VAULT_SECRET` keeps its own rule (it derives an encryption key and cannot be rotated without re-entering provider keys).
2. **`SUPERVISOR_TOKEN`**: the supervisor requires `Authorization: Bearer` on every route except `GET /health`; sandbox-mcp and the orchestrator send it. Compose requires it for all three.
3. **No credentials in URLs**: SSE and the live-view WebSocket accept the session cookie or a Bearer header only.
4. **Constant-time key comparison** in sandbox-mcp and playwright-mcp.
5. **Subagents get `read_file` / `edit_file` / `write_file` by delegation**: the parent names them in `spawn_agent` `tools` like any other tool, and can only delegate what it has (chats without a sandbox have none). Same audit trail as the main assistant.
6. **Deployment**: nginx example blocks `/internal/`, forwards WebSocket upgrades and SSE correctly, limits request size and login attempts. Compose services get memory/CPU/pids limits; plain Node services also drop all capabilities and set `no-new-privileges`. Node 22 everywhere; the Playwright image tag is an `ARG` that a test keeps equal to the locked `playwright` version.
7. **CI**: read-only token permissions, `npm audit --omit=dev --audit-level=high` per package, a Docker build of every image, CodeQL, gitleaks.

## Consequences

- Existing deployments must add `SUPERVISOR_TOKEN` to `.env` and replace any placeholder secret before the stack starts again (the error says which one). Changing `SERVER_AUTH_TOKEN` ends the legacy Bearer use of the old value; sessions are cookie-based and keep working.
- `dockerode` 4.x pulls a `uuid` with a moderate advisory (buffer-bounds check when a target buffer is passed; dockerode does not). Fixing it means a major upgrade of the container-control library, which is not worth doing blind. The web package's remaining moderate advisory is in a build-time Tailwind dependency. Both are below the CI threshold (high).
- Not covered here: taint-based approval for network tools after untrusted web content (ADR 0012 covers the web tools), backups, retention and schema versioning (ADR 0014).
