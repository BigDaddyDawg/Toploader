# Toploader (GitHub Pages)

Read-only phone homepage for today's Toploader snapshot: landing page, floor checker, and shareable wishlist in one static app.

## URLs

| View | URL |
|------|-----|
| Home | https://bigdaddydawg.github.io/Toploader/ |
| Floor checker | https://bigdaddydawg.github.io/Toploader/#floors |
| Wishlist (share with family) | https://bigdaddydawg.github.io/Toploader/#wishlist |

Old bookmarks to `wishlist.html` redirect to `#wishlist`.

## Morning workflow (laptop)

```powershell
cd "C:\path\to\pokemon-tcg-terminal"
.\.venv\Scripts\python.exe scripts\batch_card_lists.py --no-skip --local-only --no-floor-review --workers 2 --export-static
.\scripts\publish_daily_floors.ps1
```

The batch updates `docs/floors.json` and `docs/index.html` stays in the app repo; publish copies them to the public **Toploader** repo.

## GitHub Pages setup

In the public **Toploader** repo: **Settings → Pages → Build from branch → `main` → `/` (root)**.

## What each tab shows

- **Home** — quick summary and big buttons into the card-show tools.
- **Floor checker** — all active exported cards with floor, target buy, quality flags, and notes.
- **Wishlist** — only cards with `watchlist_status` in the app (morning batch cards are seeded on batch run). Name, set, number, and target price only. Sort by cheapest, expensive, or set.

Toggle wishlist membership in the Toploader app; re-export and publish to update the public site.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Single-page UI (home + floors + wishlist tabs, hash routing) |
| `wishlist.html` | Redirect to `#wishlist` for old links |
| `floors.json` | Exported from `ui_batch_card_results` |

No scraping runs on the phone — only this JSON is served. The page caches `floors.json` in the browser for poor signal.
