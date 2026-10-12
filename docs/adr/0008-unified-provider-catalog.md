# 0008 — One provider format, a dynamic model catalog and model slots

**Status:** accepted (supersedes [0004](0004-cost-tiers.md) and [0005](0005-batch-for-tool-workers.md))

**Context.** The app hard-wired four providers (Anthropic, Gemini, DeepSeek, MindGate), a built-in model `CATALOG` with capability flags (`supportsBatch`, `supportsWebSearch`), cost tiers mapped to model ids, and a second, separate path for user-added “custom providers”. The plan is for MindGate to be the hub in front of the user's subscriptions, OpenRouter and local nodes, with the app only keeping a direct-API fallback. Anthropic is reached through MindGate (a subscription wrapper), so the Anthropic runtime client and the Batch API are dead weight.

**Decision.**
- A provider is a record: slug, label, base URL, key (vault), dialect (`gemini` | `deepseek` | `mindgate` | `generic`), enabled, optional concurrency. MindGate has no special status — a preset only pre-fills the same form. `OpenAiCompatClient` is the only adapter; the Anthropic runtime client, Batch API and `CATALOG` are gone. `@anthropic-ai/sdk` stays as a types-only dependency because the internal message format is still Anthropic-shaped ([0001](0001-canonical-message-format.md)).
- Models are canonical ids `@<provider>/<upstream-id>`. Legacy bare ids are resolved on read and rewritten once by a migration; `claude-*` ids are left alone and simply stop resolving.
- The catalog is data: `GET {base}/models` fills it (OpenAI shape plus OpenRouter fields plus gateway extensions `kind`, `tags`, `description`, `supports`, `status`, `pricing`). Metadata is layered hint < provider-reported < user override. A provider with more than 40 models gets new ones switched off. Hand-added and user-customised models survive a refresh; an empty list is refused.
- `kind` (`chat`, `image`, `tts`, `stt`, `embedding`) lets pickers show only what fits; `tags` are free-form. `free` is the only tag the app gives meaning to.
- Four slots — chat default, helper, agents, escalation — replace tiers. An unset slot resolves from tags (helper: first free model; agents: helper; escalation: never automatic).
- Cost guard (replaces the tier ordering of 0004): a chat running on a `free` model cannot spawn a non-`free` worker unless “Allow agents to use paid models” is on. `spawn_agent` takes `model` (exact id) or `tag`, not a tier. The orchestrator's system prompt carries a generated list of installed models, tags and slots.
- Budget and rate limits belong to the gateway. The app only keeps the usage ledger and the per-provider “warn at $/month” soft cap; a `budget_exhausted` error from the gateway is shown as-is and never retried.

**Consequences.** One code path for every provider and one place (Settings → Models) to configure it. No web-search or batch features tied to a vendor; web search is a connector/browser tool. The wrapper's handling of `tool_calls` through MindGate is an open risk to verify separately. Not yet done: background retry for long provider outages (only the in-request Gemini retry budget exists) and a provider health banner.
