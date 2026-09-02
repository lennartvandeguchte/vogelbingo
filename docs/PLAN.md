# Vogelbingo — Implementation Plan

Produced by `/plan-ceo-review` (with `/office-hours`) on 2026-09-02.
Design doc: `~/.gstack/projects/lennartvandeguchte-vogelbingo/lennart-claude-vogelbingo-plan-review-137adb-design-20260902-210608.md`

---

## Context

The repo currently holds one file: [index.html](index.html), a 5x5 bingo grid with 24
hardcoded birds represented as emoji. It was a placeholder, and it has three animals
that are not birds (bat for Gierzwaluw, hedgehog for Roodborstje, seal for
Aalscholver), three species that do not occur wild in the Netherlands (Flamingo, Pauw,
Dodo), and six duplicated emoji.

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
| 7 | One gzipped dataset bundle, not per-cell files | ~500 cells x 12 months is <1MB gzipped. 6,000 files in git buys nothing. |
| 8 | `@media print` + `window.print()`, not a PDF library | Zero deps, better typography, crisper images. Real PDF export is a later upgrade. |
| 9 | Bundled postcode table, not a map | A map means third-party tile hosting, the exact runtime dependency this design rejects everywhere else. |
| 10 | The image manifest is the taxonomic allowlist | Nothing else in the pipeline stops domestic ducks, hybrids and `sp.` records. |

---

## Architecture

```
  BUILD TIME (manual, runs on your laptop)
  ┌──────────────────────────────────────────────────────────────────┐
  │  GBIF Occurrence Download                                        │
  │  NL · Aves · license in {CC0, CC-BY} · lat/lon/eventDate         │
  │  → DwC-A export + citable DOI                                    │
  └───────────────────────────┬──────────────────────────────────────┘
                              ▼
              scripts/build-dataset.mjs
              · project points to EPSG:28992 (RD New)
              · assign to 10x10km cells, fixed origin
              · aggregate by (cell, month, speciesKey)
              · adaptive-radius rollup, record confidence
              · intersect with image manifest (allowlist)
                              │
                              ▼
              data/grid.json.gz   (<1 MB, committed)
              data/birds.json     (manifest: 60-80 species, committed)
              assets/plates/*.jpg (cropped, committed)

  ─────────────────────────────────────────────────────────────────────

  RUN TIME (browser, static, GitHub Pages)
  ┌──────────────────────────────────────────────────────────────────┐
  │  postcode/place input ──▶ postcodes.json ──▶ RD cell id          │
  │  month + difficulty    ──▶ seed = hash(cell, month, difficulty)  │
  │  grid.json.gz          ──▶ ranked species for that cell+month    │
  │                            ──▶ pick 24 by difficulty band        │
  │                            ──▶ seeded shuffle ──▶ 5x5 card       │
  │                            ──▶ render ──▶ window.print()         │
  └──────────────────────────────────────────────────────────────────┘

  ─────────────────────────────────────────────────────────────────────

  STAGE 2 ONLY (Cloudflare Worker)
  ┌──────────────────────────────────────────────────────────────────┐
  │  POST /order  ──▶ Mollie payment ──▶ redirect to hosted checkout  │
  │  POST /webhook ◀── Mollie (verify, then re-fetch payment status)  │
  │              ──▶ mint pack token, store in KV                     │
  │  GET /pack?token ──▶ N distinct card definitions + caller sheet   │
  └──────────────────────────────────────────────────────────────────┘
```

**Coupling note:** the browser never talks to GBIF. GBIF is a build-time dependency
only. If GBIF is down, the site is unaffected. This is deliberate and is the main
reason the static approach wins.

---

## Data flow, including shadow paths

```
  INPUT ────▶ RESOLVE ────▶ RANK ──────▶ SELECT ─────▶ RENDER ────▶ PRINT
  postcode    to RD cell    species      24 birds      5x5 grid     A4
    │            │            │             │             │           │
    ▼            ▼            ▼             ▼             ▼           ▼
  empty?      unknown      cell has      fewer than    image       page
  → inline    postcode?    <500 recs?    24 in         missing?    overflow?
    error     → suggest    → widen       manifest?     → typo-     → verified
              nearest      radius ring   → widen       graphic     by print
  bad         match        until stable  radius, then  fallback    test in CI
  format?                                fall back to  cell        (manual)
  → reject    outside NL?  cell has      national                  colour
    loudly    → explain    zero recs?    top list      broken      → greyscale
              NL-only      → national                  asset?      readable
                           fallback +    still <24?    → build     check
                           notice        → hard error, fails,
                                         never ship a  never
                                         short card    ships
```

Every one of these paths gets a test. The two that matter most: **never render a card
with fewer than 24 birds**, and **never render a bird with no image**. Both are
build-time-verifiable because the manifest is a closed set.

---

## Card generation

