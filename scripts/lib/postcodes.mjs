// Reads the CBS PC4 areas (GeoPackage from PDOK, or GeoJSON) into cell ids,
// and looks up a place name per PC4 via the PDOK Locatieserver.
import fs from 'node:fs';
import path from 'node:path';
import { cellId, cellIdFromRD } from './rd.mjs';

const PC4 = /^[1-9][0-9]{3}$/;

/** Read features as [{ postcode, points: [[x, y], ...] }] from .gpkg or .geojson. */
export function readPc4Features(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.gpkg') return readGeoPackage(file);
  if (ext === '.geojson' || ext === '.json') return readGeoJson(file);
  throw new Error(`postcodes: unsupported file type ${ext} (use .gpkg or .geojson)`);
}

function readGeoJson(file) {
  const gj = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const f of gj.features) {
    const postcode = findPostcode(f.properties);
    if (!postcode) continue;
    const points = [];
    walkCoords(f.geometry.coordinates, points);
    out.push({ postcode, points, properties: f.properties });
  }
  return out;
}

function walkCoords(c, points) {
  if (typeof c[0] === 'number') points.push([c[0], c[1]]);
  else for (const x of c) walkCoords(x, points);
}

async function loadSqlite() {
  const mod = await import('node:sqlite');
  return mod.DatabaseSync;
}

async function readGeoPackage(file) {
  const DatabaseSync = await loadSqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT table_name FROM gpkg_contents WHERE data_type = 'features'").all();
    if (!tables.length) throw new Error('postcodes: GeoPackage has no feature tables');
    const out = [];
    for (const { table_name } of tables) {
      const geom = db.prepare('SELECT column_name FROM gpkg_geometry_columns WHERE table_name = ?').get(table_name);
      const cols = db.prepare(`PRAGMA table_info("${table_name}")`).all().map((c) => c.name);
      const pcCol = cols.find((c) => /^(postcode|pc4|postcode4|pc4_code)$/i.test(c));
      if (!geom || !pcCol) continue;
      const rows = db.prepare(`SELECT "${pcCol}" AS postcode, "${geom.column_name}" AS geom FROM "${table_name}"`).all();
      for (const r of rows) {
        const postcode = String(r.postcode);
        if (!PC4.test(postcode) || !r.geom) continue;
        out.push({ postcode, points: parseGpkgGeometry(Buffer.from(r.geom)), properties: {} });
      }
    }
    if (!out.length) throw new Error('postcodes: no table with a postcode column and a geometry column');
    return out;
  } finally {
    db.close();
  }
}

function findPostcode(props) {
  for (const k of Object.keys(props || {})) {
    if (/^(postcode|pc4|postcode4|pc4_code)$/i.test(k) && PC4.test(String(props[k]))) return String(props[k]);
  }
  return null;
}

/** GeoPackage binary → flat list of [x, y] vertices (Z/M dropped). */
export function parseGpkgGeometry(buf) {
  if (buf[0] !== 0x47 || buf[1] !== 0x50) throw new Error('not a GeoPackage geometry blob');
  const flags = buf[3];
  const envelopeType = (flags >> 1) & 0x07;
  const envelopeSize = [0, 32, 48, 48, 64][envelopeType];
  if (envelopeSize === undefined) throw new Error('invalid GeoPackage envelope flag');
  if (flags & 0x10) return []; // empty geometry
  const points = [];
  parseWkb(buf, 8 + envelopeSize, points);
  return points;
}

