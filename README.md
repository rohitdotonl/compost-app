# Compost

A personal read-later app with a hard limit. The rack holds 10 articles. Each
one expires 7 days after you save it. Only the ones you finish are kept, in the
Vault, with a one-line takeaway.

It is one Cloudflare Worker: it serves the app, answers a tiny API and talks to
one D1 (SQLite) database. No framework, no build step, no dependencies. The
only scheduled job is the optional daily reminder's hourly check. It fits
comfortably in Cloudflare's free plan.

## The rules

| Rule | Value |
| --- | --- |
| Slots | 10. An 11th save is blocked until you drop one (enforced on the server). |
| Lifespan | 7 days, then the article moves to the Heap. |
| Extension | +48 hours, once per article. |
| Done | Moves it to the Vault with an optional takeaway. Frees the slot. |
| Toss | Moves it to the Heap. Frees the slot. |
| Heap | Everything tossed, dropped or expired. Purged after 30 days. No restore. |
| Vault | Done articles, plus expired ones you highlighted ("kept, unfinished"). Permanent. |

The rules are constants in [`src/rules.js`](src/rules.js). All the copy lives
in [`public/strings.js`](public/strings.js). There is no settings screen on
purpose: change a constant, redeploy.

## Set it up

You need a free Cloudflare account. There are no other accounts, keys or
services. The database is created for you on the first deploy, and the Worker
creates its own tables the first time it runs.

Pick one of these three ways.

### Option A: the Cloudflare dashboard (no terminal)

This also redeploys automatically every time `main` changes.

1. In the [Cloudflare dashboard](https://dash.cloudflare.com), go to
   **Workers & Pages → Create → Import a repository**, connect GitHub and pick
   this repository. Keep the default settings and click **Deploy**.
2. When it finishes, open the Worker's **Settings → Variables and Secrets**,
   add a **Secret** named `PASSCODE` with the passcode you want, and save.
3. Open the `*.workers.dev` address shown on the Worker's page.

### Option B: one script

With Node.js 18 or newer installed, run this from the repository folder:

```sh
./setup.sh
```

It logs you in to Cloudflare in the browser, deploys (creating the database),
and asks for the passcode. Run it again any time to redeploy.

### Option C: the Deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rohitdotonl/compost)

This copies the repository into your own GitHub account, creates the database
and asks for the passcode during setup. It suits anyone else who wants their
own Compost.

### Changing the passcode

Change the `PASSCODE` secret in the dashboard, or run
`npx wrangler secret put PASSCODE`. Each device asks for the new one on its
next open. Every API call without the right passcode gets a 401.

## Install on Android

1. Open the app's address in Chrome on your phone and enter the passcode.
2. Open Chrome's menu (⋮) and tap **Add to Home screen**, then **Install**.
3. Open Compost once from the home screen.

Compost now appears in the Android share menu. Share a link from Chrome or any
other app, pick Compost, and the Save page opens and saves it. If the share menu
shows the link only as text, Compost still finds the first URL in it.

The installed app and Chrome on Android share storage, so the passcode you
entered in step 1 carries over.

## Add the bookmarklet (desktop)

Open your Compost address with `/bookmarklet` on the end (there is also a
"Save from your browser" link at the bottom of the app). It shows a button with
your own address already filled in: drag it to your bookmarks bar.

Clicking it on any page opens the Save page in a small popup. The first time,
it asks for your passcode; after that it saves straight away.

Until you set it up, you can paste links into the **Add link** field at the top
of the Rack.

## Extension (Chrome, Edge, Brave)

The [`extension/`](extension/) folder is a Manifest V3 extension: plain files,
no build. The toolbar button saves the current tab and shows the receipt;
right-clicking a link or page saves it quietly; **Alt+Shift+S** does the same
as the button; and the icon carries a small mark when the page is already in
your rack (`•`) or Vault (`✓`). It works on pages where the bookmarklet is
blocked by a content security policy.

1. Get the folder onto your computer: clone this repository, or download it
   as a zip and unpack it. Keep the folder; Chrome loads it from where it is.
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave:
   `brave://extensions`), turn on **Developer mode** (top right), click
   **Load unpacked** and choose the `extension` folder.
