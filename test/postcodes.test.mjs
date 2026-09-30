import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseGpkgGeometry, parseWkb, cellForPoint, readPc4Features, buildPostcodeTable, lookupPlaces } from '../scripts/lib/postcodes.mjs';

function wkbPolygon(ring, little = true) {
  const b = Buffer.alloc(1 + 4 + 4 + 4 + ring.length * 16);
  let o = 0;
  b[o++] = little ? 1 : 0;
  little ? b.writeUInt32LE(3, o) : b.writeUInt32BE(3, o); o += 4;
  little ? b.writeUInt32LE(1, o) : b.writeUInt32BE(1, o); o += 4;
  little ? b.writeUInt32LE(ring.length, o) : b.writeUInt32BE(ring.length, o); o += 4;
  for (const [x, y] of ring) {
    little ? b.writeDoubleLE(x, o) : b.writeDoubleBE(x, o); o += 8;
    little ? b.writeDoubleLE(y, o) : b.writeDoubleBE(y, o); o += 8;
  }
  return b;
}
function gpkgBlob(wkb) {
  const head = Buffer.from([0x47, 0x50, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]); // no envelope, little-endian srs
  return Buffer.concat([head, wkb]);
}
const amsterdam = [[121000, 487000], [122000, 487000], [122000, 488000], [121000, 488000], [121000, 487000]];

test('parses GeoPackage polygon blobs (both byte orders)', () => {
  assert.deepEqual(parseGpkgGeometry(gpkgBlob(wkbPolygon(amsterdam))), amsterdam);
  assert.deepEqual(parseGpkgGeometry(gpkgBlob(wkbPolygon(amsterdam, false))), amsterdam);
});

test('parses a MultiPolygon with Z coordinates', () => {
  const inner = wkbPolygon(amsterdam);
  const multi = Buffer.alloc(9);
  multi[0] = 1; multi.writeUInt32LE(6, 1); multi.writeUInt32LE(1, 5);
  const points = [];
  parseWkb(Buffer.concat([multi, inner]), 0, points);
  assert.equal(points.length, 5);
});

test('cellForPoint accepts RD metres and WGS84 degrees', () => {
  assert.equal(cellForPoint([121500, 487500]), 1812);
  assert.equal(cellForPoint([4.9, 52.37]), 1812);
});

test('reads a real GeoPackage file and builds the table without network', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-gpkg-'));
  const file = path.join(dir, 'pc4.gpkg');
  const blob = gpkgBlob(wkbPolygon(amsterdam)).toString('hex');
  execFileSync('python3', ['-c', `
import sqlite3
db = sqlite3.connect(${JSON.stringify(file)})
db.executescript('''
CREATE TABLE gpkg_contents(table_name TEXT, data_type TEXT);
CREATE TABLE gpkg_geometry_columns(table_name TEXT, column_name TEXT);
CREATE TABLE cbs_pc4_2023(fid INTEGER PRIMARY KEY, postcode TEXT, aantal_inwoners INTEGER, geom BLOB);
INSERT INTO gpkg_contents VALUES ('cbs_pc4_2023', 'features');
INSERT INTO gpkg_geometry_columns VALUES ('cbs_pc4_2023', 'geom');
''')
db.execute("INSERT INTO cbs_pc4_2023(postcode, aantal_inwoners, geom) VALUES (?, ?, ?)", ('1012', 100, bytes.fromhex(${JSON.stringify(blob)})))
db.execute("INSERT INTO cbs_pc4_2023(postcode, aantal_inwoners, geom) VALUES (?, ?, ?)", ('0000', 0, bytes.fromhex(${JSON.stringify(blob)})))
db.commit()
`]);
  const features = await readPc4Features(file);
  assert.equal(features.length, 1);
  assert.equal(features[0].postcode, '1012');
  const table = await buildPostcodeTable(file, { places: false });
  assert.deepEqual(table['1012'], { cell: 1812, place: '1012' });
});

test('reads GeoJSON in WGS84 with a place attribute', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-gj-'));
  const file = path.join(dir, 'pc4.geojson');
  fs.writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { postcode: '1012', gemeentenaam: 'Amsterdam' }, geometry: { type: 'Polygon', coordinates: [[[4.89, 52.37], [4.91, 52.37], [4.91, 52.38], [4.89, 52.37]]] } },
  ] }));
  const table = await buildPostcodeTable(file, { places: false });
  assert.deepEqual(table['1012'], { cell: 1812, place: 'Amsterdam' });
});

test('lookupPlaces uses the Locatieserver response and the cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-places-'));
  const cacheFile = path.join(dir, 'places.json');
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    const pc4 = new URL(url).searchParams.get('q');
    return { ok: true, json: async () => ({ response: { docs: [{ postcode: pc4 + 'AB', woonplaatsnaam: 'Plaats ' + pc4 }] } }) };
  };
  const a = await lookupPlaces(['1012', '3011'], { cacheFile, fetchImpl });
  assert.equal(a.get('1012'), 'Plaats 1012');
  assert.equal(calls, 2);
  const b = await lookupPlaces(['1012', '3011', '9711'], { cacheFile, fetchImpl });
  assert.equal(calls, 3, 'cached entries are not fetched again');
  assert.equal(b.size, 3);
});
