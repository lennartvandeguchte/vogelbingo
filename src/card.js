// Vogelbingo card generator. DOM-free: runs unchanged in the browser and in Node.
// Everything here is deterministic. Math.random is never called.

export const ALGORITHM_VERSION = 'v1';
export const CARD_SIZE = 24; // 5x5 minus the free centre cell
export const MIN_POOL = 24;
export const CONVERGENCE_POOL = 45; // below this the tiers draw from nearly the same birds
export const NORMAAL_DEPTH = 48; // normaal never reaches below this rank; expert uses the whole pool
export const TIERS = ['makkelijk', 'normaal', 'expert'];
export const MONTHS_NL = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december',
];

/** FNV-1a, 32-bit. Stable across engines; the seed for every card. */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG. Returns a function producing floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle of a copy of `arr`, driven by `rng`. */
export function shuffle(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Draw `n` distinct items from `candidates` (in rank order) using `rng`. */
function draw(candidates, n, rng) {
  if (candidates.length < n) {
    throw new Error(`draw: need ${n} candidates, have ${candidates.length}`);
  }
  return shuffle(candidates, rng).slice(0, n);
}

/**
 * Normalise a Dutch postcode to its four digits, or return null.
 * Accepts "1012", "1012 AB", "1012ab"; rejects "0123", "10 12", "".
 */
export function normalisePostcode(input) {
  if (typeof input !== 'string') return null;
  const m = /^\s*([1-9][0-9]{3})\s*(?:[A-Za-z]{2})?\s*$/.exec(input);
  return m ? m[1] : null;
}

/**
 * Resolve a postcode against the bundled PC4 table.
 * @returns {{ok:true, pc4:string, cell:number, place:string} | {ok:false, code:'malformed'|'unknown'}}
 */
export function resolvePostcode(input, postcodes) {
  const pc4 = normalisePostcode(input);
  if (!pc4) return { ok: false, code: 'malformed' };
  const entry = postcodes[pc4];
  if (!entry) return { ok: false, code: 'unknown' };
  return { ok: true, pc4, cell: entry.cell, place: entry.place };
}

/**
 * Look up the ranked pool for a cell and month (1-12).
 * Falls back to the national list (confidence 9) when the cell is missing.
 * @returns {{pool:number[], confidence:number}}  pool = birds.json indexes in rank order
 */
export function poolFor(grid, cell, month) {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`poolFor: month must be 1-12, got ${month}`);
  }
  const cellData = grid.cells[String(cell)];
  const entry = cellData ? cellData.months[month - 1] : grid.national.months[month - 1];
  const confidence = cellData ? entry.confidence : 9;
  return { pool: entry.pool.slice(), confidence };
}

/**
 * Split ranks 0..P-1 into thirds A, B, C. A and B get floor(P/3), C the rest,
 * so every band has at least 8 ranks whenever P >= 24.
 */
export function bands(poolSize) {
  const third = Math.floor(poolSize / 3);
  const a = [];
  const b = [];
  const c = [];
  for (let i = 0; i < poolSize; i++) {
    if (i < third) a.push(i);
    else if (i < 2 * third) b.push(i);
    else c.push(i);
  }
  return { a, b, c };
}

/**
 * Pick 24 rank indexes from a pool of size P for a tier.
 * Ranks are 0-based positions in the ranked pool.
 */
export function selectRanks(poolSize, tier, rng) {
  if (!TIERS.includes(tier)) throw new Error(`selectRanks: unknown tier "${tier}"`);
  if (poolSize < MIN_POOL) {
    throw new Error(`selectRanks: pool has ${poolSize} species, need ${MIN_POOL}`);
  }
  if (tier === 'makkelijk') {
    return shuffle(Array.from({ length: CARD_SIZE }, (_, i) => i), rng);
  }
  if (tier === 'normaal') {
    // Thirds of the top 48 ranks: 16 from the top two thirds, 8 from the bottom two thirds, no overlap.
    const { a, b, c } = bands(Math.min(poolSize, NORMAAL_DEPTH));
    const top = draw(a.concat(b), 16, rng);
    const taken = new Set(top);
    const rest = b.concat(c).filter((r) => !taken.has(r));
    const bottom = draw(rest, 8, rng);
    return shuffle(top.concat(bottom), rng);
  }
  // expert: 8 from each third of the whole pool
  const { a, b, c } = bands(poolSize);
  const picks = draw(a, 8, rng).concat(draw(b, 8, rng), draw(c, 8, rng));
  return shuffle(picks, rng);
}

/** Canonical seed string. The pack fields are omitted for free cards. */
export function seedString({ cell, month, tier, packSeed, index }) {
  const parts = [ALGORITHM_VERSION, cell, month, tier];
  if (packSeed !== undefined) parts.push(packSeed, index);
  return parts.join('|');
}

/**
 * Generate one card.
 * @param {object} args
 * @param {object} args.grid  parsed data/grid.json
 * @param {number} args.cell  cell id
 * @param {number} args.month 1-12
 * @param {string} args.tier  one of TIERS
 * @param {string} [args.packSeed] pack seed (paid tier)
 * @param {number} [args.index] card index within the pack
 * @returns {{cells: (number|null)[], species:number[], confidence:number, poolSize:number, converged:boolean, seed:string}}
 *   `cells` is 25 entries in reading order; the centre is null (free space).
 *   `species` are indexes into birds.json.
 */
export function generateCard({ grid, cell, month, tier, packSeed, index }) {
  const { pool, confidence } = poolFor(grid, cell, month);
  const seed = seedString({ cell, month, tier, packSeed, index });
  const rng = mulberry32(fnv1a32(seed));
  const ranks = selectRanks(pool.length, tier, rng);
  const species = ranks.map((r) => pool[r]);
  if (new Set(species).size !== CARD_SIZE) {
    throw new Error('generateCard: duplicate species on one card');
  }
  const cells = [];
  let k = 0;
  for (let i = 0; i < 25; i++) {
    cells.push(i === 12 ? null : species[k++]);
  }
  return {
    cells,
    species,
    confidence,
    poolSize: pool.length,
    converged: pool.length < CONVERGENCE_POOL,
    seed,
  };
}

/**
 * Generate N cards with distinct layouts sharing one pool, plus the caller's
 * sheet (the union of every species on every card, in pool rank order).
 * Species sets may overlap by design: a sighting counts for every player.
 */
export function generatePack({ grid, cell, month, tier, packSeed, count }) {
  if (!Number.isInteger(count) || count < 1) throw new Error('generatePack: count must be >= 1');
  const cards = [];
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    let card;
    let attempt = 0;
    do {
      card = generateCard({ grid, cell, month, tier, packSeed, index: i + 1000 * attempt });
      attempt++;
      if (attempt > 50) throw new Error('generatePack: could not find a distinct card');
    } while (seen.has(card.cells.join(',')));
    seen.add(card.cells.join(','));
    cards.push(card);
  }
  const { pool } = poolFor(grid, cell, month);
  const onCards = new Set(cards.flatMap((c) => c.species));
  const callerSheet = pool.filter((s) => onCards.has(s));
  return { cards, callerSheet };
}
