// Golden card: 1012 (Amsterdam) / mei / normaal. Pinned so silent drift in the
// algorithm or the dataset is caught. Update the fixture deliberately when either changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateCard, resolvePostcode } from '../src/card.js';

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));

test('golden card 1012 / mei / normaal matches the fixture', () => {
  const grid = read('../data/grid.json');
  const birds = read('../data/birds.json');
  const postcodes = read('../data/postcodes.json');
  const golden = read('./fixtures/golden-1012-mei-normaal.json');
  const loc = resolvePostcode('1012', postcodes);
  assert.equal(loc.ok, true);
  assert.equal(loc.place, golden.place);
  const card = generateCard({ grid, cell: loc.cell, month: 5, tier: 'normaal' });
  assert.equal(card.seed, golden.seed);
  assert.equal(grid.datasetVersion, golden.datasetVersion);
  assert.deepEqual(card.cells.map((i) => (i === null ? null : birds[i].nameNl)), golden.names);
});

test('every postcode cell exists in the grid with 12 months of 24+ species', () => {
  const grid = read('../data/grid.json');
  const postcodes = read('../data/postcodes.json');
  const cells = new Set(Object.entries(postcodes).filter(([k]) => /^\d{4}$/.test(k)).map(([, v]) => v.cell));
  for (const cell of cells) {
    const c = grid.cells[cell];
    assert.ok(c, `cell ${cell} missing from grid`);
    assert.equal(c.months.length, 12);
    for (const m of c.months) assert.ok(m.pool.length >= 24, `cell ${cell} short pool`);
  }
});
