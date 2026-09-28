# desk

Personal homepage running as a Cloudflare Worker at https://desk.ersatzben.com (also desk.lightnotes.workers.dev):
to-dos, links, GitHub repos, and a rain outlook on one page.

- `public/index.html`, `app.js`, `app.css` — the page. Links are plain HTML.
- `public/store.js` — to-do storage (browser `localStorage`, key `desk:tasks`).
  Everything goes through this module, so a sync backend can replace it later.
- `src/index.js` — Worker: passphrase login (signed session cookie), GitHub repo
  list with a 5-minute KV cache, and repo stars (`pins` in KV).
- `src/tasks.js` — read-only `/api/tasks`, used once to import to-dos from the
  old KV-backed site into `localStorage`. Safe to delete once imported.

To-dos and the rain chart (Open-Meteo, 15-minute steps over 12 hours, fetched by
the browser) work without logging in; repos need the passphrase.

## Secrets

Set with `npx wrangler secret put <NAME>`:

- `PASSPHRASE` — site login
- `GITHUB_TOKEN` — fine-grained PAT, all repos, Metadata read (Pages read for custom-domain links)
- `SESSION_SECRET` — random string for signing session cookies

## Develop & deploy

```sh
npm install
npm run dev     # local, uses .dev.vars
npm test        # isolated workerd/KV tests
npm run build   # deploy dry run
npm run deploy
```