3. Click the Compost icon's **Details → Extension options** (or right-click the
   icon and choose **Options**). Enter your Compost address and passcode and
   click **Save**. Chrome asks for permission to reach that address: allow it.
   The page says **Connected.** when it works.
4. Pin the icon from the puzzle-piece menu so it stays on the toolbar.

The address and passcode stay in the extension's own storage on that
computer. To change the shortcut, open `chrome://extensions/shortcuts`.

To try it without a deployed Worker: `node extension/dev/mock-server.js`
starts a stand-in API at `http://localhost:8791` with passcode `test`, and
`node extension/dev/smoke.js` loads the extension in headless Chromium and
walks through every popup state.

## Reading

Click an article's title (or press `o`) to read it in Compost: clean text in
one column, set for reading. **Open original** (Shift+O) is always at the top
for paywalls, PDFs and pages that extract badly. **Aa** holds the text size,
width, serif or sans, and light, sepia or dark; these stay on that device.
Compost remembers where you stopped and resumes there on any device. Esc
goes back to the rack.

The first time an article is opened, your browser extracts it (the Worker
only fetches the page) and stores the clean text for every device; articles
in the rack are also extracted quietly in the background while the app is
open. If a page has no readable article (a paywall, a video), Compost opens
the original instead and doesn't try again. Rack articles and their images
are kept for offline reading. An article's text is deleted when it goes to
the Heap; Vault articles keep theirs.

**Highlights.** Select text and press `h` (or the small **Highlight** button)
to mark it in a soft pencil wash. Click a highlight for **Note** (`n`),
**Star as takeaway** (`s`) or **Remove**; with text selected, `n` highlights
and opens the note at once. On wide screens your highlights sit quietly in the
right margin. Each one is stored as its exact words plus a little text either
side, so it finds its place again on any device even if the article is
extracted afresh. At **Done** (in the rack or the reader) your highlights are
listed under the takeaway field: pick one to star it and use it as the
takeaway. A starred highlight also joins the daily line.

**Highlights earn the Vault.** An article that expires with at least one
highlight goes to the Vault as "kept, unfinished" instead of the Heap, with
its text and highlights. A toss keeps highlights only through its Undo.

**Finishing.** Reach the end of a rack article having spent at least about
40% of its reading time actually reading (20 seconds when the length is
unknown) and a stamp with the date lands at the foot of the page, with the
takeaway prompt under it: Enter keeps it, Esc dismisses. Scrolling straight to
the bottom doesn't count. A thin stack of page edges at the bottom of the
screen thins as you read, with a notch for each section. When you read
without touching the mouse, everything but the text and that stack fades.
All motion is skipped under reduced motion.

Vendored, unmodified, from npm: `@mozilla/readability` **0.6.0**
(`public/vendor/Readability.js`, Apache-2.0) and `dompurify` **3.4.17**
(`public/vendor/purify.es.mjs`, Apache-2.0 or MPL-2.0). To update one,
`npm pack` the package and copy the same file over.

## Keyboard (desktop)

Press `?` for the full list. `j`/`k` move between rows, `o` or Enter opens,
`d` marks done (type the takeaway, Enter), `x` tosses (`u` undoes), `e` adds
48 hours, `c` copies the link, `1` `2` `3` set tonight, commute or weekend,
`a` jumps to Add link, `/` searches the current tab, `g` then `r` `v` `h`
switches tab. On the Vault, `e` rewrites the selected takeaway, and in the
Shelf view the arrow keys move between spines. While reading, the rack keys
rest: `h`, `n` and `s` work on highlights, Shift+O opens the original and `?`
still shows the list. Esc backs out one step (palette, shortcut list, reader
settings, takeaway prompt, reader). Shortcuts never fire while you type in a
field.

