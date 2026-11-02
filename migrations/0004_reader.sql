-- 0004: the reader (Phase 4). Article text lives in its own table so the list
-- query stays light; a full-text index covers title, text and takeaway.

-- One row per extracted article. status is 'ok' or 'failed'; a failed row
-- has no html and tells every device not to try again.
CREATE TABLE IF NOT EXISTS contents (
  item_id      INTEGER PRIMARY KEY,   -- items.id
  html         TEXT,                  -- clean article HTML, images via /img
  text         TEXT,                  -- plain text, for search and word counts
  words        INTEGER,
  excerpt      TEXT,
  byline       TEXT,
  extracted_at INTEGER,               -- unix ms
  status       TEXT NOT NULL          -- 'ok' | 'failed'
);

-- Where you stopped (0..1 of the scroll height) and when.
ALTER TABLE items ADD COLUMN progress REAL DEFAULT 0;
ALTER TABLE items ADD COLUMN last_read_at INTEGER;

-- Full-text search. rowid = items.id. Kept in step by the triggers below,
-- so no route has to remember to update it.
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  title, text, takeaway,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

INSERT INTO search (rowid, title, text, takeaway)
  SELECT id, title, '', COALESCE(takeaway, '') FROM items;

CREATE TRIGGER IF NOT EXISTS search_item_insert AFTER INSERT ON items
BEGIN
  INSERT INTO search (rowid, title, text, takeaway) VALUES (NEW.id, NEW.title, '', COALESCE(NEW.takeaway, ''));
END;

CREATE TRIGGER IF NOT EXISTS search_item_update AFTER UPDATE OF title, takeaway ON items
BEGIN
  UPDATE search SET title = NEW.title, takeaway = COALESCE(NEW.takeaway, '') WHERE rowid = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS search_content_insert AFTER INSERT ON contents
BEGIN
  UPDATE search SET text = COALESCE(NEW.text, '') WHERE rowid = NEW.item_id;
END;

CREATE TRIGGER IF NOT EXISTS search_content_update AFTER UPDATE OF text ON contents
BEGIN
  UPDATE search SET text = COALESCE(NEW.text, '') WHERE rowid = NEW.item_id;
END;

CREATE TRIGGER IF NOT EXISTS search_content_delete AFTER DELETE ON contents
BEGIN
  UPDATE search SET text = '' WHERE rowid = OLD.item_id;
END;

-- The text goes when an article leaves for the Heap (toss, drop or expiry,
-- whichever route or sweep step does it). Vault items keep theirs.
CREATE TRIGGER IF NOT EXISTS contents_to_heap AFTER UPDATE OF outcome ON items
WHEN NEW.outcome IN ('tossed', 'dropped', 'expired')
BEGIN
  DELETE FROM contents WHERE item_id = NEW.id;
END;

-- And everything goes when the Heap purge deletes the item.
CREATE TRIGGER IF NOT EXISTS item_delete AFTER DELETE ON items
BEGIN
  DELETE FROM contents WHERE item_id = OLD.id;
  DELETE FROM search WHERE rowid = OLD.id;
END;
