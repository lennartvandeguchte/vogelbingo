// Turns per-cell species counts into the ranked, adaptive-radius grid.
// Pure functions so the build guard can be tested without a dataset.
import { ringCells, ringRadiusKm } from './rd.mjs';

export const MIN_RECORDS = 500; // measured: a rural January cell at 10 km had 61 records and was unusable
export const MAX_RING = 3; // ring 3 ≈ 35 km radius, ≈ the measured "stable" 60 km diameter
export const POOL_CAP = 90;
export const MIN_POOL = 24;
export const NATIONAL = 9;

/**
 * counts: Map<cellId, Array(12) of Map<speciesIdx, number>>
 * Returns Map<speciesIdx, number> summed over `cells` for `monthIdx`.
 */
function sumCells(counts, cells, monthIdx) {
  const acc = new Map();
  for (const id of cells) {
    const cell = counts.get(id);
    if (!cell) continue;
    const m = cell[monthIdx];
    if (!m) continue;
    for (const [sp, n] of m) acc.set(sp, (acc.get(sp) || 0) + n);
  }
  return acc;
}

function total(map) {
  let t = 0;
  for (const n of map.values()) t += n;
  return t;
}

export function rankPool(map) {
  return [...map.entries()]
    .filter(([, n]) => n > 0)
    .sort((x, y) => y[1] - x[1] || x[0] - y[0])
    .slice(0, POOL_CAP)
    .map(([sp]) => sp);
}

/** National ranking per month; the last-resort fallback. */
export function nationalPools(counts) {
  const all = [...counts.keys()];
  return Array.from({ length: 12 }, (_, m) => {
    const acc = sumCells(counts, all, m);
    return { confidence: NATIONAL, records: total(acc), pool: rankPool(acc) };
  });
}

/**
 * Resolve one cell-month with the adaptive radius.
 * Widens while records < MIN_RECORDS or the pool is short, up to MAX_RING,
 * then falls back to the national pool. Returns null when even that is short.
 */
export function resolveCellMonth(counts, cellId, monthIdx, national, opts = {}) {
  const minRecords = opts.minRecords ?? MIN_RECORDS;
  const maxRing = opts.maxRing ?? MAX_RING;
  let cells = [cellId];
  let acc = sumCells(counts, cells, monthIdx);
  let ring = 0;
  while (ring < maxRing && (total(acc) < minRecords || rankPool(acc).length < MIN_POOL)) {
    ring++;
    cells = cells.concat(ringCells(cellId, ring));
    acc = sumCells(counts, cells, monthIdx);
  }
  const pool = rankPool(acc);
  if (total(acc) >= minRecords && pool.length >= MIN_POOL) {
    return { confidence: ring, records: total(acc), pool };
  }
  const nat = national[monthIdx];
  if (nat.pool.length >= MIN_POOL) return { ...nat };
  return null;
}

/**
 * Build the grid for every inhabited cell.
 * @param counts Map<cellId, Array(12) of Map<speciesIdx, number>>
 * @param inhabited Set<cellId>  cells that have at least one postcode
 * @throws Error naming the first cell-month that cannot reach 24 species
 */
export function buildGrid(counts, inhabited, opts = {}) {
  const national = nationalPools(counts);
  const cells = {};
  const histogram = Array.from({ length: 12 }, () => ({}));
  const poolSizes = [];
  for (const id of [...inhabited].sort((a, b) => a - b)) {
    const months = [];
    for (let m = 0; m < 12; m++) {
      const r = resolveCellMonth(counts, id, m, national, opts);
      if (!r) {
        throw new Error(
          `Build guard: cell ${id}, month ${m + 1} cannot reach ${MIN_POOL} species even nationally. Refusing to ship a short card.`,
        );
      }
      months.push(r);
      histogram[m][r.confidence] = (histogram[m][r.confidence] || 0) + 1;
      poolSizes.push(r.pool.length);
    }
    cells[id] = { months };
  }
  for (let m = 0; m < 12; m++) {
    if (national[m].pool.length < MIN_POOL) {
      throw new Error(`Build guard: national pool for month ${m + 1} has ${national[m].pool.length} species.`);
    }
  }
  return { cells, national: { months: national }, histogram, poolSizes };
}

export function confidenceLabelKm(confidence) {
  if (confidence === NATIONAL) return null;
  return Math.round(ringRadiusKm(confidence));
}
