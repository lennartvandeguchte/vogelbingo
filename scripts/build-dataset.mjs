#!/usr/bin/env node
// GBIF export (or the stopgap seed) → data/grid.json, data/postcodes.json, ATTRIBUTION.md.
//
//   node scripts/build-dataset.mjs                              # seed mode (stopgap data)
//   node scripts/build-dataset.mjs --request-download           # ask GBIF for the export (needs GBIF_USER/GBIF_PASSWORD)
//   node scripts/build-dataset.mjs --source gbif-csv occurrence.csv --doi 10.15468/dl.xxxxx \
//                                  --postcodes cbs_pc4.geojson
//
// The browser never runs any of this.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { cellId, CELL_SIZE, ORIGIN } from './lib/rd.mjs';
import { buildGrid, MIN_RECORDS, MAX_RING } from './lib/aggregate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const SIZE_GUARD_BYTES = 4 * 1024 * 1024;
const MAX_COORD_UNCERTAINTY_M = 10000;
const ALLOWED_LICENSES = new Set(['CC0_1_0', 'CC_BY_4_0']);
const SEED_PRESENCE_CUTOFF = 0.06; // seed mode only: a species under 6% of the cell-month's top count is treated as absent

const args = parseArgs(process.argv.slice(2));

if (args['request-download']) {
  await requestDownload();
  process.exit(0);
}

const birds = readJson('data/birds.json');
const speciesIndex = new Map(birds.map((b, i) => [b.scientificName, i]));

const postcodes = args.postcodes ? await postcodesFromCbs(args.postcodes) : postcodesFromSeed();
const inhabited = new Set(Object.values(postcodes).filter((v) => v.cell !== undefined).map((v) => v.cell));
log(`postcodes: ${Object.keys(postcodes).filter((k) => !k.startsWith('_')).length} entries, ${inhabited.size} inhabited cells`);

let counts;
let datasetVersion;
let sourceNote;
let coverage = null;
if (args.source === 'gbif-csv') {
  if (!args._[0]) fail('--source gbif-csv needs the path to the occurrence CSV');
  if (!args.doi) fail('--doi <download DOI> is required for a GBIF build (it is printed on every card)');
  ({ counts, coverage } = await countsFromGbifCsv(args._[0]));
  datasetVersion = args.doi;
  sourceNote = 'gbif';
} else {
  counts = countsFromSeed();
  datasetVersion = 'seed-2026-09';
  sourceNote = 'seed';
}

const grid = buildGrid(counts, inhabited);
for (let m = 0; m < 12; m++) {
  const h = grid.histogram[m];
  log(`month ${String(m + 1).padStart(2)}: confidence histogram ${JSON.stringify(h)}`);
}
const sizes = grid.poolSizes.slice().sort((a, b) => a - b);
log(`pool size: min ${sizes[0]}, median ${sizes[Math.floor(sizes.length / 2)]}, max ${sizes[sizes.length - 1]}; ${sizes.filter((s) => s < 45).length} cell-months under 45`);

const out = {
  datasetVersion,
  source: sourceNote,
  generated: new Date().toISOString().slice(0, 10),
  cellSize: CELL_SIZE,
  origin: ORIGIN,
  minRecords: MIN_RECORDS,
  maxRing: MAX_RING,
  speciesCount: birds.length,
  cells: grid.cells,
  national: grid.national,
};
const json = JSON.stringify(out);
if (json.length > SIZE_GUARD_BYTES) fail(`grid.json is ${json.length} bytes, over the ${SIZE_GUARD_BYTES} guard`);
fs.writeFileSync(path.join(ROOT, 'data/grid.json'), json);
fs.writeFileSync(path.join(ROOT, 'data/postcodes.json'), JSON.stringify(postcodes));
log(`wrote data/grid.json (${json.length} bytes) and data/postcodes.json`);
if (coverage) {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, 'coverage.json'), JSON.stringify(coverage, null, 1));
  log(`wrote .cache/coverage.json (${coverage.length} species seen in GBIF but not in the manifest)`);
}
writeAttribution(datasetVersion, sourceNote);

// ---------------------------------------------------------------------------

function countsFromSeed() {
  const seed = readJson('data/seed/species.json').species;
  const regions = readJson('data/seed/pc2-regions.json');
  const counts = new Map();
  const areas = [...Object.values(regions.regions), ...regions.overrides];
  for (const area of areas) {
    const id = cellId(area.lon, area.lat);
    if (id === null) fail(`seed region ${area.place} is outside the grid`);
    if (!counts.has(id)) counts.set(id, Array.from({ length: 12 }, () => new Map()));
    const cell = counts.get(id);
    for (const [sci, s] of Object.entries(seed)) {
      const idx = speciesIndex.get(sci);
      if (idx === undefined) {
        warn(`seed species ${sci} is not in the manifest, skipped`);
        continue;
      }
      let fit = 0;
      for (const [h, w] of Object.entries(area.habitat)) fit += w * (s.habitat[h] || 0);
      for (let m = 0; m < 12; m++) {
        const n = Math.round(s.months[m] * fit * 100);
        if (n > 0) cell[m].set(idx, (cell[m].get(idx) || 0) + n);
      }
    }
    for (const m of cell) {
      const top = Math.max(...m.values());
      for (const [idx, n] of m) if (n < top * SEED_PRESENCE_CUTOFF) m.delete(idx);
    }
  }
  return counts;
}

