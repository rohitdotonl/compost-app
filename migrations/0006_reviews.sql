-- 0006: spaced review and the daily line (Phase 6).
--
-- One review row per takeaway (highlight_id NULL) or starred highlight. It
-- holds when that line may come back and how far out the next return is.
CREATE TABLE IF NOT EXISTS reviews (
  id            INTEGER PRIMARY KEY,
  item_id       INTEGER NOT NULL,             -- the Vault item
  highlight_id  INTEGER,                      -- NULL = the item's takeaway
  interval_days INTEGER NOT NULL DEFAULT 1,   -- current step in REVIEW_INTERVALS
  due_at        INTEGER NOT NULL,             -- unix ms
  retired       INTEGER NOT NULL DEFAULT 0,   -- 1 after "Let it go"
  last_shown_at INTEGER                       -- unix ms
);

CREATE INDEX IF NOT EXISTS reviews_due ON reviews (retired, due_at);
-- NULLs never clash in a unique index, so the takeaway row counts as 0.
CREATE UNIQUE INDEX IF NOT EXISTS reviews_target ON reviews (item_id, COALESCE(highlight_id, 0));

-- The pick for each local date, so every device shows the same line all day.
CREATE TABLE IF NOT EXISTS daily (
  day         TEXT PRIMARY KEY,               -- YYYY-MM-DD, the client's local date
  review_id   INTEGER,
  answered_at INTEGER                         -- set once it was answered, so the buttons stay gone
);
