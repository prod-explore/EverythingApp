# 0007 — Lazily synced FTS5 index

**Status:** accepted

**Context.** Messages are written and deleted from many places (turns, edits, branch retirement, cascades).

**Decision.** `messages_fts` is a plain FTS5 table keyed by message id, synced right before each search: index new rows, drop rows whose message is gone. Only user/assistant text is indexed (not tool inputs/results, not worker transcripts). User input is turned into quoted prefix terms, so no FTS operator or syntax error can be injected.

**Consequences.** No triggers or write-path bookkeeping; cost is proportional to new messages since the last search, fine at single-user scale. Switch to triggers if the corpus gets large.
