# Vogelbingo — Implementation Plan

Produced by `/plan-ceo-review` (with `/office-hours`) on 2026-09-02.
Eng, design and DX review passes run 2026-09-17 (see the review report at the bottom).
Design doc: `~/.gstack/projects/lennartvandeguchte-vogelbingo/lennart-claude-vogelbingo-plan-review-137adb-design-20260902-210608.md`
(on the owner's laptop, not in this repo — this plan is the source of truth).

---

## Context

The repo currently holds a placeholder [index.html](index.html): a title and a looping
`bingomolen.mp4` "work in progress" video. The earlier 5x5 emoji bingo grid it replaced
had three animals that are not birds, three species that do not occur wild in the
Netherlands, and six duplicated emoji. Neither version is the product.

The goal is to replace it with a generator that produces a **printable bingo card for
a specific Dutch location and month**, containing only birds that are actually there
at that time, illustrated with images that look like the real bird. A paid tier sells
multi-card sets for group play.

Nobody else does location-and-season awareness. BingoBaker, Canva and
myfreebingocards all make you supply the bird list yourself. Bird Watcher's Digest has
five hardcoded US regions. That gap is the entire product.

**Mode:** SELECTIVE EXPANSION. Approach C (static frontend + edge worker), built by
passing through B (static, free).

---

## Settled decisions

| # | Decision | Why |
|---|---|---|
| 1 | Print-first, not a web game | The card lives in a coat pocket. No signal needed in the duinen. |
| 2 | GBIF, not waarneming.nl | waarneming.nl's API is closed; its GBIF mirror is CC BY-NC, unusable in a paid product. |
| 3 | Public-domain 18th/19th-c. plates, curated into a repo manifest | Legible at 3.5cm where photos fail; no licence obligations; no runtime image API. |
| 4 | Deterministic free card, paid multi-card packs | Chosen by the owner after the failure mode was flagged. See "Paid tier" below. |
| 5 | Difficulty tiers (makkelijk / normaal / expert) | The only mechanism giving anyone a reason to generate a second card. |
| 6 | One GBIF Occurrence Download, not ~6,000 API queries | One reproducible request with a citable DOI, against a throttled endpoint. |
| 7 | One dataset bundle, not per-cell files | ~500 cells x 12 months is <1MB gzipped. 6,000 files in git buys nothing. |
| 8 | `@media print` + `window.print()`, not a PDF library | Zero deps, better typography, crisper images. Real PDF export is a later upgrade. |
| 9 | Bundled postcode table, not a map | A map means third-party tile hosting, the exact runtime dependency this design rejects everywhere else. |
| 10 | The image manifest is the taxonomic allowlist | Nothing else in the pipeline stops domestic ducks, hybrids and `sp.` records. |
| 11 | PC4 (4-digit) postcodes, mapped to a cell id at build time | PC6 is ~470k rows and cannot be bundled; PC4 is ~4,100 rows. A 10km cell does not need house-level precision. The browser never projects coordinates. *(eng review)* |
| 12 | Commit `data/grid.json` uncompressed; GitHub Pages gzips on the wire | A hand-gzipped `.json.gz` is served as `application/gzip` and needs `DecompressionStream` in the client. Plain JSON gets the same transfer size with zero code. *(eng review)* |
| 13 | Difficulty bands are defined against the pool the cell actually has, not fixed rank numbers | The manifest has 60-80 species; "ranks 51-90" can never be satisfied. *(eng review)* |
| 14 | Card generation lives in `src/card.js` and runs in the browser, for free cards and packs alike | The Worker only sells and validates tokens. One generator, one dataset, no dataset copy in the Worker. *(eng review)* |
| 15 | `node --test`, no test framework; `proj4` as the only dependency, dev-only | Runtime stays dependency-free. Hand-rolling the RD New transformation is where subtle projection bugs come from. *(DX review)* |

---

## Architecture

```
  BUILD TIME (manual, runs on your laptop)
  ┌──────────────────────────────────────────────────────────────────┐
  │  GBIF Occurrence Download (SIMPLE_CSV, selected columns)          │
  │  country=NL · taxonKey=212 (Aves) · license in {CC0, CC BY 4.0}   │
  │  hasCoordinate · !hasGeospatialIssue · occurrenceStatus=PRESENT   │
  │  basisOfRecord=HUMAN_OBSERVATION · coordinateUncertainty ≤ 10km   │
  │  → CSV export + citable DOI                                       │
  └───────────────────────────┬──────────────────────────────────────┘
                              ▼
              scripts/build-dataset.mjs   (streams the CSV, never loads it)
              · project points to EPSG:28992 (RD New) via proj4
              · assign to 10x10km cells, fixed origin (0, 300000)
              · aggregate by (cell, month, speciesKey)
              · adaptive-radius rollup, record confidence
              · intersect with image manifest (allowlist)
              · keep top 90 per (cell, month); fail if any inhabited
                cell-month has < 24
                              │
                              ▼
              data/grid.json        (committed; guard: < 4 MB raw)
              data/birds.json       (manifest: 60-80 species, committed)
              data/postcodes.json   (PC4 → { cell, place }, committed)
              assets/plates/*.jpg   (cropped, committed)
              ATTRIBUTION.md        (DOI + dataset list, generated section)

  ─────────────────────────────────────────────────────────────────────

  RUN TIME (browser, static, GitHub Pages)
  ┌──────────────────────────────────────────────────────────────────┐
  │  PC4 input          ──▶ postcodes.json ──▶ { cell, place }       │
  │  month + difficulty ──▶ seed = hash(cell, month, difficulty)     │
  │  grid.json          ──▶ ranked species for that cell+month       │
  │                         ──▶ pick 24 by difficulty band           │
  │                         ──▶ seeded shuffle ──▶ 5x5 card          │
  │                         ──▶ render ──▶ window.print()            │
  └──────────────────────────────────────────────────────────────────┘

  ─────────────────────────────────────────────────────────────────────

  STAGE 2 ONLY (Cloudflare Worker — tokens only, no card logic)
  ┌──────────────────────────────────────────────────────────────────┐
  │  POST /order  ──▶ Mollie payment ──▶ redirect to hosted checkout  │
  │  POST /webhook ◀── Mollie (verify, then re-fetch payment status)  │
  │              ──▶ mint pack token, store in KV                     │
  │  GET /pack?token ──▶ { cell, month, difficulty, n, packSeed }     │
  │  browser ──▶ src/card.js generates N cards + caller sheet         │
  └──────────────────────────────────────────────────────────────────┘
```

**Coupling note:** the browser never talks to GBIF. GBIF is a build-time dependency
only. If GBIF is down, the site is unaffected. This is deliberate and is the main
reason the static approach wins.

**Runtime shape.** Three fetches after page load: `postcodes.json` (~40 KB),
`birds.json` (~15 KB), `grid.json` (a few hundred KB gzipped on the wire). No
projection code, no ring logic and no ranking in the browser: all of that is baked
into `grid.json` at build time. The browser does lookup, band selection, seeded
shuffle and render.

---

## Data flow, including shadow paths

```
  INPUT ────▶ RESOLVE ────▶ RANK ──────▶ SELECT ─────▶ RENDER ────▶ PRINT
  PC4         to RD cell    species      24 birds      5x5 grid     A4
    │            │            │             │             │           │
    ▼            ▼            ▼             ▼             ▼           ▼
  empty?      unknown      cell has      pool near     image       page
  → inline    PC4?         <500 recs?    24?           missing?    overflow?
    error     → "controleer → widen       → tiers       → typo-     → verified
              je postcode"  radius ring   converge,     graphic     by print
  not 4       (no guessing) until stable  note on card  fallback    test in CI
  digits?                                                           (manual)
  → reject    not in NL     cell has      still <24?    broken      colour
    loudly    table?        zero recs?    → hard error  asset?      → greyscale
              → explain     → national    at BUILD,     → build     readable
              NL-only       fallback +    never ship    fails,      check
                            notice        a short card  never
                                                        ships
```

Every one of these paths gets a test. The two that matter most: **never render a card
with fewer than 24 birds**, and **never render a bird with no image**. Both are
build-time-verifiable because the manifest is a closed set.

---

## Card generation

**Cell resolution.** `data/postcodes.json` is generated at build time from the CBS PC4
open data (centroid + woonplaats, CC BY 4.0): PC4 → `{ cell, place }`. The cell id is
computed once, at build time, with the same projection and origin as the grid. The
browser does a dictionary lookup. Input validation: exactly four digits, first digit
1-9; anything after the digits (letters, spaces) is stripped and ignored. Degree-based
cells are not square across NL's latitude range, which is why RD is used for the grid.

**Adaptive radius.** This is the load-bearing rule, and it was derived from measured
data, not guessed. Start with the 10km cell. If it holds fewer than `MIN_RECORDS`
(500, a named constant in the build script) for that month, widen to the surrounding
ring, then wider, until stable. Record the ring count used as a `confidence` value
(0 = own cell, 1 = 30km, 2 = 50km, 3 = 70km, 9 = national fallback). The build script
prints a histogram of confidence values per month so the threshold can be tuned from
data.

Measured, same rural centre, January:

| Radius | Records | Card quality |
|---|---:|---|
| ~10km | 61 | Ranks 17-24 have **1 observation each**. Waterral, Glanskop. Unusable. |
| ~30km | 1,622 | Mostly fine, but *Bruine Klauwier* at #18 — a bird that winters in Africa. |
| ~60km | 12,207 | Stable and genuinely good. Kokmeeuw, koolmees, pimpelmees, merel, kraai, houtduif... |

The implausible-species artifact falls out on its own at the wider radius.

**Ranking.** Species are ranked by record count *after* intersecting with the
manifest, so rank numbers only ever refer to birds that have an image. The grid
stores at most the top 90 manifest species per (cell, month), as indexes into
`birds.json` plus the count.

**Difficulty bands** (v1 rule, to be tuned by observation, not by argument). Let `P`
be the pool size for the cell-month (24 ≤ P ≤ 90). Bands are thirds of the pool:
`A = ranks 1..floor(P/3)`, `B = the next floor(P/3)`, `C = the rest` (so C is never
the short one).

| Tier | Composition |
|---|---|
| Makkelijk | 24 from ranks 1-24 |
| Normaal | thirds of the top min(P, 48) ranks: 16 from A ∪ B, 8 from B ∪ C, no overlap. Never below rank 48. |
| Expert | thirds of the whole pool: 8 from A, 8 from B, 8 from C |

Because P ≥ 24 is guaranteed by the build guard, every third has at least 8 species
and every tier is satisfiable by construction: no shrink rule, no fallback path. The
honest consequence is that the tiers converge as P approaches 24 (at P = 24, expert
is a shuffle of the same 24 birds as makkelijk). When P < 45 the card footer says so:
"Weinig verschil tussen niveaus in dit gebied". The build script logs the distribution
of P per month so the manifest can grow where it matters. The original fixed bands
(21-45, 51-90) assumed a pool the 60-80 species manifest cannot provide.

**Determinism.** `seed = fnv1a32("v1|" + cell + "|" + month + "|" + tier)`, feeding a
`mulberry32` PRNG and a Fisher-Yates shuffle. Both are ~10 lines, specified in
`src/card.js`, and identical in Node and every browser; `Math.random` is never
called. Same inputs always produce the same card. The `"v1|"` prefix is bumped only
if the selection algorithm changes. A card also depends on the dataset: `grid.json`
carries `datasetVersion` (the GBIF download DOI) and the card prints it, so any card
can be regenerated from a known dataset. This is what makes the paid tier possible:
the free tier structurally cannot hand a group four different cards.

**Paid pack.** `seed = fnv1a32("v1|" + cell + "|" + month + "|" + tier + "|" + packSeed + "|" + index)`.
N cards, guaranteed-distinct arrangements, drawn from the same ranked pool so a
sighting counts for every player. Distinctness is enforced, not assumed: if card `i`
has the same layout as any earlier card, regenerate with `index + 1000 * attempt`.
Species sets overlap by design (at P = 24 they are identical), so layout is the
criterion. Plus a caller's sheet listing every bird across all cards.

**Honest framing on the site.** The free card is complete for one player. Say that.
Do not present it as a crippled demo.

---

## Image manifest — the critical path

This is the longest pole and it is not code. Budget accordingly.

`data/birds.json`, one entry per species:

```json
{
  "speciesKey": 2490719,
  "scientificName": "Turdus merula",
  "nameNl": "Merel",
  "image": "assets/plates/turdus-merula.jpg",
  "source": "https://commons.wikimedia.org/wiki/File:...",
  "credit": "Nozeman & Sepp, Nederlandsche Vogelen (1770-1829)",
  "license": "PD"
}
```

**Ship with 60-80 species, not 150.** That covers the overwhelming majority of card
cells in any Dutch location and roughly halves the critical path.

**Coverage reality check.** Measured 15/18 hits against the *18 most common* species —
the easiest possible sample. Misses were halsbandparkiet and nijlgans (20th-century
arrivals Nozeman never saw) and tjiftjaf. Coverage across ranks 50-150 will be
materially worse; assume 40-60% of the tail needs sourcing from the Biodiversity
Heritage Library, including 19th-century synonym resolution
(*Sylvia rufa* → *Phylloscopus collybita*).

**Curation order is driven by a coverage report, not by taste.**
`scripts/check-manifest.mjs` validates the manifest (below) *and* prints, from the raw
aggregated counts, the species not yet in the manifest ranked by how many inhabited
cell-months they would appear in the top 40 of. The top of that list is the next plate
to source. This turns "which bird next?" from a judgement call into a lookup.
*(DX review)*

**"Review" understates the work.** Commons plate files are full page scans: the bird is
small on a large sheet, with plate numbers, foxing, yellowed paper and varying scan
white balance. Producing a legible, tonally consistent 3.5cm asset means crop, white
balance, sometimes a background knockout, then export. That is editing.

**Acceptance checklist per image** — this is the quality bar, stated so it is testable:
1. Correct species, verified against the scientific name
2. Diagnostic features legible at 3.5cm (print it and look, do not judge on screen)
3. No plate number, caption or foxing inside the crop
4. Consistent paper tone across the set
5. Source URL and licence recorded in the manifest
6. Exported at a fixed size (square, 600x600 px, JPEG q80, ~40-60 KB) so 80 plates
   stay under 5 MB and the print stylesheet can assume one aspect ratio

Dutch names come from GBIF's `vernacularNames` where `language: "nld"`, but casing and
synonyms are inconsistent ("Wilde Eend", "kauw", "Zwarte lijster" for merel), so the
canonical name is set by hand.

---

## User interface *(design review)*

One page, Dutch copy, the existing palette (`--sky`, `--accent`, `--accent-dark`
carry forward from the current `index.html`).

**Form.** Three controls and one button, in this order:

| Control | Default | Notes |
|---|---|---|
| Postcode | empty, `inputmode="numeric"`, `maxlength` 4 after stripping | Label: "Postcode (4 cijfers)". Validation on submit, not on keystroke. |
| Maand | the current month | `<select>` with Dutch month names. |
| Niveau | Normaal | Three radio buttons: Makkelijk / Normaal / Expert, with one line each explaining what changes. |
| Button | "Maak bingokaart" | Disabled with "Even geduld…" while `grid.json` loads. |

**Card on screen.** Rendered below the form as the same DOM the print uses, at a
width that fits a 360px phone (the form is used on phones; the printing is usually
done later from a laptop). A "Printen" button calls `window.print()`. Print CSS hides
everything except the card.

**Card anatomy** (A4 portrait, 5x5, cells 3.4cm, 20mm margins):
- Header: "Vogelbingo" · place name from the PC4 table · month. "Amsterdam · mei",
  never "1012 · 5".
- Centre cell: free space, printed as a small vogelbingo.nl wordmark. No image.
- Each cell: plate image, Dutch name under it. `alt` is the Dutch name.
- Footer, small: `Waarnemingen: GBIF.org occurrence download <DOI>, CC BY 4.0 ·
  Illustraties: <credit>, publiek domein · vogelbingo.nl`. This discharges the CC BY
  obligation on every printed card.
- If `confidence` > 0, one extra footer line: "Gebaseerd op waarnemingen tot ~N km
  rond deze postcode". Confidence is honest copy, not a hidden flag.
- If the pool is under 45 species: "Weinig verschil tussen niveaus in dit gebied".

**Error copy**, inline under the form, never `alert()`:

| Condition | Text |
|---|---|
| Empty or not four digits | "Vul een Nederlandse postcode in (4 cijfers)." |
| Four digits, not in table | "Deze postcode kennen we niet. Controleer de cijfers." |
| Data fetch failed after one retry | "Kon de vogelgegevens niet laden. Probeer het later opnieuw." |

Nearest-match suggestion for an unknown PC4 is dropped: numerically adjacent PC4
codes are not reliably adjacent on the ground, and a wrong guess is worse than
asking the user to check.

**Greyscale check.** Plates are near-monochrome already; the header, names and footer
must not rely on colour. Print test in greyscale once per release.

**Not designed now:** a "kies je niveau" explainer page, sharing, saving. The page is
the form and the card.

---

## Error and rescue map

| Codepath | What goes wrong | Rescued | Action | User sees |
|---|---|---|---|---|
| `build-dataset` | GBIF download not ready | Y | poll with backoff, resume | build log |
| `build-dataset` | GBIF credentials missing | Y | abort with a message naming the env vars | build log |
| `build-dataset` | record has no usable month (year-only or range `eventDate`) | Y | use GBIF's interpreted `month` column; drop if empty | build log count |
| `build-dataset` | species not in manifest | Y | skip, warn | build log warning + coverage report |
| `build-dataset` | cell has zero usable records | Y | widen ring, then national fallback | `confidence` flag in data |
| `build-dataset` | fewer than 24 birds after all fallbacks | **N — fail the build** | abort, name the cell-month | never ships |
| `build-dataset` | `grid.json` over the size guard | **N — fail the build** | abort | never ships |
| `resolvePostcode` | malformed | Y | inline message | "Vul een Nederlandse postcode in (4 cijfers)." |
| `resolvePostcode` | unknown PC4 | Y | inline message, no guessing | "Deze postcode kennen we niet." |
| `loadGrid` | bundle fetch fails | Y | retry once, then message | "Kon de vogelgegevens niet laden." |
| `renderCard` | image asset 404 | Y | `onerror` → typographic fallback cell | bird name, no picture |
| Worker `/webhook` | forged request | Y | **never trust the payload; re-fetch payment status from Mollie by id, check `status === "paid"` and the amount** | nothing |
| Worker `/webhook` | delivered twice | Y | idempotent by payment id (two identical requests must not mint two tokens) | nothing |
| Worker `/pack` | token invalid or expired | Y | 403 with a support hint | "Deze link is verlopen" |
| Worker `/pack` | Mollie API down at order time | Y | fail before taking money, not after | "Betalen kan nu niet" |

No `catch (e) {}` anywhere. Every rescue either retries with backoff, degrades with a
visible message, or re-raises with context.

---

## Security

Stage 1 is a static site with no user accounts, no cookies and no personal data. The
attack surface is essentially the card title field if one is ever added — escape it,
never `innerHTML` user text into the card. The place name from `postcodes.json` is
repo data, not user input, but it goes through `textContent` too.

Build-time secret: the GBIF download API needs a GBIF username and password. They
live in `GBIF_USER` / `GBIF_PASSWORD` environment variables, read by the build script,
never in the repo. `.env` goes in `.gitignore`.

Stage 2 introduces the only real surface:

1. **Webhook trust.** Mollie's webhook body is not authentication. On receipt, take the
   payment id and re-fetch the payment from Mollie's API using your own key. Never mint
   a token from webhook data alone.
2. **Idempotency** (the same request arriving twice must not have double the effect).
   Mollie retries webhooks. Key token minting on the payment id.
3. **Secrets.** The Mollie key lives in Worker secrets via `wrangler secret put`. Never
   in the repo, never in the static bundle, never in a client-side env file.
4. **Token scope.** Pack tokens are random, expire, and grant access only to their own
   pack. `packSeed` is derived server-side as `HMAC(secret, paymentId)` and returned
   only to a valid token.
5. **No PII.** Mollie's hosted checkout collects payment details; your Worker never
   sees a card number. Keep it that way.
6. **The pack gate is a UX gate, not a cryptographic one.** `src/card.js` is public
   and takes `packSeed` as a plain argument, so anyone with the console can generate
   distinct cards for free. This is open risk 4, stated precisely. Moving generation
   into the Worker would not change it: the ranked pool is public data and the
   shuffle is a shuffle. Do not spend Stage 2 effort pretending otherwise.

---

## Tests

`node --test test/*.test.mjs`. `src/card.js` is a plain ES module with no DOM access
so it runs in Node unchanged; rendering is tested by comparing the produced HTML
string.

| Area | Test |
|---|---|
| Cell resolution | known PC4 → expected cell; PC4 on a cell boundary; unknown; malformed (`"10 12"`, `"1012AB"`, `"0123"`, `""`); the table has no entry outside NL by construction |
| Adaptive radius | dense urban cell stays at ring 0; sparse rural cell widens; national fallback triggers and sets `confidence` 9 |
| Card selection | always exactly 24 + free space; no duplicate species on one card; every bird has an image; `Math.random` is never called (stub it to throw) |
| Determinism | same (cell, month, difficulty) → identical HTML, twice; a documented golden card for `1012` / mei / normaal pinned as a fixture and updated deliberately when the dataset or algorithm version changes |
| Pack distinctness | N cards share a pool, no two with the same layout, caller sheet is the exact union; the collision-retry path is exercised at P = 24 where every species set is identical |
| Difficulty | each tier draws from its stated bands at P = 24, 45 and 90; P < 45 sets the convergence notice flag |
| Manifest integrity | every entry has name, image file present on disk at the fixed size, licence recorded, no duplicate `speciesKey`, `image` path unique |
| Build guard | a manifest with <24 usable species for an inhabited cell-month **fails the build**; `grid.json` over the size guard fails |
| Print | at least one manual A4 print test per release, colour and greyscale; no clipping, images legible at 3.5cm, attribution footer present |
| Worker | forged webhook rejected; duplicate webhook mints one token; expired token 403s; `/order` fails closed when Mollie is unreachable |

The build guard is the highest-value test in the list. It makes "never ship a short
card" a property of the pipeline rather than a hope.

**CI.** One GitHub Actions workflow on pull requests: `npm test` plus
`node scripts/check-manifest.mjs`. Pages deploys from `main` regardless, so turn on
branch protection requiring the check. *(DX review)*

---

## Developer experience *(DX review)*

- `package.json` with `"type": "module"`, `engines.node >= 20`, scripts
  `test`, `build:dataset`, `check:manifest`, `serve`. Runtime has zero dependencies;
  `proj4` is a devDependency used only by the build script.
- **Local serving.** Once the page fetches data files, opening `index.html` from
  `file://` no longer works. README's "just open index.html" becomes
  `npm run serve` (`python3 -m http.server 8000` or `npx serve`, whichever is
  installed). Update the README in the same PR that adds the first `fetch()`.
- **Dataset rebuild** is documented in README as: set `GBIF_USER` / `GBIF_PASSWORD`,
  run `npm run build:dataset`, commit `data/grid.json`, `data/postcodes.json` and the
  generated section of `ATTRIBUTION.md` together. The script is idempotent and
  resumes a download it already requested (download key cached in `.cache/`,
  gitignored).
- **Adding a plate** is documented as the six-point checklist above plus
  `npm run check:manifest`, whose coverage report also says which plate to do next.
- `TODOS.md` exists at the repo root (this plan referred to it before it existed).
- The gstack design doc is on the owner's laptop only. If it is still wanted, commit
  it under `docs/`; otherwise this plan is the record.

---

## Deployment

**Stage 1.** Push to `main`. GitHub Pages serves vogelbingo.nl via the existing
`CNAME`. The dataset is committed, so there is no build step in CI. Rollback is
`git revert`. GitHub Pages compresses `.json` on the wire; nothing to configure.

**Stage 2.** `wrangler deploy` for the Worker, secrets set out of band. The static site
and the Worker deploy independently, so a Worker rollback never takes the free product
down. Feature-flag the paid UI so it can be hidden without a deploy.

**Post-deploy check.** Generate a card for a known postcode and month, confirm it
matches the golden fixture, and print one.

---

## Build order

| # | Step | Effort (human / CC) |
|---|---|---|
| 0 | **Spike: hand-build 25 images, print one real A4 card.** | ~1 day / ~2h |
| 1 | Repo skeleton: `package.json`, `node --test`, CI workflow, `TODOS.md`, README updates | — / ~30m |
| 2 | GBIF Occurrence Download + `build-dataset.mjs` (streaming, grid, adaptive radius, DOI recorded, confidence histogram, size guard) + `postcodes.json` from CBS PC4 | ~3 days / ~2h |
| 3 | `check-manifest.mjs` with coverage report, then image manifest, 60-80 species, every image through the checklist, in coverage-report order | ~4 days / ~1 day |
| 4 | Card generator: PC4 lookup, seeded selection, pool-relative difficulty tiers, pack seeds, golden fixture | ~3 days / ~1.5h |
| 5 | Form, on-screen card, print stylesheet and card layout; verify on real paper, colour and greyscale | ~2 days / ~1h |
| 6 | Ship Stage 1 free on vogelbingo.nl. **Watch someone use it.** | — |
| 7 | Worker + Mollie + token minting; pack page reuses `src/card.js`; caller sheet | ~1 week / ~2h |

**Step 0 is not optional and it goes first.** It answers, before any pipeline exists,
whether the plates are legible at 3.5cm, whether a Keulemans plate sits comfortably
next to a Nozeman one, and whether the aesthetic survives a home inkjet. If mixed
sources read as sloppy, the answer is "restrict to Nozeman, accept ~200 species" —
which changes the harvest, the ranking and the difficulty bands. One afternoon that
de-risks the single largest cost line.

Earlier estimates omitted image curation entirely and were short by roughly 2x. These
are not.

---

## Files

| Path | Purpose |
|---|---|
| `docs/PLAN.md` | this document |
| `TODOS.md` | deferred items |
| `package.json` | scripts, `type: module`, `proj4` dev-only |
| `scripts/build-dataset.mjs` | GBIF export → gridded dataset, postcode table, attribution |
| `scripts/check-manifest.mjs` | manifest integrity + coverage report |
| `data/grid.json` | committed, size-guarded; `datasetVersion` = GBIF DOI |
| `data/birds.json` | image + name manifest, the allowlist |
| `data/postcodes.json` | PC4 → `{ cell, place }` |
| `assets/plates/*.jpg` | cropped plate images, 600x600 |
| `src/card.js` | PC4 lookup, seeded selection, difficulty, pack generation; DOM-free |
| `src/render.js` | grid rendering to an HTML string, `textContent`-safe |
| `src/print.css` | `@page` rules, A4 layout |
| `index.html` | rewritten: the generator form and the card, not the video |
| `test/*.test.mjs` | `node --test` |
| `.github/workflows/test.yml` | tests + manifest check on PRs |
| `worker/` | Stage 2 only |
| `ATTRIBUTION.md` | GBIF DOI, constituent datasets (generated), plate sources |

`index.html`'s colour palette (`--sky`, `--accent`, `--accent-dark`) and Dutch copy
carry forward. The video does not.

---

## Legal

- **CC BY 4.0 obliges attribution on the data.** The eBird Observation Dataset via GBIF
  is CC BY 4.0, and so are most other datasets the licence filter admits. A paid
  product distributing derived output without credit is a licence breach. A footer
  line on the printed card citing the GBIF download DOI, plus the DOI and the list of
  constituent datasets in `ATTRIBUTION.md` (written by the build script from the
  download's metadata), discharges it for every dataset in the download. This was
  missed in the first draft and is not optional.
- Plate images are public domain; credit is courtesy, not obligation.
- CBS PC4 data is CC BY 4.0; one line in `ATTRIBUTION.md`.
- Mollie needs the existing KvK. Under the kleineondernemersregeling, turnover under
  €20,000/year can be exempt from BTW filings.

---

## Not in scope

| Item | Why |
|---|---|
| Interactive tap-to-mark game | Product is print-first. The existing game is replaced. |
| Client-side PDF library | `window.print()` gives better typography with zero dependencies. |
| Map-based location picker | Third-party tile hosting is the runtime dependency this design rejects. |
| Live GBIF queries at runtime | The pre-baked national grid covers every Dutch location. |
| waarneming.nl integration | Closed API; open mirror is CC BY-NC, incompatible with a paid product. |
| Accounts, logins, saved cards | Nothing in the product needs identity. |
| Custom card titles | Invented feature, zero users. |
| Scheduled dataset regeneration | Run it by hand until there is evidence a schedule is needed. |
| QR code on the card | Rejected on taste: the appeal is that it looks like 1780. |
| PC6 / street-level postcodes | 470k rows for no gain at 10km resolution. |
| Nearest-postcode suggestions | Numeric adjacency is not geographic adjacency. |
| Card generation in the Worker | Public data plus a public shuffle; it would not protect anything. |

---

## Deferred to TODOS.md

**Findability rating per species.** A hand-set field marking heard-only, skulking and
flyover-only birds. Tjiftjaf is a top-3 species in Amsterdam in May because birders
identify it by call; a kid will never tick a chiffchaff. Occurrence count measures
presence, not visibility. Deferred because the adaptive radius already removes the
statistical noise, and this addresses the narrower biological problem. Effort: M.
Priority: P2. Revisit after real cards exist.

**Post-walk feedback loop.** The card URL asking "which of these did you actually
see?", accumulating a dataset of what casual walkers spot — which nobody has. This is
the only idea in the session that compounds. Deferred because the prerequisite is
users, not code. Recorded now so Stage 2's design does not block it. Effort: L.
Priority: P3. Needs an AVG/privacy statement before any data is collected.

**Real PDF export.** Decision 8 chose `window.print()`; a server-side or client-side
PDF is the upgrade if phone users turn out to want a file to send to a printer.
Effort: M. Priority: P3. Wait for the complaint.

---

## Open risks

1. **Nobody may pay.** Zero users today. Every belief about pricing is a guess, and
   Stage 1's free launch is the cheapest possible experiment. Do not build Stage 2
   before that data exists.
2. **The urban-similarity problem.** For a family in a city, the location-aware card is
   close to a generic Dutch urban card. The differentiator is sharpest at Texel, the
   Biesbosch and the Veluwe — where casual families go least. This is the strongest
   argument against the core premise and it is currently unanswered.
3. **The usable data is the visiting-birder subset.** Dutch birders use waarneming.nl
   (the CC-BY-NC 86%). eBird EOD in NL skews toward foreign and dedicated listers, and
   therefore toward hotspots rather than the neighbourhood park. Filtering by licence
   does not only cost volume, it changes who the observers were.
4. **The deterministic gate is a UX gate.** Adjacent urban cells overlap enough that a
   nudged postcode yields a playable card, and the generator is public JavaScript.
   Accepted knowingly: the gate needs to make paying the path of least resistance, not
   be unbreakable.
5. **Pool size at expert level.** With a 60-80 species manifest, many rural
   cell-months will have P well under 45, and there the three tiers draw from nearly
   the same birds, with a notice on the card. Whether that reads as honest or as
   broken is a Stage 1 observation, not a design argument. If it reads as broken, the
   manifest grows before Stage 2 does.

---

## Verification

1. `npm test` passes; `node scripts/build-dataset.mjs` completes and writes
   `data/grid.json` under the size guard, `data/postcodes.json`, and the generated
   section of `ATTRIBUTION.md`.
2. Build guard: temporarily trim `data/birds.json` below 24 usable species for a cell
   and confirm the build **fails** rather than emitting a short card.
3. Generate for `1012` (Amsterdam) / mei / normaal. Expect meerkoet, wilde eend, merel,
   kauw, ekster, houtduif, blauwe reiger, zwarte kraai among the 24. No non-birds.
   Header reads "Amsterdam · mei". Pin this as the golden fixture.
4. Generate for a rural Achterhoek postcode / januari / normaal. Confirm the adaptive
   radius widened, `confidence` reflects it, the footer says so, and no
   single-observation species appear.
5. Generate the same inputs twice. Output must be identical.
6. Print step 3 on A4, once in colour and once in greyscale. Every bird legible at
   3.5cm, nothing clipped, attribution footer present.
7. Stage 2: place a Mollie test payment, confirm the pack has N distinct cards sharing
   one pool, replay the webhook and confirm only one token is minted, and confirm a
   forged webhook body is rejected.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | ISSUES ADDRESSED | SELECTIVE EXPANSION; 4 proposals, 1 accepted, 2 deferred, 1 skipped |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | codex not installed |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES ADDRESSED | 9 findings, all folded in (below) |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | ISSUES ADDRESSED | 6 findings, all folded in (below) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | ISSUES ADDRESSED | 6 findings, all folded in (below) |

The 2026-09-17 passes were run by Claude Code without the gstack skills installed
(`/autoplan` was not available), following the same review shapes.

### Eng review findings (2026-09-17)

1. **Difficulty bands were unsatisfiable.** "Ranks 51-90" needs ≥ 90 manifest species
   in a cell-month; the manifest ships 60-80. Bands are now pool-relative thirds,
   satisfiable whenever the build guard passes, with a card notice where tiers
   converge. (Decision 13, open risk 5.)
2. **Postcode table had no source or granularity.** Now CBS PC4 open data, mapped to
   cell ids at build time, so the browser needs no projection. (Decision 11.)
3. **`grid.json.gz` needs client-side decompression on GitHub Pages.** Pages serves it
   as `application/gzip`. Plain JSON is gzipped on the wire for free. (Decision 12.)
4. **Determinism was unspecified.** Hash, PRNG and shuffle are now named
   (FNV-1a → mulberry32 → Fisher-Yates), `Math.random` is banned by test, the
   algorithm is versioned, and the dataset DOI is printed on the card.
5. **Pack distinctness was asserted, not enforced.** Collision → reseed, tested.
6. **The Worker was going to need the dataset and the generator.** It now only mints
   and validates tokens; the browser generates packs from `packSeed`. (Decision 14.)
7. **GBIF download predicate was underspecified** (basis of record, geospatial
   issues, coordinate uncertainty, presence-only), the export can be multi-GB so the
   script must stream, and the download API needs credentials that must not land in
   the repo. Month comes from GBIF's interpreted `month` column, not from parsing
   `eventDate`.
8. **Build guard scope was vague.** Now: every inhabited cell-month (one with a PC4
   centroid), plus a size guard on `grid.json`. Tiers need no separate guard once
   bands are pool-relative.
9. **Test runner was unspecified.** `node --test`; `card.js` is DOM-free so it runs in
   Node; a golden fixture for `1012`/mei/normaal catches silent algorithm drift.

### Design review findings (2026-09-17)

1. The card said the postcode; it now says the place name and month.
2. `confidence` was data only; it is now a footer line the reader can act on.
3. The free centre cell, the attribution footer text and the alt text were undefined;
   they are specified.
4. Error copy is fixed Dutch strings; nearest-postcode guessing is dropped.
5. The form defaults (current month, Normaal), input mode and loading state are
   specified; the on-screen card must fit a 360px phone.
6. Greyscale print is part of the release check.

### DX review findings (2026-09-17)

1. `TODOS.md` was referenced but did not exist; created.
2. README's "just open index.html" breaks once the page uses `fetch()`; `npm run serve`
   and a README update are scheduled with the first fetch.
3. No `package.json`, no test command, no CI. Added as build step 1.
4. Curation order had no tool; `check-manifest.mjs` prints a coverage report.
5. The dataset rebuild procedure (credentials, resume, what to commit together) is
   written down.
6. The design doc lives outside the repo; noted, with the plan as the record.

**SPEC REVIEW:** design doc scored 5/10 on adversarial review; 16 findings accepted and
folded into this plan, 4 rejected as stale or contradicting an owner decision.
**UNRESOLVED:** 0 blocking. 5 open risks recorded above.
**VERDICT:** CEO CLEARED, ENG / DESIGN / DX REVIEWED — ready for implementation,
starting with step 0.
