# AGENTS.md

Printable bird bingo cards for a Dutch postcode and month (vogelbingo.nl). Static site on
GitHub Pages: plain ES modules, no bundler, no runtime dependencies. A Node build script
turns a GBIF export into committed JSON under `data/`; the browser only looks it up.
Design and rationale: [docs/PLAN.md](docs/PLAN.md). Read its "Settled decisions" before
proposing architectural changes.

## Commands

```bash
npm test                # node --test (Node ≥ 20; CI uses 22)
npm run check:manifest  # validate data/birds.json; CI runs this too
npm run serve           # localhost:8000 (file:// fails because the page fetches data/)
npm run golden          # regenerate the golden card fixture after a data or algorithm change
```

## Things that aren't obvious from the code

- Cards must be reproducible. `src/card.js` is seeded from `v1|cell|month|tier`, and
  printed cards and deep links depend on that. No `Math.random`/`Date` there; bump
  `ALGORITHM_VERSION` if selection changes.
- `data/grid.json` stores positions in `data/birds.json`. Only append species; reordering
  or removing one silently changes every card.
- `src/card.js` and `src/render.js` must stay DOM-free, because the tests import them in
  Node. `render.js` output goes into `innerHTML`, so pass every value through `escapeHtml`.
- User-facing text is Dutch; code, comments and commits are English.
- The README "Status" table is stale: `data/grid.json` is built from GBIF, not the seed.

## Boundaries

- **Always:** run `npm test` and `npm run check:manifest` before calling a change done.
- **Ask first:** adding a dependency (only `proj4`, dev-only, is allowed today),
  regenerating the golden fixture (a failing golden test usually means a real
  regression), and anything touching Stage 2 (payments, Worker), which isn't built yet.
- **Never:**
  - hand-edit `data/grid.json` or `data/postcodes.json`, which are generated
  - loosen the build guards (≥ 24 species per cell-month, `grid.json` < 4 MB)
  - overwrite the GBIF grid with a no-argument (seed) build
  - make the browser call a third-party API
  - use non-CC0/CC BY data or non-public-domain plates
  - commit `.env`, `.cache/` or the PC4 GeoPackage

Rebuilding the dataset and adding plates are described in [README.md](README.md). The
full GBIF build needs credentials and multi-GB inputs, which agents normally don't have.
