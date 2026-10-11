# 0005 — Batch API for tool-using workers via a batched client

**Status:** accepted

**Context.** The Batch API is 50 % cheaper but asynchronous, so it fit only text-only turns. Agent loops need *submit → tool call → execute → submit*.

**Decision.** `createBatchedClient` implements the same `LlmClient` interface as a live client, but each `messages.create` submits a one-request batch, polls until it ends and returns the message. The unchanged agent loop therefore becomes the chain: tools run locally behind the normal approval gate, and an approval simply waits for a human *between* two batches (nothing is held at the provider). Each step is billed at the batch rate. Enabled per worker with `spawn_agent {batch: true}`; refused for providers without a Batch API or without a key. Stop aborts the polling. It never occupies a provider concurrency slot while waiting.

**Consequences.** Minutes of latency per step: for background work only. A server restart marks in-flight batched workers as interrupted (state lives in the loop, not in a durable workflow engine) — acceptable for now, revisit if long chains matter.
