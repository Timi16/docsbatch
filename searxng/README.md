# SearXNG for DocBatch

A private search server for DocBatch's web search. It is free to run (you only pay for the server), and it is the
only search DocBatch uses: no paid search service is involved.

## Deploy on your server

Requires Docker with the compose plugin.

1. Copy this `searxng/` folder to the server.
2. Create `.env` from `.env.example`:
   - `SEARXNG_HOSTNAME`: the domain you will serve it on, e.g. `search.yourdomain.com`
   - `SEARXNG_SECRET`: output of `openssl rand -hex 32`
3. Start it: `docker compose up -d`. SearXNG now listens on `127.0.0.1:8080`, reachable only from the server itself.
4. Pick a search key, a second random value (`openssl rand -hex 32`). Your reverse proxy only lets through requests
   that send it, so strangers cannot use your server.
5. Put a reverse proxy in front with HTTPS:
   - **Caddy:** see `Caddyfile.example` (replace the domain; start Caddy with `SEARCH_KEY` set to your key).
   - **nginx:** see `nginx.conf.example` (replace the domain and key; get a certificate with
     `certbot --nginx -d search.yourdomain.com`).
6. In Vercel → Settings → Environment Variables, add:
   - `SEARXNG_URL` = `https://search.yourdomain.com`
   - `SEARXNG_KEY` = your search key
   Then redeploy.

## Check it works

```sh
# From anywhere: should return JSON with results
curl -H "X-Search-Key: YOUR-KEY" "https://search.yourdomain.com/search?q=Superfeet+CEO&format=json"

# Without the key: should return 403 Forbidden
curl -i "https://search.yourdomain.com/search?q=test&format=json"

# On the server: which engines failed and why
curl -s "http://127.0.0.1:8080/search?q=Superfeet+CEO&format=json" | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['unresponsive_engines'])"
```

## What to expect

SearXNG has no index of its own: each search asks Google, Bing, DuckDuckGo, Brave, Qwant and Yahoo for their results.
Those sites block automated searches, especially from servers. In a local test (October 2026) on a home connection:

- Google answered "access denied", DuckDuckGo and Qwant showed CAPTCHAs, and Brave rate-limited after a few searches.
- **Yahoo kept answering**, with good results: 11 of 12 lead searches found relevant pages.

So results depend on which engines your server's IP is allowed to use, and that changes over time. When SearXNG
finds nothing for a lead, the model marks it unverified (REVIEW) rather than guessing. The app sends at most two
searches at a time to avoid bursts. If an engine you rely on is blocked, check the command above, and edit the engine list in
`config/settings.yml` (then `docker compose restart`).

Updating: `docker compose pull && docker compose up -d`.
