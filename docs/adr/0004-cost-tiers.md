# 0004 — Cost tiers instead of model names

**Status:** accepted

**Context.** The app is meant to be mostly free to run. Letting agents choose model ids invited hallucinated ids and silent spend.

**Decision.** Four tiers — `free`, `cheap`, `standard`, `strong` — mapped to concrete models in a setting. `spawn_agent` takes a tier, never a model; a worker cannot be above its parent's tier; `free` may fall back at most one tier (`cheap`), nothing escalates further silently. Housekeeping (chat titles, daily digest) uses `free` strictly — if no free model is usable the feature quietly doesn't run and the plain fallback title is kept. Unknown model ids fail fast with an explicit error instead of being routed to the wrong provider.

**Consequences.** Cost policy is one setting, enforceable and testable. Do not send customer data to a free-tier provider that trains on it — tiers are a cost control, not a data-governance one.
