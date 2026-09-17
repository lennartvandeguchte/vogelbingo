#!/usr/bin/env node
// Validates data/birds.json and prints the plate coverage report.
//   node scripts/check-manifest.mjs                 # warn on missing plates
//   node scripts/check-manifest.mjs --require-images  # fail on missing plates (turn on once curation is done)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATE_SIZE = 600;
const requireImages = process.argv.includes('--require-images');

export function jpegDimensions(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/** Returns a list of problems (empty = valid). */
export function validateManifest(birds, { root = ROOT, requireImages = false } = {}) {
  const problems = [];
  const seenSci = new Set();
  const seenImg = new Set();
  birds.forEach((b, i) => {
    const tag = `#${i} ${b.scientificName || '?'}`;
    if (!b.scientificName || !/^[A-Z][a-z]+ [a-z]+$/.test(b.scientificName)) problems.push(`${tag}: scientificName missing or not "Genus species"`);
    if (!b.nameNl) problems.push(`${tag}: nameNl missing`);
    if (seenSci.has(b.scientificName)) problems.push(`${tag}: duplicate scientificName`);
    seenSci.add(b.scientificName);
    if (b.image) {
      if (seenImg.has(b.image)) problems.push(`${tag}: image path used twice`);
      seenImg.add(b.image);
      const file = path.join(root, b.image);
      if (!fs.existsSync(file)) {
        problems.push(`${tag}: image file ${b.image} not on disk`);
      } else {
        const dim = jpegDimensions(fs.readFileSync(file));
        if (!dim) problems.push(`${tag}: ${b.image} is not a JPEG`);
        else if (dim.width !== PLATE_SIZE || dim.height !== PLATE_SIZE) problems.push(`${tag}: ${b.image} is ${dim.width}x${dim.height}, expected ${PLATE_SIZE}x${PLATE_SIZE}`);
      }
      if (!b.license) problems.push(`${tag}: image without license`);
      if (!b.source) problems.push(`${tag}: image without source URL`);
    } else if (requireImages) {
      problems.push(`${tag}: no image`);
    }
  });
  return problems;
}

/** Manifest species without a plate, ranked by how many cell-month top-40s they appear in. */
export function coverageReport(birds, grid) {
  const hits = new Map();
  for (const cell of Object.values(grid.cells)) {
    for (const m of cell.months) {
      for (const idx of m.pool.slice(0, 40)) hits.set(idx, (hits.get(idx) || 0) + 1);
    }
  }
  return birds
    .map((b, i) => ({ nameNl: b.nameNl, scientificName: b.scientificName, hasImage: !!b.image, top40: hits.get(i) || 0 }))
    .filter((r) => !r.hasImage)
    .sort((a, b) => b.top40 - a.top40);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const birds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/birds.json'), 'utf8'));
  const problems = validateManifest(birds, { requireImages });
  for (const p of problems) console.error(`[check-manifest] ${p}`);
  const withImage = birds.filter((b) => b.image).length;
  console.log(`[check-manifest] ${birds.length} species, ${withImage} with a plate`);
  const gridFile = path.join(ROOT, 'data/grid.json');
  if (fs.existsSync(gridFile)) {
    const grid = JSON.parse(fs.readFileSync(gridFile, 'utf8'));
    const report = coverageReport(birds, grid);
    if (report.length) {
      console.log(`[check-manifest] next plates to source (top-40 appearances across cell-months):`);
      for (const r of report.slice(0, 15)) console.log(`  ${String(r.top40).padStart(5)}  ${r.nameNl} (${r.scientificName})`);
      if (report.length > 15) console.log(`  … and ${report.length - 15} more`);
    }
  }
  const extra = path.join(ROOT, '.cache/coverage.json');
  if (fs.existsSync(extra)) {
    const gbif = JSON.parse(fs.readFileSync(extra, 'utf8'));
    console.log(`[check-manifest] species in the GBIF export but not in the manifest (top 10):`);
    for (const r of gbif.slice(0, 10)) console.log(`  ${String(r.cellMonths).padStart(5)} cell-months  ${r.scientificName}`);
  }
  process.exit(problems.length ? 1 : 0);
}