/** Parses one WKB geometry starting at `offset`; returns the offset after it. */
export function parseWkb(buf, offset, points) {
  const little = buf[offset] === 1;
  const u32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const f64 = (o) => (little ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  let type = u32(offset + 1);
  let o = offset + 5;
  if (type & 0x20000000) { type &= ~0x20000000; o += 4; } // EWKB SRID
  const dims = 2 + (type >= 1000 && type < 2000 ? 1 : 0) + (type >= 2000 && type < 3000 ? 1 : 0) + (type >= 3000 ? 2 : 0);
  const base = type % 1000;
  const readPoint = () => { points.push([f64(o), f64(o + 8)]); o += 8 * dims; };
  const readRing = () => { const n = u32(o); o += 4; for (let i = 0; i < n; i++) readPoint(); };
  switch (base) {
    case 1: readPoint(); break;
    case 2: readRing(); break;
    case 3: { const rings = u32(o); o += 4; for (let i = 0; i < rings; i++) readRing(); break; }
    case 4: case 5: case 6: case 7: {
      const n = u32(o); o += 4;
      for (let i = 0; i < n; i++) o = parseWkb(buf, o, points);
      break;
    }
    default: throw new Error(`unsupported WKB geometry type ${type}`);
  }
  return o;
}

export function centroid(points) {
  const n = points.length;
  if (!n) return null;
  return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n];
}

/** Cell id for a centroid in either RD (metres) or WGS84 (degrees); auto-detected. */
export function cellForPoint([x, y]) {
  return Math.abs(x) > 360 || Math.abs(y) > 90 ? cellIdFromRD(x, y) : cellId(x, y);
}

/**
 * Place name per PC4 from the PDOK Locatieserver, cached on disk.
 * Returns Map<pc4, place>. Missing lookups are left out.
 */
export async function lookupPlaces(pc4s, { cacheFile, concurrency = 4, fetchImpl = fetch, log = () => {} } = {}) {
  const cache = cacheFile && fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  const todo = pc4s.filter((p) => !(p in cache));
  log(`place names: ${pc4s.length - todo.length} cached, ${todo.length} to look up`);
  let i = 0;
  let done = 0;
  const worker = async () => {
    while (i < todo.length) {
      const pc4 = todo[i++];
      const url = `https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=${pc4}&fq=type:postcode&rows=10&fl=postcode,woonplaatsnaam,gemeentenaam`;
      let name = null;
      for (let attempt = 0; attempt < 3 && name === null; attempt++) {
        try {
          const res = await fetchImpl(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json();
          const doc = (json.response?.docs || []).find((d) => String(d.postcode || '').startsWith(pc4));
          name = doc ? doc.woonplaatsnaam || doc.gemeentenaam || null : '';
        } catch (err) {
          if (attempt === 2) log(`place lookup failed for ${pc4}: ${err.message}`);
          else await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      if (name !== null) cache[pc4] = name;
      if (++done % 500 === 0) log(`place names: ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (cacheFile) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 0));
  }
  return new Map(Object.entries(cache).filter(([, v]) => v));
}

/** Build the postcodes table: PC4 → { cell, place }. */
export async function buildPostcodeTable(file, { places = true, cacheFile, fetchImpl, log = () => {}, warn = () => {} } = {}) {
  const features = await readPc4Features(file);
  const table = { _provenance: 'CBS Postcode statistieken, postcode-4 areas via PDOK (CC BY 4.0); centroid per PC4. Place names: PDOK Locatieserver (BAG).' };
  const entries = [];
  for (const f of features) {
    const c = centroid(f.points);
    if (!c) continue;
    const cell = cellForPoint(c);
    if (cell === null) { warn(`PC4 ${f.postcode} falls outside the grid`); continue; }
    entries.push([f.postcode, cell, f.properties]);
  }
  const names = places ? await lookupPlaces(entries.map((e) => e[0]), { cacheFile, fetchImpl, log }) : new Map();
  let unnamed = 0;
  for (const [pc4, cell, props] of entries) {
    const place = names.get(pc4) || props.woonplaatsnaam || props.gemeentenaam || null;
    if (!place) unnamed++;
    table[pc4] = { cell, place: place || pc4 };
  }
  if (unnamed) warn(`${unnamed} of ${entries.length} postcodes have no place name; the card will show the postcode instead`);
  return table;
}
