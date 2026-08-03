# Toploader (GitHub Pages)

Read-only phone homepage for today's Toploader snapshot: landing page, floor checker, and shareable wishlist in one static app.

## URLs

| View | URL |
|------|-----|
| Home | https://bigdaddydawg.github.io/Toploader/ |
| Today’s buy list | https://bigdaddydawg.github.io/Toploader/#buy-list |
| Floor checker | https://bigdaddydawg.github.io/Toploader/#floors |
| Wishlist (share with family) | https://bigdaddydawg.github.io/Toploader/#wishlist |
| Helper mode | https://bigdaddydawg.github.io/Toploader/#helper |

Old bookmarks to `wishlist.html` redirect to `#wishlist`.

## Morning workflow (laptop)

```powershell
cd "C:\path\to\pokemon-tcg-terminal"
.\.venv\Scripts\python.exe scripts\batch_card_lists.py --no-skip --local-only --no-floor-review --workers 2 --export-static
.\scripts\publish_daily_floors.ps1
```

The batch updates `docs/floors.json` and `docs/index.html` stays in the app repo; publish copies them to the public **Toploader** repo.

Owned / purchased cards sync live via the **Family Vault** Supabase hub (`toploader_owned_cards`), not the old paused `toploader-show` project.

## GitHub Pages setup

In the public **Toploader** repo: **Settings → Pages → Build from branch → `main` → `/` (root)**.

## What each tab shows

- **Home** — quick summary and big buttons into the card-show tools.
- **Today’s buy list** — cards most worth checking now, ranked by buy signal and confidence.
- **Floor checker** — all active exported cards with floor, target buy, quality flags, and notes.
- **Wishlist** — only cards with `watchlist_status` in the app (morning batch cards are seeded on batch run). Name, set, number, and target price only. Sort by cheapest, expensive, or set.
- **Helper mode** — simplified wishlist cards for non-collectors: image toggle, exact card number, max pay, and skip rules.

Use the static display controls to switch between compact/detail cards and image thumbnails. Images are lazy-loaded from catalog URLs when present; they are not stored in the static JSON as binary data.

Toggle wishlist membership in the Toploader app; re-export and publish to update the public site.

## Live “Got it” sync (Supabase)

During a card show, anyone on the wishlist can tap **Got it ✓** and everyone else sees the update within seconds — no laptop export needed mid-show.

One-time setup: see **[SUPABASE_SETUP.md](./SUPABASE_SETUP.md)**.

- Marks are scoped to the snapshot `local_date` (today’s show).
- Got cards are hidden by default; toggle **Show got cards** on the wishlist tab.
- Buy list also excludes got cards so you do not double-buy.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Single-page UI (home + floors + wishlist tabs, hash routing) |
| `wishlist.html` | Redirect to `#wishlist` for old links |
| `buy-list.html` | Redirect to `#buy-list` |
| `helper.html` | Redirect to `#helper` |
| `floors.json` | Exported from `ui_batch_card_results` |
| `show-sync.js` | Supabase live sync for “got it” marks |
| `supabase-config.js` | Your Supabase project URL + anon key |
| `manifest.webmanifest`, `service-worker.js`, `icon.svg` | Installable/offline shell for the static app |

No scraping runs on the phone — only this JSON is served. The page caches `floors.json` in the browser for poor signal.