function postcodesFromSeed() {
  const regions = readJson('data/seed/pc2-regions.json');
  const table = { _provenance: regions._provenance };
  for (const [pc2, r] of Object.entries(regions.regions)) {
    const cell = cellId(r.lon, r.lat);
    for (let i = 0; i < 100; i++) table[pc2 + String(i).padStart(2, '0')] = { cell, place: r.place };
  }
  for (const o of regions.overrides) {
    const cell = cellId(o.lon, o.lat);
    for (let p = Number(o.from); p <= Number(o.to); p++) table[String(p)] = { cell, place: o.place };
  }
  return table;
}

/** CBS PC4 GeoJSON (PDOK): one polygon per PC4, property `postcode`. */
async function postcodesFromCbs(file) {
  const gj = JSON.parse(fs.readFileSync(file, 'utf8'));
  const table = { _provenance: 'CBS Wijk- en buurtkaart, postcode-4 areas (CC BY 4.0), centroid per PC4' };
  for (const f of gj.features) {
    const p = f.properties;
    const pc4 = String(p.postcode ?? p.PC4 ?? p.pc4);
    if (!/^[1-9][0-9]{3}$/.test(pc4)) continue;
    const [lon, lat] = centroid(f.geometry);
    const cell = cellId(lon, lat);
    if (cell === null) {
      warn(`PC4 ${pc4} falls outside the grid`);
      continue;
    }
    table[pc4] = { cell, place: p.gemeentenaam ?? p.GM_NAAM ?? p.plaats ?? pc4 };
  }
  return table;
}

function centroid(geometry) {
  const pts = [];
  const walk = (c) => (typeof c[0] === 'number' ? pts.push(c) : c.forEach(walk));
  walk(geometry.coordinates);
  const n = pts.length;
  return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
}