**⌘K** (Ctrl+K on Windows and Linux) opens the palette: type a few letters of
a title, site or takeaway to jump to any item, or a command name such as
"export markdown" or "toss oldest". Enter goes to the item; ⌘/Ctrl+Enter also
opens it.

Paste a link anywhere on the page (with no field focused) to save it.

The Vault search understands `site:nytimes.com`, `intent:weekend`,
`before:2026-09` and `after:2026-03` (whole months, both exclusive), plus
plain words matched against titles and takeaways. Searches are linkable:
`/#vault?q=site:nytimes.com`, and so is one article: `/#item/42`.

## The daily line

Once the Vault holds 20 takeaways, the top of the Rack shows one of them each
day, with the article it came from. **Still useful** brings it back later (1
day, then a week, a month, 3 months, 6 months); **Let it go** stops it coming
back but keeps it in the Vault. The pick is made on the first open of the day
(your local date) and stored, so every device shows the same line. Nothing is
counted. To rewrite a takeaway, click it in the Vault (or select the row and
press `e`); Enter saves, Esc cancels.

## Reading time

The reader counts seconds only while its tab is visible and you have scrolled,
moved or pressed a key in the last minute, and adds them to that day. On
Sundays the Rack shows one quiet line under the daily line: "You read for 3 h
10 min this week." (that Sunday and the six days before). On other days, or
with less than a minute read, nothing shows. There is no chart and no
comparison.

## The daily reminder

Off by default. At the bottom of the app, **Daily reminder: off · Turn on**
asks the browser for permission to notify, then for an hour (8:00 unless you
pick another). From then on, on any day something in your rack expires within
24 hours, you get one notification at that hour: "Two articles leave your rack
tomorrow." Nothing on other days, never more than one a day. Clicking it opens
the rack. **Change** picks another hour; **Turn off** stops it on that device.
Turn it on on each device you want it on; the hour is shared.

There is nothing to configure. The Worker makes its own push signing key
(VAPID) the first time it needs one and keeps it in the database. The
`[triggers]` block in `wrangler.toml` runs the Worker once an hour, which
Cloudflare's free plan allows (a handful of Cron Triggers per account; this is
24 runs a day). `setup.sh`, the Deploy button and `wrangler deploy` all pick it
up.

Where it arrives: on Android, install the app (see above) and notifications
arrive like any app's. On a desktop, Chrome and Edge show them only while the
browser is running; a reminder sent while it was closed waits up to 12 hours.
iPhone is not supported. Your time zone is taken from the device
when you turn the reminder on, and updated whenever the app is opened.

The push itself carries no data. The service worker wakes up, asks
`GET /api/digest` for the words and shows them; for that it keeps a copy of the
passcode in the browser's Cache Storage (`compost-push`) on devices with the
reminder on.

## Rich rows and the image proxy

On save the Worker reads the page's `og:` and `twitter:` tags for a
description and preview image, `<link rel="icon">` (or `/favicon.ico`) for the
favicon, `meta author` / `article:author` when it is a name, and
`<html lang>`. Migration `0002` adds the columns `description`, `image_url`,
`favicon_url`, `author`, `lang` and `note` to `items`. A row that came in bare
has a **Refresh details** action.

Images and favicons are never loaded from the article's site directly: rows
point at `/img?u=<address>`, which fetches the image (http(s) only, `image/*`
only, up to 2 MB, 5 s timeout) and keeps it in the Workers Cache for 7 days.
Failures answer 404 and the row shows the site's initial on a tinted tile.
Since an `<img>` can't send the passcode header, every successful API call
sets an `HttpOnly`, `SameSite=Strict` cookie scoped to `/img` holding the
SHA-256 of the passcode; `/img` needs it. Changing the passcode invalidates it
on the next API call. Nothing to set up.

## Backups

