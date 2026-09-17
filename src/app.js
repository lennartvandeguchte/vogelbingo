// Page wiring: load data, read the form, render, print.
import { generateCard, resolvePostcode, MONTHS_NL, TIERS } from './card.js';
import { renderCard } from './render.js';

const ERRORS = {
  malformed: 'Vul een Nederlandse postcode in (4 cijfers).',
  unknown: 'Deze postcode kennen we niet. Controleer de cijfers.',
  load: 'Kon de vogelgegevens niet laden. Probeer het later opnieuw.',
};

const form = document.getElementById('generator');
const button = form.querySelector('button[type=submit]');
const errorBox = document.getElementById('form-error');
const output = document.getElementById('output');
const monthSelect = form.elements.month;
const printButton = document.getElementById('print');

MONTHS_NL.forEach((name, i) => {
  const opt = document.createElement('option');
  opt.value = String(i + 1);
  opt.textContent = name;
  monthSelect.appendChild(opt);
});
monthSelect.value = String(new Date().getMonth() + 1);

async function fetchJson(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 1) throw err;
    }
  }
  throw new Error('unreachable');
}

let data = null;
const ready = (async () => {
  button.disabled = true;
  button.textContent = 'Even geduld…';
  try {
    const [grid, birds, postcodes] = await Promise.all([
      fetchJson('data/grid.json'),
      fetchJson('data/birds.json'),
      fetchJson('data/postcodes.json'),
    ]);
    data = { grid, birds, postcodes };
    button.disabled = false;
    button.textContent = 'Maak bingokaart';
  } catch (err) {
    console.error(err);
    showError(ERRORS.load);
    button.textContent = 'Maak bingokaart';
  }
})();

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = !msg;
}

function credit(birds, card) {
  const credits = new Set(card.species.map((i) => birds[i].credit).filter(Boolean));
  return [...credits].join('; ');
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  showError('');
  await ready;
  if (!data) {
    showError(ERRORS.load);
    return;
  }
  const loc = resolvePostcode(form.elements.postcode.value, data.postcodes);
  if (!loc.ok) {
    showError(ERRORS[loc.code]);
    form.elements.postcode.focus();
    return;
  }
  const month = Number(monthSelect.value);
  const tier = form.elements.tier.value;
  if (!TIERS.includes(tier)) return;
  const card = generateCard({ grid: data.grid, cell: loc.cell, month, tier });
  const radiusKm = card.confidence > 0 && card.confidence !== 9 ? Math.round((card.confidence + 0.5) * (data.grid.cellSize / 1000)) : 0;
  output.innerHTML = renderCard(card, data.birds, {
    place: loc.place,
    month,
    tier,
    datasetVersion: data.grid.datasetVersion,
    source: data.grid.source,
    radiusKm,
    credit: credit(data.birds, card),
  });
  output.hidden = false;
  printButton.hidden = false;
  const url = new URL(location.href);
  url.searchParams.set('postcode', loc.pc4);
  url.searchParams.set('maand', String(month));
  url.searchParams.set('niveau', tier);
  history.replaceState(null, '', url);
  output.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

printButton.addEventListener('click', () => window.print());

// Deep link: ?postcode=1012&maand=5&niveau=normaal
const params = new URLSearchParams(location.search);
if (params.get('postcode')) {
  form.elements.postcode.value = params.get('postcode');
  if (params.get('maand')) monthSelect.value = params.get('maand');
  if (TIERS.includes(params.get('niveau'))) form.elements.tier.value = params.get('niveau');
  ready.then(() => form.requestSubmit());
}
