# AEO Scanner

Can ChatGPT, Claude, Perplexity and Gemini find, read and quote a page? Enter a URL and get an answer-engine readiness report.

Live: https://granqvistsanna-web.github.io/aeo-scanner/ · Part of the [Toolbox](https://granqvistsanna-web.github.io/).

## What it checks

| Category | Checks |
| --- | --- |
| Crawler access | HTTP status, HTTPS, noindex, robots.txt rules for 11 AI crawlers, llms.txt, sitemap, text in raw HTML, response time |
| Metadata | Title, meta description, canonical, `lang`, Open Graph, publish/update date |
| Content structure | One H1, heading outline, question headings, answer-first intro, lists/tables, landmarks, alt text |
| Schema & authority | JSON-LD, Organization + `sameAs`, page type, author, FAQPage, internal/external links, concrete figures |

Each check is weighted. Pass counts fully, "improve" counts half. A page that returns an error or is `noindex` is capped at 25.

## How it's built

- `index.html`: the whole frontend. Static, on GitHub Pages, styled with [Pumice](https://granqvistsanna-web.github.io/pumice/).
- `worker/`: a Cloudflare Worker that fetches the page, `robots.txt`, `llms.txt` and the sitemap (browsers can't, because of CORS), then runs the analysis. Blocks private hosts, caps responses at 3 MB, times out after 10 s and caches results for 10 minutes.
- `worker/src/analyze.js`: the checks, as pure functions with no I/O.

## Develop

```bash
node scripts/scan.mjs example.com          # scan from the terminal, no Worker
npx wrangler dev --config worker/wrangler.toml   # Worker on :8787
npx serve -l 5178 .                         # page on :5178, talks to :8787
```

## Deploy

```bash
cd worker && npx wrangler deploy
```

The live Worker is https://aeo-scanner.granqvistsanna.workers.dev (set as `API` in `index.html`). You can also pass `?api=https://…` to test against a different Worker.
