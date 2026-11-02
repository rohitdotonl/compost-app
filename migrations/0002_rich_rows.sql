-- 0002: rich rows (Phase 1) and the optional "why" note the extension sends.
-- All nullable: rows saved before this migration simply have none of them.
ALTER TABLE items ADD COLUMN description TEXT;   -- og:description or meta description
ALTER TABLE items ADD COLUMN image_url   TEXT;   -- og:image / twitter:image, absolute
ALTER TABLE items ADD COLUMN favicon_url TEXT;   -- link rel=icon, or /favicon.ico
ALTER TABLE items ADD COLUMN author      TEXT;   -- meta author / article:author, a name only
ALTER TABLE items ADD COLUMN lang        TEXT;   -- <html lang>
ALTER TABLE items ADD COLUMN note        TEXT;   -- the saver's one-line "why", <= 200 chars
