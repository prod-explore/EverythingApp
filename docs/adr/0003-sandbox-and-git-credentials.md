# 0003 — Sandbox without secrets; Git through a credential-holding proxy

**Status:** accepted

**Context.** An agent that can run shell commands must not be able to read API keys, the database or the Docker socket — and still needs `git clone` / `push`.

**Decision.** The sandbox container gets none of those. GitHub is connected once in app settings (device flow or PAT, stored encrypted). Inside the sandbox, git talks to `git-proxy` with a short-lived token minted per project (wildcard grants allow cloning any repo of the connected account). The proxy injects the real credential, enforces what the token may do, and asks a human before pushes to protected branches or forced updates. Repositories are simply cloned by URL — there is no per-project Git configuration.

**Consequences.** Compromising the sandbox yields at most an expiring, narrowly scoped proxy token. The proxy is one more service to operate.