**Cell resolution.** Postcode → coordinates via a bundled table → EPSG:28992 → 10x10km
cell with a fixed origin and integer cell ID. Degree-based cells are not square across
NL's latitude range, which is why RD is used.

**Adaptive radius.** This is the load-bearing rule, and it was derived from measured
data, not guessed. Start with the 10km cell. If it holds fewer than ~500 records for
that month, widen to the surrounding ring, then wider, until stable. Record the radius
used as a `confidence` value.

Measured, same rural centre, January:

| Radius | Records | Card quality |
|---|---:|---|
| ~10km | 61 | Ranks 17-24 have **1 observation each**. Waterral, Glanskop. Unusable. |
| ~30km | 1,622 | Mostly fine, but *Bruine Klauwier* at #18 — a bird that winters in Africa. |
| ~60km | 12,207 | Stable and genuinely good. Kokmeeuw, koolmees, pimpelmees, merel, kraai, houtduif... |

The implausible-species artifact falls out on its own at the wider radius.

**Difficulty bands** (v1 rule, to be tuned by observation, not by argument):

| Tier | Composition |
|---|---|
| Makkelijk | 24 from ranks 1-24 |
| Normaal | 16 from ranks 1-20, 8 from ranks 21-45 |
| Expert | 10 from ranks 1-20, 10 from ranks 21-50, 4 from ranks 51-90 |

**Determinism.** `seed = hash(cellId, month, difficulty)`. Same inputs always produce
the same card. This is what makes the paid tier possible: the free tier structurally
cannot hand a group four different cards.

**Paid pack.** `seed = hash(cellId, month, difficulty, packToken, index)`. N cards,
guaranteed-distinct arrangements, drawn from the same ranked pool so a sighting counts
for every player. Plus a caller's sheet listing every bird across all cards.

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

Dutch names come from GBIF's `vernacularNames` where `language: "nld"`, but casing and
synonyms are inconsistent ("Wilde Eend", "kauw", "Zwarte lijster" for merel), so the
canonical name is set by hand.

---

## Error and rescue map

| Codepath | What goes wrong | Rescued | Action | User sees |
|---|---|---|---|---|
| `build-dataset` | GBIF download not ready | Y | poll with backoff, resume | build log |
| `build-dataset` | species not in manifest | Y | skip, warn | build log warning |
| `build-dataset` | cell has zero usable records | Y | widen ring, then national fallback | `confidence` flag in data |
| `build-dataset` | fewer than 24 birds after all fallbacks | **N — fail the build** | abort | never ships |
| `resolvePostcode` | unknown / malformed | Y | inline message, suggest nearest | "Onbekende postcode" |
| `resolvePostcode` | outside NL | Y | explicit message | "Alleen in Nederland" |
| `loadGrid` | bundle fetch fails | Y | retry once, then message | "Kon gegevens niet laden" |
| `renderCard` | image asset 404 | Y | typographic fallback cell | bird name, no picture |
| Worker `/webhook` | forged request | Y | **never trust the payload; re-fetch payment status from Mollie by id** | nothing |
| Worker `/webhook` | delivered twice | Y | idempotent by payment id (two identical requests must not mint two tokens) | nothing |
| Worker `/pack` | token invalid or expired | Y | 403 with a support hint | "Deze link is verlopen" |
| Worker `/pack` | Mollie API down at order time | Y | fail before taking money, not after | "Betalen kan nu niet" |

No `catch (e) {}` anywhere. Every rescue either retries with backoff, degrades with a
visible message, or re-raises with context.

---

## Security

Stage 1 is a static site with no user accounts, no cookies and no personal data. The
attack surface is essentially the card title field if one is ever added — escape it,
never `innerHTML` user text into the card.

Stage 2 introduces the only real surface:

1. **Webhook trust.** Mollie's webhook body is not authentication. On receipt, take the
   payment id and re-fetch the payment from Mollie's API using your own key. Never mint
   a token from webhook data alone.
2. **Idempotency** (the same request arriving twice must not have double the effect).
   Mollie retries webhooks. Key token minting on the payment id.
3. **Secrets.** The Mollie key lives in Worker secrets via `wrangler secret put`. Never
   in the repo, never in the static bundle, never in a client-side env file.
4. **Token scope.** Pack tokens are random, expire, and grant access only to their own
   pack.
5. **No PII.** Mollie's hosted checkout collects payment details; your Worker never
   sees a card number. Keep it that way.

---

## Tests

| Area | Test |
|---|---|
| Cell resolution | known postcode → expected RD cell; boundary postcodes; unknown; malformed; non-NL |
| Adaptive radius | dense urban cell stays at 10km; sparse rural cell widens; national fallback triggers |
| Card selection | always exactly 24 + free space; no duplicate species on one card; every bird has an image |
| Determinism | same (cell, month, difficulty) → byte-identical card, twice |
| Pack distinctness | N cards share a pool, no two identical, caller sheet is the exact union |
| Difficulty | each tier draws from its stated rank bands |
| Manifest integrity | every entry has name, image file present on disk, licence recorded |
| Build guard | a manifest with <24 usable species for a cell **fails the build** |
| Print | at least one manual A4 print test per release; no clipping, images legible at 3.5cm |
| Worker | forged webhook rejected; duplicate webhook mints one token; expired token 403s |

