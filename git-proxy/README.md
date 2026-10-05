# git-proxy

Git smart-HTTP proxy between the agent sandboxes and `https://github.com` (phase N4). Sandboxes run plain
`git` (clone, fetch, push, LFS) without ever holding a GitHub credential:

- **Credential injection**: the sandbox authenticates with a short-lived opaque *proxy token*. git-proxy drops
  the client's `Authorization`/`Cookie` headers and injects the project's GitHub token
  (`Basic x-access-token:<token>`), fetched from the orchestrator (`GET /internal/github-token`) or, failing that,
  from `GITHUB_PAT`. The GitHub token is never sent back to the sandbox.
- **Repo binding**: each proxy token lists the repos it may touch. Anything else gets a `403` with a text
  message that git prints as `remote: …`.
- **Push approval**: every `git-receive-pack` command section (`<old> <new> <ref>`) is parsed and each ref is
  classified as `create` / `update` / `delete`, with force-push detection via the GitHub compare API. Depending on
  the repo's `pushMode` the push is allowed, sent to the orchestrator as an approval card (long poll), or refused.
  A refusal comes back as a proper report-status (`! [remote rejected] main -> main (rejected by user)`).
- **Audit**: every request and every push decision is written to stdout as a JSON line and POSTed
  (fire-and-forget) to the orchestrator's `/internal/audit` endpoint.

Pack data is streamed in both directions. The only thing buffered is the receive-pack command section (the
ref list before the first flush-pkt). gzip request bodies are supported: upload-pack bodies are passed through
unchanged, receive-pack bodies are decompressed so they can be parsed.

## Sandbox git configuration

Run this once inside the sandbox, replacing `<TOKEN>` with a freshly minted proxy token:

```sh
# HTTPS remotes
git config --global url."http://x-token:<TOKEN>@git-proxy:8080/".insteadOf "https://github.com/"
# SSH remotes (git@github.com:owner/repo.git and ssh://git@github.com/owner/repo.git) are moved to HTTPS too
git config --global --add url."http://x-token:<TOKEN>@git-proxy:8080/".insteadOf "git@github.com:"
git config --global --add url."http://x-token:<TOKEN>@git-proxy:8080/".insteadOf "ssh://git@github.com/"
# Git LFS follows the rewritten remote URL automatically, nothing extra to configure.
```

The username is ignored (`x-token` is just a label). The token can go in the basic-auth password (or the username
if the password is empty), or in `Authorization: Bearer <TOKEN>`. git first sends a request without credentials;
git-proxy answers `401` with a `WWW-Authenticate: Basic` challenge, and git then retries with the credentials
from the URL.

When a token expires git reports `remote: git-proxy: proxy token is invalid or expired`. The orchestrator should
mint a new token and rewrite the `insteadOf` lines (`git config --global --unset-all url.<old>.insteadOf` first).
The token only ever lives in the sandbox's global git config, never in the workspace.

## Admin API (orchestrator → git-proxy)

Every admin call needs `Authorization: Bearer $GIT_PROXY_ADMIN_TOKEN`.

```http
POST /admin/tokens
{"projectId":"p_123","repos":[{"owner":"acme","repo":"app","pushMode":"ask"}],"ttlSeconds":3600}
→ 201 {"token":"gpx_…","expiresAt":"2026-10-05T12:00:00.000Z"}

DELETE /admin/tokens/<token>          → 204 (404 if unknown)
DELETE /admin/tokens?projectId=p_123  → 200 {"revoked":2}   (revoke every token of a project)
GET    /health                        → 200 {"ok":true,"tokens":3}
```

- `pushMode`: `ask` (default) always asks for approval. `allow` pushes without asking, **except** for ref
  deletions, detected force pushes, and updates of protected branches (`GIT_PROXY_PROTECTED_BRANCHES`) whose
  fast-forwardness could not be verified. `deny` makes the repo read-only, including LFS uploads.
- `ttlSeconds` defaults to `GIT_PROXY_DEFAULT_TOKEN_TTL_SECONDS` and is capped at `GIT_PROXY_MAX_TOKEN_TTL_SECONDS`.
- Tokens live in memory and are keyed by their sha256 hash. Restarting git-proxy invalidates every token.

Example:

```sh
curl -s -X POST http://git-proxy:8080/admin/tokens \
  -H "Authorization: Bearer $GIT_PROXY_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"projectId":"p_123","repos":[{"owner":"acme","repo":"app","pushMode":"ask"}],"ttlSeconds":3600}'
```

## Orchestrator endpoints git-proxy calls

All calls carry `Authorization: Bearer $GIT_PROXY_ADMIN_TOKEN` and go to `ORCHESTRATOR_URL`.

| Call | Request | Expected response |
|---|---|---|
| `GET /internal/github-token?projectId=…` | – | `200 {"token":"ghs_…","expiresAt"?:"ISO"}`. Any non-2xx or a missing token falls back to `GITHUB_PAT`. Cached for ≤5 min (or until `expiresAt − 60s`). |
| `POST /internal/push-approval` | `{"projectId","owner","repo","refs":[{"ref","old","new","kind":"create"\|"update"\|"delete","force":true\|false\|null}]}` | Keep the request open until the user decides, then `200 {"approved":true\|false,"reason"?:"…"}`. Non-2xx, unreachable, or no answer within `PUSH_APPROVAL_TIMEOUT_MS` counts as a denial. If the sandbox's git disconnects, git-proxy aborts the request, so the card can be withdrawn. |
| `POST /internal/audit` | `{"ts","service":"git-proxy","type":"request"\|"push_decision"\|"token_minted"\|"token_revoked"\|"tokens_revoked",…}` | Any 2xx. The body is ignored and the call is fire-and-forget. |

`force: null` means the proxy could not verify it. The usual case is that the new commit exists only in the pack
being pushed, so GitHub's compare API returns 404. The UI should show this as "possibly force".

## Configuration

| Env | Default | |
|---|---|---|
| `GIT_PROXY_PORT` | `8080` | listen port |
| `GIT_PROXY_ADMIN_TOKEN` | – (required) | protects `/admin/*`; also sent to the orchestrator |
| `ORCHESTRATOR_URL` | – | e.g. `http://everythingapp-web:3000`. Without it, every push that needs approval is rejected. |
| `GITHUB_PAT` | – | fallback GitHub credential |
| `GITHUB_UPSTREAM_URL` | `https://github.com` | smart-HTTP upstream |
| `GITHUB_API_URL` | `https://api.github.com` | compare API (force detection) |
| `PUSH_APPROVAL_TIMEOUT_MS` | `600000` | max wait for an approval decision |
| `GIT_PROXY_PROTECTED_BRANCHES` | `main,master` | comma-separated |
| `GIT_PROXY_DEFAULT_TOKEN_TTL_SECONDS` | `3600` | |
| `GIT_PROXY_MAX_TOKEN_TTL_SECONDS` | `86400` | |

## Limitations (v1)

- Signed pushes (`push-cert`) are rejected with a 400.
- Force detection relies on the compare API, so new commits pushed over an existing ref usually come out as
  `force: null`.
- LFS is best effort: the batch/locks API is proxied, but object transfers go straight from the sandbox to the
  storage URLs GitHub returns, which carry their own short-lived auth.
- Tokens are in memory only, so a restart revokes them all.

## Develop

```sh
npm install
npx tsc && node --test --test-timeout=15000 dist/__tests__/*.test.js
```
