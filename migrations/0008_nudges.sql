-- 0008: gentle nudges (Phase 8): reading time per day, push subscriptions and
-- the reminder's preferences.

-- Active reading seconds per local date (the reader sends its own date).
CREATE TABLE IF NOT EXISTS reading_days (
  day     TEXT PRIMARY KEY,                 -- YYYY-MM-DD, the client's local date
  seconds INTEGER NOT NULL DEFAULT 0
);

-- One row per browser that turned the daily reminder on. Pushes carry no
-- payload, so p256dh and auth are kept only in case that ever changes.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT,
  auth       TEXT,
  created_at INTEGER                        -- unix ms
);

-- Reminder preferences live in meta, off by default. tz_offset_minutes is
-- what to add to UTC for the owner's local time, as of the last change.
-- last_reminder_day and the VAPID key pair are written when first needed.
INSERT OR IGNORE INTO meta (key, value) VALUES
  ('reminder_enabled', '0'),
  ('reminder_hour', '8'),
  ('tz_offset_minutes', '0');
