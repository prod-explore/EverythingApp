# Providers, models and slots

EverythingApp speaks exactly one wire format: OpenAI-compatible chat completions. A **provider** is a record — slug, label, base URL, API key — and every provider is added through the same form (*Settings → Models → Providers*): OpenAI, OpenRouter, a gateway such as MindGate, LM Studio on the LAN. There are no built-in providers and no per-provider code: the list starts empty and the adapter never looks at a provider's name. A server that needs special treatment gets it in the gateway in front of it, not in this app.

| Field | Meaning |
|---|---|
| slug | Lowercase id used in model ids: `@<slug>/<upstream-id>` |
| base URL | Where `/chat/completions` and `/models` live, e.g. `https://openrouter.ai/api/v1` |
| key | Stored AES-256-GCM encrypted (`KEY_VAULT_SECRET`); optional for local servers |
| retry, parallel requests | Plain per-provider settings, see below |

## Model discovery

*Refresh models* calls `GET {base}/models`. Besides the plain OpenAI shape (`{"data":[{"id":"..."}]}`) these fields are understood:

| Field | Source | Effect |
|---|---|---|
| `kind` | gateway | `chat` \| `image` \| `tts` \| `stt` \| `embedding`; guessed from the id when absent. Pickers show `chat` only |
| `tags` | gateway | Free-form labels. `free` marks a model as costing nothing (cost guard); `coder`, `reasoning`, `vision` guide the orchestrator |
| `description` | gateway | One line shown to the orchestrator and as a tooltip |
| `supports` | gateway | Array, e.g. `["tools","vision","reasoning_effort"]`. No `"tools"` → the model is never offered tools; `"reasoning_effort"` shows the Effort control in chats |
| `tool_schema` | gateway | `full` \| `flat` \| `none` — how tool schemas are sent (`flat` for small models that cannot emit nested JSON) |
| `context_length` (or `contextLength`) | gateway / OpenRouter | The model's window in tokens — what context management works from |
| `locality` | gateway | `local` \| `cloud` — where the model runs. Only models positively marked `local` can be used in a ghost chat; absent = unknown = not local |
| `name`, `architecture.input_modalities`, `supported_parameters` | OpenRouter | Mapped to label, vision, tool support, reasoning effort |

**The app keeps no prices** — money is the gateway's business; the app counts tokens only. The one thing taken from a price is “costs nothing”: a model a provider lists at price 0 (OpenRouter `:free`) with no explicit tags gets the `free` tag. Metadata is layered **provider-reported < your override**; there is no built-in model list. Override anything per model in the editor (kind, tags, description, **context window**, **reasoning effort**). A provider that does not report `context_length` (Gemini's compat endpoint doesn't) needs the window typed in once if you want chats compacted *before* they overflow; without it the app reacts only when the provider refuses.

**Models without tool calls are not supported.** The app is an agent framework; a model that reports no `"tools"` support (or is set to `none`) is hidden from the pickers and refused for conversations. Thinking models keep their reasoning: `reasoning_content` / `reasoning` is streamed into a collapsible “Thought process” block and stored with the message, but is never sent back to a provider. Rules on refresh: models you edited or added by hand are never dropped; an empty list is refused; a provider with more than 40 models gets the new ones switched off so you enable what you use.

A request that fails is turned into a sentence a person can act on (rejected key, rate limit that outlived the retry window, budget used up, timeout, conversation too long for the model) with the provider's own words kept as a tooltip.

A gateway can also answer with `error.code = "budget_exhausted"` (HTTP 429): the message is shown as-is and the request is **not** retried, unlike a plain rate limit.

## Where a model runs (ghost chats)

Ghost chats and projects ([ADR 0013](adr/0013-ghost-mode.md)) use only models known to run on your own hardware. Three places can say so, strongest last-word first:

1. **You, per model** — Settings → Models, the *where?* selector on a model (`local` / `cloud` / unknown). It overrides everything below.
2. **The model itself** — a gateway reports `locality` in `GET /models` (MindGate does, per node). A model that reports `cloud` stays cloud even under a provider you marked local.
3. **You, per provider** — *Runs on my own hardware* on the provider card, for a plain Ollama / vLLM / LM Studio server on your LAN that reports nothing. Changing the provider's URL withdraws it.

Nothing is inferred from a URL, a name or a tag, so a model nobody vouched for is never used by accident.

## Slots and the cost guard

| Slot | Used for | When unset |
|---|---|---|
| Chat default | New conversations | first `free` model, else first usable |
| Helper | Chat titles, daily digest, compaction | first `free` model — never a paid one. For a ghost chat only a *local* helper is used; without one, the chat's own model summarises and the title stays a plain slice |
| Agents | Default model of `spawn_agent` workers | the first free model; if none, the parent's own model |
| Escalation | The stronger model the assistant reaches for | none (never automatic) |

**Cost guard:** a chat running on a `free` model can only start `free` workers, unless *Allow agents to use paid models* is on. `spawn_agent` takes `model` (an exact id) or `tag` (first usable model with it). The orchestrator's system prompt contains a generated list of the installed models with their tags and the slot assignments, so it always matches what is actually set up.

## Busy retries (per provider)

The app does not track whether a model is “up” and MindGate is not special: it is just another provider. One setting on each provider card covers peak hours. There is no per-provider timeout: every request is guarded by one generous limit (15 min) that only exists so a hung connection cannot keep a turn running forever; the stop button interrupts any wait. A gateway that has to wake a sleeping node first (MindGate) is covered by the retry window.

| Setting | Default | Use |
|---|---|---|
| *Retry busy errors for … min* | off (two quick retries) | Keep retrying 429/5xx/network errors with backoff for this long — for providers with peak hours |
| *Parallel requests* | 3 | How many requests agent workers may have in flight at this provider; 1 for a server that handles one at a time |

`budget_exhausted` from a gateway is never retried.

The adapter keeps what a provider returns per tool call (`extra_content`, `reasoning_content`) and sends it back unchanged while the tool loop runs, which is what providers with thought signatures or thinking modes ask of an OpenAI-compatible client. Anything beyond that — schema limits, missing fields, odd error codes — is for the gateway to smooth over.

Design rationale: [ADR 0008](adr/0008-unified-provider-catalog.md).
