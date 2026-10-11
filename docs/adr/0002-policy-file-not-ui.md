# 0002 — Allow/block lists live in `policy.json`, not in the UI

**Status:** accepted

**Context.** Per-project screens for "always allow", "always block", domains and browser rules were noisy, and — worse — a settings surface that grows with every convenience is a surface an injected agent can try to talk a user into loosening.

**Decision.** Project settings keep only the command *mode* and the grants a human created from approval cards. Always-allow / always-block prefixes, known domains and the default browser policy are read from `policy.json` next to the database (hot-reloaded, validated, merged under the built-in destructive-pattern blocklist, which cannot be overridden). The browser gets sane defaults and no per-project knobs.

**Consequences.** Loosening policy requires file access, not a click. Changes apply on the next command without a restart; a broken file is reported and ignored, never half-applied.
