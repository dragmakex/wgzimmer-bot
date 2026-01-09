# wgzimmer-bot

Playwright-based scraper that searches `https://www.wgzimmer.ch/wgzimmer/search/room.html` for a configured address, notifies Telegram about new results, and remembers which listings were already sent in `data/sent.json`.

## Running locally

1. Install Bun (https://bun.sh).
2. Install deps: `bun install`. First run also: `bunx playwright install chromium` to fetch the browser.
3. Run: `bun run start`.
4. Set environment variables (treat them as secrets). The app auto-loads a `.env` in the repo root, so you can `cp .env.example .env` and fill in:
   - `TG_BOT_TOKEN`
   - `TG_CHAT_ID`
   - `SEARCH_QUERY` (e.g. `culmannstrasse 26`)
   - optional: `HEADLESS=false` to watch the browser when debugging locally
   - optional: `USER_DATA_DIR=./.playwright-profile` to reuse a persistent browser profile

The bot:
- opens the search page, accepts the cookie banner if present, waits for Recaptcha to be ready,
- fills `SEARCH_QUERY`, clicks **Suchen**, calls `submitForm()` as a backup, waits for navigation/results,
- extracts listing links (ids come from `/wglink/.../<id>/...` in the href),
- sends a Telegram message for unseen ids,
- updates `data/sent.json` so we don't notify twice (only stores listing ids, no secrets).

## GitHub Actions
`./github/workflows/daily.yml` runs daily and on manual dispatch. It sets up Bun, installs Playwright (Chromium bundled), runs the bot, and pushes `data/sent.json` back to the repo when new ids are recorded. Set repository secrets:

- `TG_BOT_TOKEN`
- `TG_CHAT_ID`
- `SEARCH_QUERY`
