import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCard, renderCallerSheet, escapeHtml } from '../src/render.js';

const birds = Array.from({ length: 30 }, (_, i) => ({ nameNl: `Vogel ${i}`, scientificName: `Genus species${i}`, image: null }));
const card = { cells: Array.from({ length: 25 }, (_, i) => (i === 12 ? null : i < 12 ? i : i - 1)), species: [], confidence: 1, converged: false, seed: 'v1|1|5|normaal' };

test('escapes user-visible strings', () => {
  assert.equal(escapeHtml('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');
  const html = renderCard(card, birds, { place: '<script>', month: 5, tier: 'normaal', datasetVersion: 'x', source: 'seed' });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renders 24 bird cells, one free cell, and the notes', () => {
  const html = renderCard(card, birds, { place: 'Amsterdam', month: 5, tier: 'normaal', datasetVersion: 'seed-x', source: 'seed', radiusKm: 15 });
  assert.equal((html.match(/class="cell cell--noimage"/g) || []).length, 24);
  assert.equal((html.match(/cell--free/g) || []).length, 1);
  assert.ok(html.includes('Amsterdam · mei · Normaal'));
  assert.ok(html.includes('~15 km'));
  assert.ok(html.includes('Voorlopige gegevens'));
});

test('typographic fallback when a bird has no image, img when it has', () => {
  const withImg = birds.map((b, i) => (i === 0 ? { ...b, image: 'assets/plates/x.jpg' } : b));
  const html = renderCard(card, withImg, { place: 'A', month: 1, tier: 'expert', datasetVersion: 'x', source: 'gbif' });
  assert.ok(html.includes('<img class="plate" src="assets/plates/x.jpg"'));
  assert.ok(html.includes('GBIF.org occurrence download x, CC BY 4.0'));
});

test('caller sheet lists every bird', () => {
  const html = renderCallerSheet([2, 0], birds);
  assert.ok(html.includes('Vogel 2'));
  assert.ok(html.includes('Vogel 0'));
});
