import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, resolveCellMonth, nationalPools, rankPool } from '../scripts/lib/aggregate.mjs';
import { cellId, cellIdFromRD, ringCells, toRD } from '../scripts/lib/rd.mjs';

function cellCounts(perSpecies, nSpecies) {
  return Array.from({ length: 12 }, () => new Map(Array.from({ length: nSpecies }, (_, i) => [i, perSpecies])));
}

test('RD projection: Amersfoort Onze Lieve Vrouwetoren is near (155000, 463000)', () => {
  const [x, y] = toRD(5.387639, 52.155172);
  assert.ok(Math.abs(x - 155000) < 50, `x=${x}`);
  assert.ok(Math.abs(y - 463000) < 50, `y=${y}`);
});

test('cell ids: fixed origin, out of grid is null', () => {
  assert.equal(cellIdFromRD(155000, 463000), 16 * 100 + 15);
  assert.equal(cellIdFromRD(-1, 463000), null);
  assert.equal(cellIdFromRD(155000, 299999), null);
  assert.equal(cellId(4.9, 52.37), 1812); // Amsterdam centre: RD ≈ (121 km, 487 km) → row 18, col 12
  assert.equal(cellId(2.0, 52.0), null); // North Sea, west of the grid
});

test('ringCells: 8 neighbours at ring 1, clipped at the edge', () => {
  assert.equal(ringCells(1615, 1).length, 8);
  assert.equal(ringCells(1615, 2).length, 16);
  assert.equal(ringCells(0, 1).length, 3);
});

test('dense cell stays at ring 0', () => {
  const counts = new Map([[1615, cellCounts(50, 30)]]);
  const r = resolveCellMonth(counts, 1615, 0, nationalPools(counts));
  assert.equal(r.confidence, 0);
  assert.equal(r.pool.length, 30);
});

test('sparse cell widens until stable', () => {
  const counts = new Map([[1615, cellCounts(1, 30)]]);
  for (const id of ringCells(1615, 2)) counts.set(id, cellCounts(5, 30));
  const r = resolveCellMonth(counts, 1615, 0, nationalPools(counts));
  assert.equal(r.confidence, 2);
});

test('empty cell falls back to national with confidence 9', () => {
  const counts = new Map([[100, cellCounts(50, 30)]]);
  const r = resolveCellMonth(counts, 3227, 0, nationalPools(counts));
  assert.equal(r.confidence, 9);
});

test('rankPool sorts by count then index and caps at 90', () => {
  const m = new Map([[3, 5], [1, 9], [2, 5], [4, 0]]);
  assert.deepEqual(rankPool(m), [1, 2, 3]);
  const big = new Map(Array.from({ length: 120 }, (_, i) => [i, 1]));
  assert.equal(rankPool(big).length, 90);
});

test('build guard: fewer than 24 species anywhere fails the build', () => {
  const counts = new Map([[1615, cellCounts(50, 23)]]);
  assert.throws(() => buildGrid(counts, new Set([1615])), /Build guard/);
});

test('build guard passes with 24 species and records the histogram', () => {
  const counts = new Map([[1615, cellCounts(50, 24)]]);
  const grid = buildGrid(counts, new Set([1615]));
  assert.equal(grid.cells[1615].months.length, 12);
  assert.deepEqual(grid.histogram[0], { 0: 1 });
});
