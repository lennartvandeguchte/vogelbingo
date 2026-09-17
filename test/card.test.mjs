import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fnv1a32, mulberry32, shuffle, normalisePostcode, resolvePostcode, bands, selectRanks,
  generateCard, generatePack, poolFor, CARD_SIZE, TIERS,
} from '../src/card.js';

function fakeGrid(poolSize, { confidence = 0 } = {}) {
  const pool = Array.from({ length: poolSize }, (_, i) => i);
  const months = Array.from({ length: 12 }, () => ({ confidence, records: 1000, pool }));
  return { cellSize: 10000, cells: { 1: { months } }, national: { months: months.map((m) => ({ ...m, confidence: 9 })) } };
}

test('fnv1a32 is stable', () => {
  assert.equal(fnv1a32(''), 0x811c9dc5);
  assert.equal(fnv1a32('a'), 0xe40c292c);
  assert.equal(fnv1a32('v1|1615|5|normaal'), fnv1a32('v1|1615|5|normaal'));
});

test('mulberry32 produces the same sequence for the same seed', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
});

test('shuffle is a permutation and does not mutate', () => {
  const src = [1, 2, 3, 4, 5, 6];
  const out = shuffle(src, mulberry32(7));
  assert.deepEqual(src, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(out.slice().sort(), src);
});

test('postcode normalisation', () => {
  assert.equal(normalisePostcode('1012'), '1012');
  assert.equal(normalisePostcode(' 1012 AB '), '1012');
  assert.equal(normalisePostcode('1012ab'), '1012');
  assert.equal(normalisePostcode('10 12'), null);
  assert.equal(normalisePostcode('0123'), null);
  assert.equal(normalisePostcode(''), null);
  assert.equal(normalisePostcode('1012ABC'), null);
  assert.equal(normalisePostcode(undefined), null);
});

test('resolvePostcode reports malformed and unknown', () => {
  const table = { 1012: { cell: 1615, place: 'Amsterdam' } };
  assert.deepEqual(resolvePostcode('1012 AB', table), { ok: true, pc4: '1012', cell: 1615, place: 'Amsterdam' });
  assert.deepEqual(resolvePostcode('abcd', table), { ok: false, code: 'malformed' });
  assert.deepEqual(resolvePostcode('9999', table), { ok: false, code: 'unknown' });
});

test('poolFor falls back to national with confidence 9', () => {
  const grid = fakeGrid(30);
  assert.equal(poolFor(grid, 1, 5).confidence, 0);
  assert.equal(poolFor(grid, 999, 5).confidence, 9);
  assert.throws(() => poolFor(grid, 1, 13));
});

test('bands split the pool into thirds', () => {
  const b = bands(24);
  assert.deepEqual([b.a.length, b.b.length, b.c.length], [8, 8, 8]);
  const c = bands(90);
  assert.deepEqual([c.a.length, c.b.length, c.c.length], [30, 30, 30]);
  const d = bands(25);
  assert.deepEqual([d.a.length, d.b.length, d.c.length], [8, 8, 9]);
  const e = bands(26);
  assert.deepEqual([e.a.length, e.b.length, e.c.length], [8, 8, 10]);
});

for (const P of [24, 25, 45, 90]) {
  for (const tier of TIERS) {
    test(`selectRanks draws 24 distinct ranks from the right bands (P=${P}, ${tier})`, () => {
      const ranks = selectRanks(P, tier, mulberry32(1));
      assert.equal(ranks.length, CARD_SIZE);
      assert.equal(new Set(ranks).size, CARD_SIZE);
      const { a, b, c } = bands(P);
      const inA = ranks.filter((r) => a.includes(r)).length;
      const inB = ranks.filter((r) => b.includes(r)).length;
      const inC = ranks.filter((r) => c.includes(r)).length;
      if (tier === 'makkelijk') assert.ok(ranks.every((r) => r < 24));
      if (tier === 'expert') assert.deepEqual([inA, inB, inC], [8, 8, 8]);
      if (tier === 'normaal') {
        const n = bands(Math.min(P, 48));
        const top = ranks.filter((r) => n.a.includes(r) || n.b.includes(r)).length;
        assert.ok(top >= 16, 'at least 16 from the top two thirds of the top 48');
        assert.ok(ranks.every((r) => r < 48), 'normaal never reaches below rank 48');
      }
    });
  }
}

test('selectRanks refuses a short pool', () => {
  assert.throws(() => selectRanks(23, 'normaal', mulberry32(1)), /need 24/);
});

test('generateCard: 24 species + free centre, deterministic, no Math.random', () => {
  const grid = fakeGrid(60);
  const orig = Math.random;
  Math.random = () => { throw new Error('Math.random called'); };
  try {
    const a = generateCard({ grid, cell: 1, month: 5, tier: 'normaal' });
    const b = generateCard({ grid, cell: 1, month: 5, tier: 'normaal' });
    assert.deepEqual(a, b);
    assert.equal(a.cells.length, 25);
    assert.equal(a.cells[12], null);
    assert.equal(new Set(a.species).size, 24);
    assert.equal(a.seed, 'v1|1|5|normaal');
    assert.equal(a.converged, false);
    const c = generateCard({ grid, cell: 1, month: 6, tier: 'normaal' });
    assert.notDeepEqual(a.cells, c.cells);
  } finally {
    Math.random = orig;
  }
});

test('generateCard flags convergence for small pools', () => {
  const card = generateCard({ grid: fakeGrid(30), cell: 1, month: 1, tier: 'expert' });
  assert.equal(card.converged, true);
});

test('generatePack: distinct cards, shared pool, exact caller sheet', () => {
  const grid = fakeGrid(40);
  const { cards, callerSheet } = generatePack({ grid, cell: 1, month: 5, tier: 'normaal', packSeed: 'abc', count: 6 });
  assert.equal(cards.length, 6);
  const layouts = new Set(cards.map((c) => c.cells.join(',')));
  assert.equal(layouts.size, 6);
  const union = new Set(cards.flatMap((c) => c.species));
  assert.deepEqual(callerSheet.slice().sort((x, y) => x - y), [...union].sort((x, y) => x - y));
  assert.ok(cards.every((c) => c.species.every((s) => s < 40)));
  assert.equal(cards[0].seed, 'v1|1|5|normaal|abc|0');
  const again = generatePack({ grid, cell: 1, month: 5, tier: 'normaal', packSeed: 'abc', count: 6 });
  assert.deepEqual(again.cards, cards);
});

test('generatePack retries on collision (pool of exactly 24, makkelijk)', () => {
  // With P = 24 every makkelijk card has the same species set, so distinctness is by layout only.
  const { cards } = generatePack({ grid: fakeGrid(24), cell: 1, month: 5, tier: 'makkelijk', packSeed: 'x', count: 3 });
  assert.equal(new Set(cards.map((c) => c.cells.join(','))).size, 3);
});
