# Berkeley Day Board

A centralized view of all UC Berkeley campus events for any given day, with direct RSVP links.

**How it works:** Berkeley's official calendar (events.berkeley.edu) aggregates every institute and department calendar on campus. A small script (`scraper.js`) pulls the next ~60 days of events from its JSON data feed once a day (via GitHub Actions), saves them to `site/events.json`, and Netlify serves the website that displays them.

```
GitHub Actions (daily, free)  →  scraper.js  →  site/events.json  →  Netlify site
```

## Files

| File | What it does |
|---|---|
| `scraper.js` | Fetches events from the Berkeley calendar API, writes `site/events.json` |
| `.github/workflows/update-events.yml` | Runs the scraper daily at 5:00 PM IST and commits fresh data |
| `site/index.html` | The website (day / week / month views, search, filters, PT/IST toggle) |
| `site/events.json` | The event data (auto-generated — don't edit by hand) |

## Setup (one time, ~15 minutes)

### 1. Put the code on GitHub
1. Go to github.com → **New repository** → name it `berkeley-events` → Public → Create.
2. Click **uploading an existing file** and drag in all the files/folders from this project (keep the folder structure — `.github/workflows/` matters).
3. Commit.

### 2. Run the data fetch once
1. In the repo, open the **Actions** tab. If prompted, click **"I understand my workflows, enable them"**.
2. Click **Update Berkeley events** (left sidebar) → **Run workflow** → Run.
3. Wait ~1 minute. A green check means it worked and `site/events.json` now exists. A red X means the calendar API didn't respond as expected — open the run, read the log, and share it with Claude to fix.

### 3. Deploy on Netlify
1. In Netlify: **Add new site → Import an existing project → GitHub** → pick `berkeley-events`.
2. Set **Publish directory** to `site`. Leave build command empty.
3. Deploy. Your site is live at the Netlify URL.

That's it. Every day at 5:00 PM IST the Action fetches fresh data, commits it, and Netlify automatically redeploys within a minute or two.

## Notes
- **Manual refresh anytime:** Actions tab → Update Berkeley events → Run workflow.
- **Free-tier limits:** GitHub Actions gives public repos unlimited free minutes; this uses ~1 minute/day. Netlify free tier is far more than enough for a static site.
- **RSVP links:** Each event links to its official page (which has the RSVP/register button). When the data includes a direct registration link, the button goes straight there and shows in gold.
- **Timezones:** Events are grouped by campus day (Pacific Time). The PT/IST toggle changes displayed times only.
