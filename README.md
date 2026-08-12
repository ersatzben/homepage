# desk

Personal homepage: repo ledger + to-do pad, running as a Cloudflare Worker at
https://desk.lightnotes.workers.dev.

- `public/` — static frontend (light "paper ledger" design)
- `src/index.js` — Worker: passphrase login (signed session cookie), GitHub
  proxy with 5-minute KV cache and README previews, KV-backed to-dos and pins
- `wrangler.jsonc` — Worker config (assets + `DESK_STORE` KV namespace)

## Secrets

Set with `npx wrangler secret put <NAME>`:

- `PASSPHRASE` — site login
- `GITHUB_TOKEN` — fine-grained PAT, all repos, Contents: read-only
- `SESSION_SECRET` — random string for signing session cookies

## Develop & deploy

```sh
npm install
npm run dev     # local, uses .dev.vars (PASSPHRASE=local-dev-pass)
npm run deploy
```
