-- 0001: the V1 schema. Every statement is IF NOT EXISTS, so this is safe on a
-- database that V1 already created.
--
-- Where an item is follows from `outcome`:
--   NULL = Rack, 'done' = Vault, 'tossed' / 'dropped' / 'expired' = Heap.
CREATE TABLE IF NOT EXISTS items (
  id         INTEGER PRIMARY KEY,
  url        TEXT    NOT NULL,             -- normalised, tracking params removed
  title      TEXT    NOT NULL,             -- falls back to the URL
  site       TEXT    NOT NULL,             -- domain
  minutes    INTEGER,                      -- estimated reading time, nullable
  intent     TEXT,                         -- 'tonight', 'commute', 'weekend' or NULL
  saved_at   INTEGER NOT NULL,             -- unix ms
  expires_at INTEGER NOT NULL,             -- saved_at + lifespan, + extension if used
  extended   INTEGER NOT NULL DEFAULT 0,   -- 0 or 1
  outcome    TEXT,                         -- NULL while in the rack
  ended_at   INTEGER,                      -- when it left the rack
  takeaway   TEXT                          -- Vault items only
);

-- A URL can only be in the rack once.
CREATE UNIQUE INDEX IF NOT EXISTS items_rack_url ON items (url) WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS items_outcome ON items (outcome, ended_at);

-- Small key/value store: each applied migration is recorded here as
-- 'migration:N'. Later phases may add their own keys.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
