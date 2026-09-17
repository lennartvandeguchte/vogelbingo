// Renders a card to an HTML string. No DOM access; user-visible strings are escaped.
import { MONTHS_NL } from './card.js';

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const TIER_LABEL = { makkelijk: 'Makkelijk', normaal: 'Normaal', expert: 'Expert' };

/**
 * @param {object} card   result of generateCard
 * @param {object[]} birds data/birds.json
 * @param {object} meta   { place, month (1-12), tier, datasetVersion, source, radiusKm, credit, cardNumber }
 */
export function renderCard(card, birds, meta) {
  const cells = card.cells
    .map((idx, i) => {
      if (idx === null) {
        return `<div class="cell cell--free" aria-label="vrij vakje"><span class="free-mark">vogelbingo.nl</span><span class="free-sub">vrij</span></div>`;
      }
      const b = birds[idx];
      if (!b) throw new Error(`renderCard: no bird at index ${idx}`);
      const name = escapeHtml(b.nameNl);
      const sci = escapeHtml(b.scientificName);
      const picture = b.image
        ? `<img class="plate" src="${escapeHtml(b.image)}" alt="${name}" loading="lazy" onerror="this.parentElement.classList.add('cell--noimage');this.remove()">`
        : '';
      return `<div class="cell${b.image ? '' : ' cell--noimage'}" data-cell="${i}">${picture}<span class="name">${name}</span><span class="sci">${sci}</span></div>`;
    })
    .join('');

  const monthName = MONTHS_NL[meta.month - 1];
  const notes = [];
  if (meta.radiusKm) notes.push(`Gebaseerd op waarnemingen tot ~${meta.radiusKm} km rond deze postcode.`);
  if (card.confidence === 9) notes.push('Gebaseerd op landelijke waarnemingen.');
  if (card.converged) notes.push('Weinig verschil tussen niveaus in dit gebied.');
  if (meta.source === 'seed') notes.push('Voorlopige gegevens: geschatte soortenlijst, nog geen GBIF-waarnemingen.');

  const attribution =
    meta.source === 'gbif'
      ? `Waarnemingen: GBIF.org occurrence download ${escapeHtml(meta.datasetVersion)}, CC BY 4.0`
      : `Gegevens: ${escapeHtml(meta.datasetVersion)}`;
  const credit = meta.credit ? ` · Illustraties: ${escapeHtml(meta.credit)}, publiek domein` : '';
  const number = meta.cardNumber ? `<span class="card-number">kaart ${escapeHtml(meta.cardNumber)}</span>` : '';

  return (
    `<article class="card" data-seed="${escapeHtml(card.seed)}">` +
    `<header class="card-head"><h2 class="card-title">Vogelbingo</h2>` +
    `<p class="card-sub">${escapeHtml(meta.place)} · ${escapeHtml(monthName)} · ${escapeHtml(TIER_LABEL[meta.tier] || meta.tier)}${number}</p></header>` +
    `<div class="grid" role="table">${cells}</div>` +
    `<footer class="card-foot">${notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join('')}` +
    `<p class="attribution">${attribution}${credit} · vogelbingo.nl</p></footer>` +
    `</article>`
  );
}

/** The caller's sheet for a pack: every bird on any card, in pool order. */
export function renderCallerSheet(callerSheet, birds) {
  const items = callerSheet.map((idx) => `<li>${escapeHtml(birds[idx].nameNl)} <i>${escapeHtml(birds[idx].scientificName)}</i></li>`).join('');
  return `<section class="caller-sheet"><h2>Alle vogels in dit pakket</h2><ol>${items}</ol></section>`;
}
