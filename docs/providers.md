# Providers, models and slots

EverythingApp speaks exactly one wire format: OpenAI-compatible chat completions. A **provider** is a record — slug, label, base URL, API key, dialect — and every provider is added through the same form (*Settings → Models → Providers*): MindGate, Gemini, DeepSeek, OpenRouter, LM Studio on the LAN. The presets only pre-fill that form.

| Field | Meaning |
|---|---|
| slug | Lowercase id used in model ids: `@<slug>/<upstream-id>` |
| base URL | Where `/chat/completions` and `/models` live, e.g. `https://openrouter.ai/api/v1` |
| key | Stored AES-256-GCM encrypted (`KEY_VAULT_SECRET`); optional for local servers |
| dialect | `generic`, `mindgate`, `gemini`, `deepseek` — small per-provider quirks (tool-call recovery, retry rules) |

## Model discovery

*Refresh models* calls `GET {base}/models`. Besides the plain OpenAI shape (`{"data":[{"id":"..."}]}`) these fields are understood:

| Field | Source | Effect |
|---|---|---|
| `kind` | gateway | `chat` \| `image` \| `tts` \| `stt` \| `embedding`; guessed from the id when absent. Pickers show `chat` only |
| `tags` | gateway | Free-form labels. `free` marks a model as costing nothing (cost guard); `coder`, `reasoning`, `vision` guide the orchestrator |
| `description` | gateway | One line shown to the orchestrator and as a tooltip |
| `supports` | gateway | Array, e.g. `["tools","vision"]`. No `"tools"` → the model is never offered tools |
| `status` | gateway | `online` \| `asleep` \| `waking` (a local node behind Wake-on-LAN) |
| `pricing.input/output` | gateway | USD per **million** tokens |
| `name`, `context_length`, `pricing.prompt/completion` (per token), `architecture.input_modalities`, `supported_parameters` | OpenRouter | Mapped to label, context, price, vision, tool support |

A model priced at zero with no explicit tags gets the `free` tag. Metadata is layered **built-in hint < provider-reported < your override**; override anything per model in the editor (kind, tags, description, price). Rules on refresh: models you edited or added by hand are never dropped; an empty list is refused; a provider with more than 40 models gets the new ones switched off so you enable what you use.

A gateway can also answer with `error.code = "budget_exhausted"` (HTTP 429): the message is shown as-is and the request is **not** retried, unlike a plain rate limit.

## Slots and the cost guard

| Slot | Used for | When unset |
|---|---|---|
| Chat default | New conversations | first `free` model, else first usable |
| Helper | Chat titles, daily digest | first `free` model — never a paid one |
| Agents | Default model of `spawn_agent` workers | the helper; if none, the parent's own model |
| Escalation | The stronger model the assistant reaches for | none (never automatic) |

**Cost guard:** a chat running on a `free` model can only start `free` workers, unless *Allow agents to use paid models* is on. `spawn_agent` takes `model` (an exact id) or `tag` (first usable model with it). The orchestrator's system prompt contains a generated list of the installed models with their tags and the slot assignments, so it always matches what is actually set up.

## Migrating from the pre-catalog versions

On first start the app imports what was configured before: built-in providers that had a stored key, custom providers with their models, and rewrites stored model ids (`gemini-3.5-flash-lite` → `@gemini/gemini-3.5-flash-lite`, `flash` → `@mindgate/flash`). Anthropic is no longer a provider; `claude-*` ids stop resolving — switch those chats to a catalog model.

Design rationale: [ADR 0008](adr/0008-unified-provider-catalog.md).
