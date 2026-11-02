// ---------------------------------------------------------------------------
// The rules. These are the product: change them here, deliberately.
// There is no settings screen on purpose.
// ---------------------------------------------------------------------------
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export const SLOT_LIMIT = 10;           // articles the rack can hold
export const LIFESPAN = 7 * DAY;        // time from saving to expiry
export const EXTENSION = 48 * HOUR;     // one extension per article
export const HEAP_KEEP = 30 * DAY;      // heap items are purged after this
export const UNDO_WINDOW = 10 * 1000;   // a toss can be undone this long after it
export const WORDS_PER_MINUTE = 230;    // for the reading-time estimate
export const FETCH_TIMEOUT = 5000;      // ms to wait for a page's title
// Phase 6: the daily line and spaced review.
export const MIN_VAULT_FOR_DAILY = 20;              // takeaways needed before a daily line shows
export const REVIEW_INTERVALS = [1, 7, 30, 90, 180]; // days; "Still useful" steps along, stays at the last
export const REVIEW_MIN_AGE = 14 * DAY;              // with nothing due, only lines older than this
export const REVIEW_RESHOW = 30 * DAY;               // ...and not shown within this
export const INTENTS = ['tonight', 'commute', 'weekend'];

// Query parameters that only track where a click came from.
export const TRACKING_PARAMS = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^dclid$/i, /^gbraid$/i, /^wbraid$/i,
  /^msclkid$/i, /^yclid$/i, /^twclid$/i, /^igshid$/i, /^mc_cid$/i, /^mc_eid$/i,
  /^_ga$/i, /^_gl$/i, /^_hsenc$/i, /^_hsmi$/i, /^mkt_tok$/i, /^vero_id$/i,
  /^oly_anon_id$/i, /^oly_enc_id$/i, /^wt_mc$/i, /^ref_src$/i, /^ref_url$/i,
];

// Sent to the app with every list, so the client never hard-codes a rule.
export const RULES = { slots: SLOT_LIMIT, lifespan: LIFESPAN, extension: EXTENSION, heapKeep: HEAP_KEEP, undoWindow: UNDO_WINDOW };