/** Stream a GBIF SIMPLE_CSV export (tab separated) into per-cell counts. */
async function countsFromGbifCsv(file) {
  const counts = new Map();
  const unknown = new Map(); // scientific name → Map<cellMonthKey, count> for the coverage report
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let header = null;
  let col = {};
  let rows = 0;
  let kept = 0;
  const dropped = { month: 0, coords: 0, license: 0, basis: 0, status: 0, uncertainty: 0, grid: 0, species: 0 };
  for await (const line of rl) {
    if (!header) {
      header = line.split('\t');
      col = Object.fromEntries(header.map((h, i) => [h, i]));
      for (const need of ['species', 'decimalLatitude', 'decimalLongitude', 'month', 'license']) {
        if (!(need in col)) fail(`CSV has no column "${need}"`);
      }
      continue;
    }
    rows++;
    const f = line.split('\t');
    const month = Number(f[col.month]);
    if (!(month >= 1 && month <= 12)) { dropped.month++; continue; }
    const lat = Number(f[col.decimalLatitude]);
    const lon = Number(f[col.decimalLongitude]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { dropped.coords++; continue; }
    if (!ALLOWED_LICENSES.has(f[col.license])) { dropped.license++; continue; }
    if ('basisOfRecord' in col && f[col.basisOfRecord] !== 'HUMAN_OBSERVATION') { dropped.basis++; continue; }
    if ('occurrenceStatus' in col && f[col.occurrenceStatus] && f[col.occurrenceStatus] !== 'PRESENT') { dropped.status++; continue; }
    if ('coordinateUncertaintyInMeters' in col) {
      const u = Number(f[col.coordinateUncertaintyInMeters]);
      if (Number.isFinite(u) && u > MAX_COORD_UNCERTAINTY_M) { dropped.uncertainty++; continue; }
    }
    const id = cellId(lon, lat);
    if (id === null) { dropped.grid++; continue; }
    const sci = f[col.species];
    const idx = speciesIndex.get(sci);
    if (idx === undefined) {
      dropped.species++;
      if (sci) {
        if (!unknown.has(sci)) unknown.set(sci, new Map());
        const k = `${id}:${month}`;
        unknown.get(sci).set(k, (unknown.get(sci).get(k) || 0) + 1);
      }
      continue;
    }
    if (!counts.has(id)) counts.set(id, Array.from({ length: 12 }, () => new Map()));
    const m = counts.get(id)[month - 1];
    m.set(idx, (m.get(idx) || 0) + 1);
    kept++;
    if (rows % 1000000 === 0) log(`${rows} rows read, ${kept} kept`);
  }
  log(`${rows} rows, ${kept} kept, dropped ${JSON.stringify(dropped)}`);
  const coverage = [...unknown.entries()]
    .map(([sci, m]) => ({ scientificName: sci, cellMonths: m.size, records: [...m.values()].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.cellMonths - a.cellMonths || b.records - a.records);
  return { counts, coverage };
}

/** Ask GBIF for the occurrence download; poll until it is ready; save the zip in .cache/. */
async function requestDownload() {
  const user = process.env.GBIF_USER;
  const pass = process.env.GBIF_PASSWORD;
  if (!user || !pass) fail('set GBIF_USER and GBIF_PASSWORD (a free gbif.org account) in the environment, never in the repo');
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  fs.mkdirSync(CACHE, { recursive: true });
  const keyFile = path.join(CACHE, 'download-key.txt');
  let key = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : null;
  if (!key) {
    const predicate = {
      type: 'and',
      predicates: [
        { type: 'equals', key: 'COUNTRY', value: 'NL' },
        { type: 'equals', key: 'TAXON_KEY', value: '212' },
        { type: 'in', key: 'LICENSE', values: ['CC0_1_0', 'CC_BY_4_0'] },
        { type: 'equals', key: 'HAS_COORDINATE', value: 'true' },
        { type: 'equals', key: 'HAS_GEOSPATIAL_ISSUE', value: 'false' },
        { type: 'equals', key: 'OCCURRENCE_STATUS', value: 'PRESENT' },
        { type: 'equals', key: 'BASIS_OF_RECORD', value: 'HUMAN_OBSERVATION' },
      ],
    };
    const res = await fetch('https://api.gbif.org/v1/occurrence/download/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ creator: user, notificationAddresses: [], sendNotification: false, format: 'SIMPLE_CSV', predicate }),
    });
    if (!res.ok) fail(`GBIF download request failed: ${res.status} ${await res.text()}`);
    key = (await res.text()).trim();
    fs.writeFileSync(keyFile, key);
    log(`requested download ${key}`);
  } else {
    log(`resuming download ${key}`);
  }
  let delay = 30000;
  for (;;) {
    const res = await fetch(`https://api.gbif.org/v1/occurrence/download/${key}`, { headers: { Authorization: auth } });
    if (!res.ok) fail(`GBIF status check failed: ${res.status}`);
    const info = await res.json();
    log(`status ${info.status}`);
    if (info.status === 'SUCCEEDED') {
      const zip = path.join(CACHE, `${key}.zip`);
      const dl = await fetch(info.downloadLink);
      if (!dl.ok) fail(`download failed: ${dl.status}`);
      fs.writeFileSync(zip, Buffer.from(await dl.arrayBuffer()));
      log(`saved ${zip}. DOI: ${info.doi}`);
      log(`next: unzip ${zip} -d .cache && node scripts/build-dataset.mjs --source gbif-csv .cache/${key}.csv --doi ${info.doi} --postcodes <cbs_pc4.geojson>`);
      return;
    }
    if (['FAILED', 'KILLED', 'CANCELLED'].includes(info.status)) fail(`download ${key} ended with ${info.status}`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 5 * 60000);
  }
}

function writeAttribution(version, source) {
  const file = path.join(ROOT, 'ATTRIBUTION.md');
  const start = '<!-- generated:start -->';
  const end = '<!-- generated:end -->';
  const body =
    source === 'gbif'
      ? `Waarnemingen: GBIF.org occurrence download https://doi.org/${version} (CC BY 4.0 en CC0 datasets). ` +
        `De volledige lijst van bronnen staat in de download-metadata op GBIF onder die DOI.`
      : `Dataset \`${version}\`: **voorlopige, door experts geschatte** maandelijkse soortenlijsten ` +
        `(\`data/seed/species.json\`), geen waarnemingen. Wordt vervangen door een GBIF occurrence download ` +
        `zodra \`scripts/build-dataset.mjs --source gbif-csv\` is gedraaid.`;
  const generated = `${start}\n_Gegenereerd op ${new Date().toISOString().slice(0, 10)} door scripts/build-dataset.mjs._\n\n${body}\n${end}`;
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text.includes(start) && text.includes(end)) {
    text = text.slice(0, text.indexOf(start)) + generated + text.slice(text.indexOf(end) + end.length);
  } else {
    text += `\n## Waarnemingsgegevens\n\n${generated}\n`;
  }
  fs.writeFileSync(file, text);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && ['source', 'doi', 'postcodes'].includes(k)) {
        out[k] = next;
        i++;
      } else {
        out[k] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}
function log(msg) {
  console.log(`[build-dataset] ${msg}`);
}
function warn(msg) {
  console.warn(`[build-dataset] WARNING: ${msg}`);
}
function fail(msg) {
  console.error(`[build-dataset] ERROR: ${msg}`);
  process.exit(1);
}
