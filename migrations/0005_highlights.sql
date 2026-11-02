-- 0005: highlights (Phase 5). Each one is stored as a W3C text quote: the
-- exact words plus a little text either side, so it re-anchors in the
-- article even if the stored HTML is cleaned again.
CREATE TABLE IF NOT EXISTS highlights (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL,             -- items.id
  quote      TEXT    NOT NULL,             -- the highlighted words, whitespace collapsed
  prefix     TEXT,                         -- up to ~32 characters before
  suffix     TEXT,                         -- up to ~32 characters after
  note       TEXT,
  starred    INTEGER NOT NULL DEFAULT 0,   -- 1 = the takeaway; at most one per item
  created_at INTEGER NOT NULL              -- unix ms
);

CREATE INDEX IF NOT EXISTS highlights_item ON highlights (item_id);

-- Highlights go when an article is dropped, or expires without one (an
-- expired article with a highlight becomes 'kept' first, see src/db.js).
-- A toss keeps them for its Undo; the sweep clears them once that has passed.
CREATE TRIGGER IF NOT EXISTS highlights_to_heap AFTER UPDATE OF outcome ON items
WHEN NEW.outcome IN ('dropped', 'expired')
BEGIN
  DELETE FROM highlights WHERE item_id = NEW.id;
END;

-- And when the Heap purge deletes the item.
CREATE TRIGGER IF NOT EXISTS highlights_item_delete AFTER DELETE ON items
BEGIN
  DELETE FROM highlights WHERE item_id = OLD.id;
END;
