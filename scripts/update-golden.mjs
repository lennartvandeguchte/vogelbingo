#!/usr/bin/env node
// Regenerates test/fixtures/golden-1012-mei-normaal.json from the committed dataset.
// Run this deliberately after a dataset or algorithm change, then review the diff.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCard, resolvePostcode } from '../src/card.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const grid = read('data/grid.json');
const birds = read('data/birds.json');
const postcodes = read('data/postcodes.json');
const loc = resolvePostcode('1012', postcodes);
if (!loc.ok) throw new Error('postcode 1012 not in data/postcodes.json');
const card = generateCard({ grid, cell: loc.cell, month: 5, tier: 'normaal' });
const fixture = {
  datasetVersion: grid.datasetVersion,
  place: loc.place,
  cell: loc.cell,
  seed: card.seed,
  names: card.cells.map((i) => (i === null ? null : birds[i].nameNl)),
};
const file = path.join(ROOT, 'test/fixtures/golden-1012-mei-normaal.json');
fs.writeFileSync(file, JSON.stringify(fixture, null, 1) + '\n');
console.log(`[update-golden] ${loc.place} · mei · normaal (dataset ${grid.datasetVersion}, pool ${card.poolSize}, confidence ${card.confidence})`);
console.log('  ' + fixture.names.filter(Boolean).join(', '));
