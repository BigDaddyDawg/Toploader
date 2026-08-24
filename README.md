# Chase (GitHub Pages)

Phone app for today’s buy checks and wishlist tracking at Pokemon TCG card shows.

## URLs

| View | URL |
|------|-----|
| Home | https://bigdaddydawg.github.io/Toploader/ |
| Today’s buy list | https://bigdaddydawg.github.io/Toploader/#buy-list |
| Floor checker | https://bigdaddydawg.github.io/Toploader/#floors |
| Wishlist (share with family) | https://bigdaddydawg.github.io/Toploader/#wishlist |
| Helper mode | https://bigdaddydawg.github.io/Toploader/#helper |

Old bookmarks to `wishlist.html` redirect to `#wishlist`.

## How it works

The phone app is the product. Tap a card to check the live max buy, then hit **Purchased** when you buy it. Add sets from the phone. Prices update on the phone over live sync — you do not run a laptop batch to use the app.

A background worker (GitHub Actions) scrapes solds and writes prices into Supabase. The phone reads those live numbers. `floors.json` is a cache for poor signal.

## What each tab shows

- **Today’s buy list** — cards most worth checking now, ranked by buy signal.
- **Floor checker** — deeper price check against floor and max buy.
- **Wishlist** — cards you want. Tap to check price. Name, set, number, and max buy.
- **Helper mode** — simplified cards for non-collectors.
- **Add set** — type a set name or paste a TCGPlayer link; picked cards go on the wishlist.

## Live sync (Supabase)

Purchased cards drop off Wishlist/Today for everyone within seconds.

One-time setup: see **[SUPABASE_SETUP.md](./SUPABASE_SETUP.md)**.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Single-page phone UI |
| `wishlist.html` | Redirect to `#wishlist` for old links |
| `buy-list.html` | Redirect to `#buy-list` |
| `helper.html` | Redirect to `#helper` |
| `floors.json` | Cached snapshot (live prices come from Supabase) |
| `show-sync.js` | Supabase live sync, purchased, and price-check queue |
| `supabase-config.js` | Supabase project URL + anon key |
| `manifest.webmanifest`, `service-worker.js`, `icon.svg` | Installable/offline shell |

Scraping does not run in the phone browser. The background worker does that; the phone shows the result.
