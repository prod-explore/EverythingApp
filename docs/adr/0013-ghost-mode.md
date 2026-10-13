# ADR 0013 — Ghost mode: chats and projects that never leave the machine

Status: accepted (phase H)

## Context

Local models are only useful for private material if the app keeps its promise that the material stays local. In EverythingApp that promise had holes, found while reading every place that sends text somewhere:

- the **helper model** (chat titles, compaction, the daily digest) is by default a free *cloud* model, and it receives the chat's content;
- switching the model in the middle of a chat sends the whole history to whatever was picked;
- `spawn_agent` workers could be started on any model and receive the task plus tool results;
- `web_search` sends the model's query to an engine, `web_fetch` / the browser can carry data in a URL;
- a push notification carried the title and text of an inbox item through a push service.

A per-chat "local only" toggle would not close these, and a toggle that can be switched off is not a guarantee: the moment it is off, the history is exposed.

## Decision

A chat or a project can be a **ghost**. The flag is chosen when it is created and **never changes**:

- `conversations.ghost` and `projects.ghost` (migration 1). A chat in a ghost project is a ghost chat (the flag is also stored on the chat). A database trigger rejects any `UPDATE` that changes the flag in either direction, so no code path — present or future — can flip it. The API answers `400 ghost_immutable`; moving a chat into or out of a ghost project is `409 ghost_move`.
- **Local means positively known to be local** (`ModelInfo.locality === 'local'`), fail-closed: unknown, unreported, a model missing from the catalog — all refused. Sources, in order of precedence: the user's per-model setting, what the provider reports (`locality` in `GET /models`, which MindGate sends per node), the user's per-provider statement "runs on my own hardware" (cleared when the provider's URL changes). Nothing is inferred from URLs, names or tags.
- **Models.** Creation needs a local model (a ghost chat without one asked for starts on the first usable local model; there is no fallback to the global default, which may be cloud). Switching models in a ghost chat accepts local models only. Every turn endpoint (`message`, `edit`, `regenerate`, `retry`, `compact`) refuses with `409 ghost_requires_local_model` *before storing anything* when the model stopped being local, and the turn itself checks again at the last moment.
- **Helper work.** Titles and compaction use a local helper, else the chat's own model (compaction) or nothing (the title stays the first 60 characters). Inbox items from ghost chats are left out of the daily digest.
- **Agents.** Workers of a ghost chat run on local models only (explicit id, tag, the agents slot — a cloud slot is skipped — and on resume). Their transcripts are ghost conversations.
- **Tools.** No `web_search`, `web_fetch`, browser or any other outbound tool. A ghost chat sees only the tools of the connectors in `GHOST_CONNECTORS` (default `sandbox,obsidian`; connectors added in Settings are never included) and the built-in local ones (tasks, questions, reports, files in its own workspace). The system prompt says so.
- **Notifications.** A push for an item from a ghost chat says only that something needs attention.
- **UI.** *New ghost chat* button, *Ghost project* checkbox (with the warning that it cannot be changed), ghost marks in the lists and a *Ghost* badge in the header, the model picker lists local models only.

## Consequences

- A normal chat can never become a ghost chat (its history has already been to the cloud); the UI says "start a new one".
- The guarantee is as good as the `locality` it is given. A hub that mislabels a cloud model as local, or a provider the user marks local that is not, defeats it; both are the user's or the hub's explicit statement. A second line of defence on the hub side (a request-level `local_only` that a gateway enforces even for an alias with cloud fallbacks) is planned with the MindGate work; this change does not send such a signal yet.
- Not covered, on purpose or for later: commands the user approves in the **sandbox** (`curl`, `git push`) can still reach the network the sandbox is allowed to reach — remove `sandbox` from `GHOST_CONNECTORS` for a stricter setup; the **database backup** contains ghost chats like all others; a ghost chat's text is still sent to the *local* model's server, so that server's logging is the user's concern; usage rows (model, token counts, no text) are recorded as for any chat.
