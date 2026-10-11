# 0006 — Password login with an HttpOnly session cookie

**Status:** accepted

**Context.** The first version kept a bearer token in `localStorage` and put it in SSE/WebSocket/file URLs.

**Decision.** `POST /api/login` exchanges the password for an HttpOnly, SameSite cookie. No token reaches JavaScript or URLs; SSE, WebSocket live view and artifact/workspace downloads authenticate via the cookie, cross-origin WebSocket upgrades are rejected, and a 401 returns to the login screen without reload loops. The bearer token stays for machine clients (tests, internal endpoints).

**Consequences.** XSS can no longer exfiltrate a long-lived credential; state-changing routes rely on SameSite plus origin checks.
