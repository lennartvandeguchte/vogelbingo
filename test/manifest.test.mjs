import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateManifest, coverageReport, jpegDimensions } from '../scripts/check-manifest.mjs';

const birds = JSON.parse(fs.readFileSync(new URL('../data/birds.json', import.meta.url), 'utf8'));

test('the committed manifest is valid', () => {
  assert.deepEqual(validateManifest(birds), []);
  assert.ok(birds.length >= 60);
});

test('duplicates and bad names are reported', () => {
  const bad = [
    { scientificName: 'Turdus merula', nameNl: 'Merel' },
    { scientificName: 'Turdus merula', nameNl: 'Merel' },
    { scientificName: 'merel', nameNl: '' },
  ];
  const p = validateManifest(bad);
  assert.ok(p.some((x) => x.includes('duplicate')));
  assert.ok(p.some((x) => x.includes('Genus species')));
  assert.ok(p.some((x) => x.includes('nameNl')));
});

test('image rules: file must exist, be 600x600 JPEG, carry licence and source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-'));
  // minimal JPEG header with SOF0 declaring 600x600
  const sof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x02, 0x58, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
  fs.writeFileSync(path.join(dir, 'ok.jpg'), sof);
  assert.deepEqual(jpegDimensions(sof), { width: 600, height: 600 });
  const entries = [
    { scientificName: 'Turdus merula', nameNl: 'Merel', image: 'ok.jpg', license: 'PD', source: 'https://x' },
    { scientificName: 'Parus major', nameNl: 'Koolmees', image: 'missing.jpg', license: 'PD', source: 'https://x' },
    { scientificName: 'Pica pica', nameNl: 'Ekster', image: 'ok.jpg' },
  ];
  const p = validateManifest(entries, { root: dir });
  assert.ok(p.some((x) => x.includes('not on disk')));
  assert.ok(p.some((x) => x.includes('used twice')));
  assert.ok(p.some((x) => x.includes('without license')));
  assert.equal(validateManifest(entries.slice(0, 1), { root: dir }).length, 0);
  assert.ok(validateManifest([{ scientificName: 'Pica pica', nameNl: 'Ekster', image: null }], { requireImages: true })[0].includes('no image'));
});

test('coverage report ranks unillustrated species by top-40 appearances', () => {
  const grid = { cells: { 1: { months: [{ pool: [2, 0, 1] }, { pool: [2] }] } } };
  const r = coverageReport([{ nameNl: 'a', scientificName: 'A a' }, { nameNl: 'b', scientificName: 'B b' }, { nameNl: 'c', scientificName: 'C c', image: 'x' }], grid);
  assert.deepEqual(r.map((x) => [x.nameNl, x.top40]), [['a', 1], ['b', 1]]);
});
