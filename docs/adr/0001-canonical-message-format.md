# 0001 — One canonical message format (Anthropic-shaped)

**Status:** accepted

**Context.** The app talks to Anthropic, Gemini, DeepSeek, a local gateway and arbitrary OpenAI-compatible servers. Storing history per provider would make switching models mid-conversation impossible.

**Decision.** Messages are stored once, in Anthropic's block format (`text`, `tool_use`, `tool_result`, images). `OpenAiCompatClient` translates to/from chat-completions per *flavor* (gemini, deepseek, mindgate, generic), including streaming and tool-call quirks — e.g. small local models that print a tool call as JSON text are recovered when (and only when) the named tool was actually offered.

**Consequences.** Any conversation can continue on any model; the loop, tests and UI have one shape to care about. Cost: the adapter owns provider oddities, and features without an equivalent (prompt-cache breakpoints, server-side web search, Batch API) are gated by `ModelInfo` flags.