D1 keeps 7 days of point-in-time recovery on the free plan
(`npx wrangler d1 time-travel --help`). Note that `wrangler d1 export` refuses
databases with virtual tables, which the full-text index (`search`, FTS5) is;
Time Travel and the exports are unaffected. The **Export** links at the bottom of
the Vault tab (or the palette) save the Vault as Markdown, everything as JSON,
or the Vault as a zip of Obsidian notes, one per article with its URL, site,
dates and intent in the frontmatter. Exports include each Vault article's
highlights and notes (★ marks the takeaway).

## Is it working?

The `items` table records when each article was saved, how it ended and whether
it was extended. For the last 30 days:

```sh
npx wrangler d1 execute compost --remote --command "
  SELECT COUNT(*)                                AS saved,
         SUM(outcome = 'done')                   AS finished,
         SUM(outcome = 'kept')                   AS kept_unfinished,
         SUM(outcome = 'expired')                AS expired,
         SUM(outcome IN ('tossed', 'dropped'))   AS let_go,
         SUM(outcome IS NULL)                    AS still_in_rack,
         SUM(extended)                           AS extended
  FROM items
  WHERE saved_at > (strftime('%s', 'now', '-30 days') * 1000)"
```

Heap rows are deleted after 30 days, so look at a window of 30 days or less
(older Vault rows are all still there, but their tossed and expired
counterparts are not).

## Run it locally

```sh
echo 'PASSCODE=letmein' > .dev.vars
npx wrangler dev
```

Then open http://localhost:8787. `.dev.vars` is git-ignored.

The tests need nothing installed beyond Node 22:

```sh
npm test
```

They run the real Worker code (`src/worker.js` and everything under it)
against an in-memory SQLite database through a small D1-shaped adapter
(`tests/d1.js`), with the clock injected, so expiry and the Heap purge are
checked without waiting. Page parsing uses the HTML in `tests/fixtures/`.

Some quick API checks with curl:

```sh
P='X-Passcode: letmein'
curl -i localhost:8787/api/items                                   # 401
curl -s -H "$P" localhost:8787/api/items                           # rack, vault, heap
curl -s -H "$P" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}' localhost:8787/api/items      # save
curl -s -H "$P" -X POST localhost:8787/api/items/1/extend          # +48h, once
curl -s -H "$P" -H 'Content-Type: application/json' \
  -d '{"takeaway":"One line"}' localhost:8787/api/items/1/done     # to the Vault
```

## Migrations

The schema lives in `migrations/` as numbered SQL files. On its first API call
after a deploy, the Worker checks which numbers the `meta` table records
(`migration:N`) and applies every file not yet recorded, in order, each as one
`db.batch` (a transaction) that also records its number. A lower number that
lands after a higher one still runs. Nothing to run by hand: `setup.sh`, the Deploy
button and `wrangler deploy` all stay one step. A database created by V1 is
picked up as it is, since `0001_init.sql` only creates what is missing.

To add a column: drop `migrations/0002_whatever.sql` in the folder, add one
line for it to the list in `src/migrations.js`, deploy. Numbers only go up;
gaps are fine. One statement per `;` (a `CREATE TRIGGER … BEGIN … END;` body
stays whole).

## API

Every call needs the `X-Passcode` header and starts with the sweep: rack items
past their expiry move to the Heap (or to the Vault as `kept` when they have a
highlight), and Heap items older than 30 days are deleted. That is how expiry
works without a scheduled job (the reminder's hourly run sweeps too, before it
counts).

