# Vogelbingo

Printable bird bingo cards for a Dutch postcode and month, with only the birds that are
actually there at that time. Static HTML/CSS/JS, hosted on GitHub Pages at vogelbingo.nl.
The plan and its review history live in [docs/PLAN.md](docs/PLAN.md).

## Status

Stage 1 (free card) is implemented end to end, but two inputs are **stopgaps** until the
dataset build has been run on a machine with internet access:

| Input | Now | Target |
|---|---|---|
| Species per cell and month | `data/seed/species.json`: expert-estimated monthly abundance and habitat affinity, **not observations** | GBIF occurrence download (CC0 / CC BY 4.0 records), see below |
| Postcode → cell | one centroid per two-digit postcode area (`data/seed/pc2-regions.json`) | CBS PC4 polygons via PDOK |
| Plates | none yet; cards print the bird's Dutch and scientific name in a framed cell | 60-80 public-domain plates, see "Adding a plate" |

The card footer says "Voorlopige gegevens" while the seed dataset is in use.

## Development

```
npm install          # proj4, build-time only
npm test             # node --test
npm run check:manifest
npm run serve        # http://localhost:8000 — the page fetches data/, so file:// does not work
```

The browser code (`src/card.js`, `src/render.js`, `src/app.js`) has no dependencies and
no build step. `src/card.js` is DOM-free and is the same module the tests run in Node.

Deep links work: `/?postcode=1012&maand=5&niveau=normaal`.

## Rebuilding the dataset

1. Create a free account at gbif.org and export `GBIF_USER` and `GBIF_PASSWORD` in your
   shell (never commit them; `.env` is ignored).
2. `node scripts/build-dataset.mjs --request-download` requests the occurrence download
   (Netherlands, Aves, CC0/CC BY, human observations with coordinates), polls until it is
   ready and saves the zip under `.cache/`. It prints the DOI and the next command.
3. Download the CBS PC4 areas as GeoJSON from PDOK ("CBS Wijk- en buurtkaart",
   postcode-4 layer).
4. `unzip .cache/<key>.zip -d .cache && node scripts/build-dataset.mjs --source gbif-csv .cache/<key>.csv --doi <doi> --postcodes cbs_pc4.geojson`
5. Commit `data/grid.json`, `data/postcodes.json` and `ATTRIBUTION.md` together.

The build streams the CSV (it can be several GB), applies the adaptive radius, refuses to
write a grid in which any inhabited cell-month has fewer than 24 species, and refuses a
`grid.json` over 4 MB. It also writes `.cache/coverage.json`: species in the export that
are not in the manifest, ranked by how often they would appear on cards.

Without arguments the script rebuilds the stopgap seed dataset.

## Adding a plate

1. Find a public-domain plate (Nozeman & Sepp on Wikimedia Commons first, then the
   Biodiversity Heritage Library). Verify the species against the scientific name.
2. Crop to the bird, fix white balance, remove plate numbers and foxing, export as a
   600x600 JPEG (quality 80) to `assets/plates/<genus>-<species>.jpg`.
3. Print it at 3.5 cm and look at it. If the diagnostic features are not legible, pick
   another plate.
4. Fill in `image`, `source`, `credit` and `license` on the species in `data/birds.json`.
5. `npm run check:manifest` validates the entry and prints which plate to do next
   (the unillustrated species that appear on the most cards). Once every species has a
   plate, switch CI to `--require-images`.

## Hosting

Deployed via GitHub Pages from `main` with a custom domain (see `CNAME`). The dataset is
committed, so there is no build in CI; CI runs the tests and the manifest check. DNS at
the registrar (TransIP) needs to point `vogelbingo.nl` at GitHub Pages.
