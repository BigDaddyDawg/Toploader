# Daily floor lookup (GitHub Pages)

Read-only snapshot of today's card-show floors for use on your phone while out.

## Morning workflow (laptop)

```powershell
cd "C:\path\to\pokemon-tcg-terminal"
.\.venv\Scripts\python.exe scripts\batch_card_lists.py --no-skip --local-only --no-floor-review --workers 2 --export-static
```

This updates `docs/floors.json` and leaves the full database on the laptop.

## Publish to GitHub Pages

1. In the repo on GitHub: **Settings → Pages → Build from branch → `main` → `/docs`**.
2. After the batch finishes, publish the snapshot:

```powershell
.\scripts\publish_daily_floors.ps1
```

Or commit manually:

```powershell
git add docs/floors.json docs/index.html
git commit -m "Daily floor snapshot"
git push
```

Your site URL will be something like:

`https://<username>.github.io/<repo-name>/`

Open it on your phone and bookmark it. The page caches `floors.json` in the browser for poor signal.

## Wishlist

Share this URL with family and friends:

`https://bigdaddydawg.github.io/Toploader/wishlist.html`

The wishlist page shows watched exported cards and their `target_buy_gbp` price. The saved morning batch cards are watched by default, and you can toggle cards on/off in the app. It sorts cheapest first by default, with filters for set and price order.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Mobile search/filter UI |
| `wishlist.html` | Shareable wishlist for active cards and target prices |
| `floors.json` | Exported from `ui_batch_card_results` |

No scraping runs on the phone — only this JSON is served.
