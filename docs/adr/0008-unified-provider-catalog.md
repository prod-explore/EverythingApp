# 0008 — One provider format, a dynamic model catalog and model slots

**Status:** accepted (supersedes [0004](0004-cost-tiers.md) and [0005](0005-batch-for-tool-workers.md))

**Context.** The app hard-wired four providers (Anthropic, Gemini, DeepSeek, MindGate), a built-in model `CATALOG` with capability flags and prices, cost tiers mapped to model ids, and a second, separate path for user-added “custom providers”. The plan is for MindGate to be the hub in front of the user's subscriptions, OpenRouter and local nodes, with the app only keeping a direct-API fallback. Anthropic is reached through MindGate (a subscription wrapper), so the Anthropic client, SDK and Batch API are dead weight.

**Decision.**
- A provider is a record: slug, label, base URL, key (vault), dialect (`gemini` | `deepseek` | `mindgate` | `generic`), enabled, optional concurrency. MindGate has no special status — a preset only pre-fills the same form. `OpenAiCompatClient` is the only adapter; the Anthropic client, Batch API, `CATALOG` and the SDK are gone; the message types are the app's own ([0001](0001-canonical-message-format.md)).
- Models are canonical ids `@<provider>/<upstream-id>`. Ids are never guessed or rewritten; an id that is not in the catalog simply does not resolve.
- The catalog is data: `GET {base}/models` fills it (OpenAI shape plus OpenRouter fields plus gateway extensions `kind`, `tags`, `description`, `supports`, `tool_schema`, `status`). Metadata is layered provider-reported < user override; there is no built-in model list. Dialect rules (not per-model tables) cover the rest, e.g. an output-token floor for thinking models. A provider with more than 40 models gets new ones switched off. Hand-added and user-customised models survive a refresh; an empty list is refused.
- `kind` (`chat`, `image`, `tts`, `stt`, `embedding`) lets pickers show only what fits; `tags` are free-form. `free` is the only tag the app gives meaning to.
- Four slots — chat default, helper, agents, escalation — replace tiers. An unset slot resolves from tags (helper: first free model; agents: helper; escalation: never automatic).
- Cost guard (replaces the tier ordering of 0004): a chat running on a `free` model cannot spawn a non-`free` worker unless “Allow agents to use paid models” is on. `spawn_agent` takes `model` (exact id) or `tag`, not a tier. The orchestrator's system prompt carries a generated list of installed models, tags and slots.
- Money belongs to the gateway: the app keeps **no prices**, only a token usage ledger and a per-run-tree token budget for agents; a `budget_exhausted` error from the gateway is shown as-is and never retried.
- Models that cannot call tools are not supported (the app is an agent framework): they are hidden from pickers and refused for conversations.
- Thinking is a first-class block: streamed, stored, displayed, never replayed to a provider.

**Consequences.** One code path for every provider and one place (Settings → Models) to configure it. No web-search or batch features tied to a vendor; web search is a connector/browser tool. The wrapper's handling of `tool_calls` through MindGate is an open risk to verify separately. Availability is not tracked and no provider is special: two per-provider settings (wait time, busy-retry window) cover slow gateways and peak hours; Wake-on-LAN belongs to MindGate. Not yet done: background retry for long provider outages (only the in-request retry and the Gemini budget exist), automatic fallback to another model, and context-window management.
