# 0001 — One canonical message format

**Status:** accepted

**Context.** The app talks to Gemini, DeepSeek, a local gateway and arbitrary OpenAI-compatible servers. Storing history per provider would make switching models mid-conversation impossible.

**Decision.** Messages are stored once, as content blocks defined in `cli/src/llm-types.ts`: `text`, `tool_use`, `tool_result`, `image`, and `thinking` (the model's visible reasoning — stored and shown, never sent back). The app has no vendor SDK; these types are its own. `OpenAiCompatClient` translates to/from chat-completions per *flavor* (gemini, deepseek, mindgate, generic), including streaming and tool-call quirks — e.g. small local models that print a tool call as JSON text are recovered when (and only when) the named tool was actually offered.

**Consequences.** Any conversation can continue on any model; the loop, tests and UI have one shape to care about. Cost: the adapter owns provider oddities. Vendor-only features (prompt-cache breakpoints, server-side web search, batch APIs) do not exist in the format; web access is a connector tool.
