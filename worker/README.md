# Telemetry Worker

The Cloudflare Worker behind `https://telemetry.deckosaurus.com` — Deckosaurus feature 567.
`src/index.js` is the whole thing; `wrangler.toml` binds it to the Analytics Engine dataset
`deckosaurus_telemetry` and to the custom domain. What it accepts, and what it never touches, is
in the header comment of `src/index.js`; the user-facing statement is `../privacy.html`.

```
wrangler deploy --config worker/wrangler.toml      # from a Mac with `wrangler login`
worker/probe.sh                                    # 204s and 400s against the live URL
wrangler dev --config worker/wrangler.toml         # local; then worker/probe.sh http://localhost:8787
```