The build guard is the highest-value test in the list. It makes "never ship a short
card" a property of the pipeline rather than a hope.

---

## Deployment

**Stage 1.** Push to `main`. GitHub Pages serves vogelbingo.nl via the existing
`CNAME`. The dataset is committed, so there is no build step in CI. Rollback is
`git revert`.

**Stage 2.** `wrangler deploy` for the Worker, secrets set out of band. The static site
and the Worker deploy independently, so a Worker rollback never takes the free product
down. Feature-flag the paid UI so it can be hidden without a deploy.

**Post-deploy check.** Generate a card for a known postcode and month, confirm it
matches the expected deterministic output, and print one.

---

## Build order

| # | Step | Effort (human / CC) |
|---|---|---|
| 0 | **Spike: hand-build 25 images, print one real A4 card.** | ~1 day / ~2h |
| 1 | GBIF Occurrence Download + `build-dataset.mjs` (grid, adaptive radius, DOI recorded) | ~3 days / ~2h |
| 2 | Image manifest, 60-80 species, every image through the checklist | ~4 days / ~1 day |
| 3 | Card generator: cell resolution, seeded selection, difficulty tiers | ~3 days / ~1.5h |
| 4 | Print stylesheet and card layout; verify on real paper | ~2 days / ~1h |
| 5 | Ship Stage 1 free on vogelbingo.nl. **Watch someone use it.** | — |
| 6 | Worker + Mollie + pack generation + caller sheet | ~1 week / ~2h |

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
| `scripts/build-dataset.mjs` | GBIF export → gridded dataset |
| `data/grid.json.gz` | committed, <1MB |
| `data/birds.json` | image + name manifest, the allowlist |
| `data/postcodes.json` | postcode → coordinates |
| `assets/plates/*.jpg` | cropped plate images |
| `src/card.js` | cell resolution, seeded selection, difficulty |
| `src/render.js` | grid rendering |
| `src/print.css` | `@page` rules, A4 layout |
| `index.html` | rewritten: the generator form, not the game |
| `worker/` | Stage 2 only |
| `ATTRIBUTION.md` | GBIF DOI, eBird EOD CC BY 4.0 credit, plate sources |

`index.html`'s colour palette (`--sky`, `--accent`, `--marked`) and Dutch copy carry
forward. Its game logic does not.

---

## Legal

- **CC BY 4.0 obliges attribution on the data.** The eBird Observation Dataset via GBIF
  is CC BY 4.0. A paid product distributing derived output without credit is a licence
  breach. A footer line on the printed card plus the snapshot DOI in `ATTRIBUTION.md`
  discharges it. This was missed in the first draft and is not optional.
- Plate images are public domain; credit is courtesy, not obligation.
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
4. **The deterministic gate is partly self-enforcing but not airtight.** Adjacent urban
   cells overlap enough that a nudged postcode yields a playable card. Accepted
   knowingly: the gate needs to make paying the path of least resistance, not be
   unbreakable.

---

## Verification

1. `node scripts/build-dataset.mjs` completes and writes `data/grid.json.gz` under 1MB.
2. Build guard: temporarily trim `data/birds.json` below 24 usable species for a cell
   and confirm the build **fails** rather than emitting a short card.
3. Generate for `1012` (Amsterdam) / mei / normaal. Expect meerkoet, wilde eend, merel,
   kauw, ekster, houtduif, blauwe reiger, zwarte kraai among the 24. No non-birds.
4. Generate for a rural Achterhoek postcode / januari / normaal. Confirm the adaptive
   radius widened, `confidence` reflects it, and no single-observation species appear.
5. Generate the same inputs twice. Cards must be byte-identical.
6. Print step 3 on A4. Every bird legible at 3.5cm, nothing clipped, attribution
   footer present.
7. Stage 2: place a Mollie test payment, confirm the pack has N distinct cards sharing
   one pool, replay the webhook and confirm only one token is minted, and confirm a
   forged webhook body is rejected.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | ISSUES ADDRESSED | SELECTIVE EXPANSION; 4 proposals, 1 accepted, 2 deferred, 1 skipped |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | codex not installed |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | NOT RUN | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | NOT RUN | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | NOT RUN | — |

**SPEC REVIEW:** design doc scored 5/10 on adversarial review; 16 findings accepted and
folded into this plan, 4 rejected as stale or contradicting an owner decision.
**UNRESOLVED:** 0 blocking. 4 open risks recorded above.
**VERDICT:** CEO CLEARED — eng review recommended before implementation.