| Method and path | Does |
| --- | --- |
| `GET /api/items` | Returns `rack` (expiring soonest first), `vault` and `heap`; rack and Vault rows carry a `highlights` count |
| `POST /api/items` | Saves `{url, dropId?, title?, note?}`. `409` with the rack list when full and no `dropId`. For a URL already in the rack, a `note` sets that item's note (answer stays `in_rack`) |
| `GET /api/lookup?url=…` | `{status: 'in_rack' | 'in_vault' | 'new', id?}` for the browser extension |
| `POST /api/items/:id/intent` | Sets `{intent}`: `tonight`, `commute`, `weekend` or `null` |
| `POST /api/items/:id/done` | Moves to the Vault with `{takeaway?}` |
| `POST /api/items/:id/toss` | Moves to the Heap |
| `POST /api/items/:id/untoss` | Reverses a toss, only within 10 seconds of it and only while a slot is free (the Undo; not a Heap restore) |
| `POST /api/items/:id/extend` | Adds 48 hours, once |
| `GET /api/items/:id/raw` | `{url, html}`: the page's raw HTML (5s, 3MB cap) and its address after redirects, for extraction in the browser. `422` when it can't be fetched |
| `GET /api/items/:id/content` | `{status, html, words, excerpt, byline, extracted_at, progress, last_read_at, minutes}`. `status` is `ok`, `failed` or `none` (not extracted yet) |
| `POST /api/items/:id/content` | Stores `{html, text, words, excerpt, byline}` and sets the reading time from `words`, or `{status: 'failed'}` |
| `POST /api/items/:id/progress` | Stores `{progress}` (0–1) and the time, and adds `seconds` (at most 120 per call) to the reading time of `day` (the device's local `YYYY-MM-DD`; the UTC date without it) |
| `GET /api/contents` | `{contents: [{id, status, words}]}` for the rack, for background extraction |
| `GET /api/search?q=…` | `{results: [{id, in: 'rack' \| 'vault', snippet}]}`: full-text search over titles, article text and takeaways; `snippet` is escaped HTML with `<mark>` |
| `GET /api/daily?day=YYYY-MM-DD` | The day's line `{day, review}` (`review` is `null` with fewer than 20 takeaways); pinned per date |
| `POST /api/reviews/:id` | `{answer}`: `keep` ("Still useful") or `retire` ("Let it go") |
| `POST /api/items/:id/takeaway` | Rewrites a Vault item's `{takeaway}` |
| `GET /api/items/:id/related` | Up to 3 Vault items from the same site or sharing words with it |
| `GET /api/weekly?day=YYYY-MM-DD` | `{show, seconds}`: `show` only on a Sunday with at least 60 seconds read that day and the six before |
| `GET /api/push/key` | `{key}`: the VAPID public key (base64url, uncompressed point) for `pushManager.subscribe` |
| `POST /api/push/subscribe` | `{subscription, hour, tzOffset}` (`tzOffset` = minutes to add to UTC): stores the browser's subscription and turns the reminder on; also changes the hour |
| `POST /api/push/unsubscribe` | `{endpoint}`: forgets that browser; with none left, the reminder is off |
| `GET /api/push/status?endpoint=…` | `{enabled, hour, tzOffset, subscribed}` |
| `GET /api/digest` | `{text, count}`: the rack items expiring within 24 hours and the notification's words (`text` is `null` with none) |
| `POST /api/items/:id/note` | Sets `{note}` (up to 200 characters; empty clears it) on a rack item |
| `GET /api/items/:id/highlights` | `{highlights: [{id, item_id, quote, prefix, suffix, note, starred, created_at}]}` for a rack or Vault item |
| `POST /api/items/:id/highlights` | Adds `{quote, prefix, suffix, note?}`; answers `201 {highlight, count}` |
| `POST /api/highlights/:id` | Sets `{note?, starred?}`; starring one clears the star on the article's others |
| `POST /api/highlights/:id/delete` | Removes it; answers `{ok, count}` |
| `GET /api/highlights` | Every Vault highlight, for the exports |
| `POST /api/items/:id/refresh` | Fetches the page again for its details; what it can't find keeps its old value |
| `GET /img?u=…` | The image proxy (see "Rich rows and the image proxy"). Not under `/api/` and needs no header |

A save answers with `status`: `saved`, `in_rack`, `in_vault`, `full` or
`invalid_url`. URLs are normalised before comparing (tracking parameters such as
`utm_*` and `fbclid` and the `#fragment` are removed). Every action answers
with `{ok, item, used, limit}`: the item as it now is and the slot count, so
the app updates one row instead of refetching the list.

## Files

| File | Purpose |
| --- | --- |
| `wrangler.toml` | Worker config: static assets folder, the D1 binding and the hourly Cron Trigger |
| `migrations/NNNN_*.sql` | Numbered schema migrations; the Worker applies them itself (see "Migrations") |
| `src/worker.js` | Entry: passcode check and the routing table |
| `src/rules.js` | The rules as constants |
| `src/items.js` | Rack, Vault and Heap routes: list, save, lookup and the actions |
| `src/review.js` | The daily line, spaced review, takeaway edits and related Vault items |
| `src/highlights.js` | Highlight routes: list, create, note, star (one per article), delete, and the Vault's for exports |
| `src/push.js`, `src/vapid.js` | The daily reminder: subscriptions, the digest, the hourly run and VAPID signing with WebCrypto |
| `src/weekly.js` | Reading time per day and the Sunday line |
| `src/db.js` | Runs the migrations once per Worker instance, and the expiry sweep |
| `src/migrations.js` | The list of migration files, in order |
| `src/page.js` | URL normalising, fetching a page for its title, description, image, favicon, author, language and reading time, and the raw HTML for the reader |
| `src/img.js` | The image proxy (`/img?u=…`) behind its cookie |
| `src/reader.js` | Reader routes: raw page, stored article, progress, full-text search |
| `src/http.js` | JSON responses, body reading, passcode comparison |
| `public/index.html`, `app.js`, `style.css` | Main page shell: header, tabs, status line |
| `public/store.js` | State, localStorage cache, optimistic actions, row selection |
| `public/rack.js`, `vault.js`, `heap.js` | One module per tab |
| `public/daily.js`, `daily.css` | The daily line at the top of the Rack, and the Sunday reading-time line beneath it |
| `public/notify.js`, `notify.css` | The daily reminder's footer line |
| `public/format.js` | Time left in words, the expiry fade, image addresses and the row thumbnail |
| `public/fonts/` | Self-hosted Literata (titles, takeaways) and IBM Plex Sans (everything else), latin woff2, SIL OFL |
| `public/keys.js` | Keyboard shortcuts, paste-to-save and the `#vault?q=…` / `#item/42` links |
| `public/palette.js`, `palette.css` | The ⌘K command palette and the shortcut sheet |
| `public/shelf.js`, `shelf.css` | The Vault's Shelf view: one shelf per month, a spine per article (List / Shelf toggle beside the search, remembered per device) |
| `public/search.js` | Vault search (`site:`, `intent:`, `before:`, `after:`) shared with the palette |
| `public/reader.js`, `reader.css` | The reader at `#read/42`: settings, progress, background extraction, offline copies |
| `public/extract.js` | Readability + DOMPurify extraction in the browser, images through `/img` |
| `public/highlights.js`, `highlights.css` | Highlights in the reader: the text-quote anchoring, the popover, the margin list, and highlight choices under Done |
| `public/finish.js`, `finish.css` | Finish detection, the stamp, and the page stack at the foot of the reader |
| `public/vendor/` | Readability.js and DOMPurify, vendored as single files with their licences (versions under "Reading") |
| `public/export.js`, `zip.js` | Markdown, JSON and Obsidian zip exports, built in the browser |
| `public/save.html`, `save.js` | Save page used by the share menu and the bookmarklet |
| `public/api.js` | The passcode and API helper both pages share |
| `public/bookmarklet.html`, `bookmarklet.js` | Shows the bookmarklet with your address filled in |
| `setup.sh` | Logs in, deploys and sets the passcode in one go |
| `.dev.vars.example` | Tells the Deploy button to ask for `PASSCODE` |
| `public/strings.js` | All user-facing copy |
| `public/manifest.webmanifest`, `sw.js`, `icons/` | PWA install and the Android share target |
| `tests/` | `node --test` suite with a D1-shaped adapter over `node:sqlite` |
| `extension/` | The Chrome extension (see "Extension"); `extension/dev/` holds a mock API and a smoke test |
