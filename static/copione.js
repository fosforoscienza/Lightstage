'use strict';

/* ---------------------------------------------------------------- copione
   Pagina con il PDF del copione a destra e, a sinistra, una timeline che
   scorre insieme alle pagine. Sulla timeline si appuntano i preset luci:
   un clic li prepara, la barra spaziatrice li manda in onda. */

let copioneCorrente = null;   // id del progetto aperto
let pdfUrlCorrente = null;    // indirizzo temporaneo del PDF in uso
let renderToken = 0;          // annulla un rendering ancora in corso
let pdfLib = null;            // PDF.js, caricato solo alla prima apertura

const copioneEl = () => $('#copione');
const copioneAperto = () => !copioneEl().classList.contains('hidden');

function copioneById(id) {
  return (state.copioni || []).find((c) => c.id === id) || null;
}

function copioneAttivo() {
  return copioneById(copioneCorrente);
}

/* ------------------------------------------------------------- progetti */
function renderCopioneSelect() {
  const sel = $('#copione-select');
  sel.innerHTML = '';
  for (const c of state.copioni || []) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    sel.append(o);
  }
  if (copioneCorrente !== null) sel.value = String(copioneCorrente);
  const nessuno = !(state.copioni || []).length;
  sel.classList.toggle('hidden', nessuno);
  $('#btn-copione-rename').classList.toggle('hidden', nessuno);
  $('#btn-copione-del').classList.toggle('hidden', nessuno);
  $('#copione-pdf').previousElementSibling?.classList?.toggle('hidden', nessuno);
}

async function nuovoCopione() {
  const nome = prompt('Nome del progetto:', `Copione ${(state.copioni || []).length + 1}`);
  if (nome === null) return;
  const res = await api('POST', '/api/copioni', { name: nome.trim() || 'Copione' });
  state.copioni = res.copioni;
  await apriCopione(res.copione.id);
}

async function salvaCue(copione) {
  const res = await api('PUT', `/api/copioni/${copione.id}`, { cues: copione.cues });
  state.copioni = res.copioni;
}

/* --------------------------------------------------------------- il PDF */
async function caricaPdfLib() {
  if (pdfLib) return pdfLib;
  // indirizzo assoluto: l'import dinamico non accetta percorsi "nudi"
  const base = new URL(window.LIGHTSTAGE_STATIC ? '../static/vendor/' : './vendor/',
                       location.href).href;
  pdfLib = await import(`${base}pdf.min.mjs`);
  pdfLib.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
  return pdfLib;
}

/* il PDF sta sul server (versione Python) o in IndexedDB (versione web) */
async function pdfDelCopione(id) {
  if (window.LIGHTSTAGE_PDF) {
    const blob = await window.LIGHTSTAGE_PDF.leggi(id);
    return blob ? URL.createObjectURL(blob) : null;
  }
  const res = await fetch(`/api/copioni/${id}/pdf`, { cache: 'no-store' });
  return res.ok ? `/api/copioni/${id}/pdf` : null;
}

async function inviaPdf(id, file) {
  if (window.LIGHTSTAGE_PDF) {
    await window.LIGHTSTAGE_PDF.salva(id, file);
    const res = await api('PUT', `/api/copioni/${id}/pdf`);
    state.copioni = res.copioni;
    return;
  }
  const res = await fetch(`/api/copioni/${id}/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: file,
  });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error || 'caricamento fallito');
  state.copioni = out.copioni;
}

/* disegna tutte le pagine una dopo l'altra, senza bloccare l'interfaccia */
async function mostraPdf(url) {
  const token = ++renderToken;
  const pagine = $('#copione-pages');
  pagine.innerHTML = '<div id="copione-vuoto" class="small">Apertura del PDF…</div>';
  if (!url) {
    pagine.innerHTML = '<div id="copione-vuoto" class="small">Nessun PDF caricato. '
      + 'Usa <b>📄 PDF</b> qui sopra per aprire il copione.</div>';
    return;
  }
  try {
    const lib = await caricaPdfLib();
    const doc = await lib.getDocument(url).promise;
    if (token !== renderToken) return;
    pagine.innerHTML = '';
    // come Anteprima: la pagina riempie la colonna ma non oltre una misura
    // comoda da leggere, e resta centrata
    const larghezza = Math.max(320, Math.min(900, pagine.clientWidth - 40));
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      if (token !== renderToken) return;
      const base = page.getViewport({ scale: 1 });
      const scala = larghezza / base.width;
      const vp = page.getViewport({ scale: scala * (window.devicePixelRatio || 1) });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      canvas.style.width = `${larghezza}px`;
      canvas.style.height = `${base.height * scala}px`;
      pagine.append(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      if (token !== renderToken) return;
    }
  } catch (err) {
    pagine.innerHTML = `<div id="copione-vuoto" class="small">PDF non leggibile: ${err.message}</div>`;
  }
}

/* ------------------------------------------------------------- timeline */
function renderCues() {
  const wrap = $('#copione-cues');
  wrap.innerHTML = '';
  const c = copioneAttivo();
  if (!c) return;
  for (const cue of c.cues) {
    const p = state.presets[cue.preset];
    const el = document.createElement('div');
    el.className = 'tl-cue';
    el.style.top = `${cue.pos * 100}%`;
    if (cue.preset === activePreset) el.classList.add('live');
    if (cue.preset === armedPreset) el.classList.add('armed');

    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = cue.preset + 1;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p ? p.name : '(preset vuoto)';
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Togli dal copione';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      c.cues = c.cues.filter((q) => q.id !== cue.id);
      renderCues();
      await salvaCue(c);
    });

    el.append(n, nm, del);
    el.title = p ? `Prepara "${p.name}" — poi barra spaziatrice` : 'Preset vuoto';
    el.addEventListener('click', () => {
      if (!p) return;
      armedPreset = armedPreset === cue.preset ? null : cue.preset;
      syncCueUI();
    });
    wrap.append(el);
  }
}

/* elenco dei preset salvati, per scegliere cosa inserire */
function scegliPreset() {
  return new Promise((risolvi) => {
    const lista = $('#pick-list');
    lista.innerHTML = '';
    const pieni = state.presets
      .map((p, i) => ({ p, i }))
      .filter((x) => x.p);
    if (!pieni.length) {
      lista.innerHTML = '<p class="small">Non hai ancora salvato nessun preset: '
        + 'creane uno dalla barra dei preset o dalla Preset grid.</p>';
    }
    for (const { p, i } of pieni) {
      const b = document.createElement('button');
      b.className = 'pick-item';
      const cv = document.createElement('canvas');
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = i + 1;
      const nm = document.createElement('span');
      nm.textContent = p.name;
      b.append(cv, n, nm);
      b.addEventListener('click', () => {
        closeModals();
        risolvi(i);
      });
      lista.append(b);
      requestAnimationFrame(() => drawPresetThumb(cv, p));
    }
    const annulla = () => risolvi(null);
    $('#modal-pick').classList.remove('hidden');
    $('#modal-pick').querySelector('.modal-close').addEventListener('click', annulla, { once: true });
  });
}

async function aggiungiCue(pos) {
  const c = copioneAttivo();
  if (!c) return;
  const slot = await scegliPreset();
  if (slot === null) return;
  const id = Math.max(0, ...c.cues.map((q) => q.id)) + 1;
  c.cues.push({ id, pos, preset: slot });
  c.cues.sort((a, b) => a.pos - b.pos);
  renderCues();
  await salvaCue(c);
}

/* ------------------------------------------------- preset in onda/pronto */
function updateCopioneCues() {
  renderCues();
  const live = activePreset !== null ? state.presets[activePreset] : null;
  $('#copione-live-name').textContent = live ? live.name : '—';
  drawPresetThumb($('#copione-live-thumb'), live);
  const armed = armedPreset !== null ? state.presets[armedPreset] : null;
  $('#copione-armed-box').classList.toggle('hidden', !armed);
  if (armed) {
    $('#copione-armed-name').textContent = armed.name;
    drawPresetThumb($('#copione-armed-thumb'), armed);
  }
}

/* ------------------------------------------------------ apri e chiudi */
async function apriCopione(id) {
  copioneCorrente = id;
  renderCopioneSelect();
  renderCues();
  updateCopioneCues();
  if (pdfUrlCorrente && pdfUrlCorrente.startsWith('blob:')) {
    URL.revokeObjectURL(pdfUrlCorrente);
  }
  pdfUrlCorrente = null;
  const c = copioneAttivo();
  if (!c) {
    $('#copione-pages').innerHTML = '<div id="copione-vuoto" class="small">'
      + 'Crea un progetto con <b>+ Progetto</b> per iniziare.</div>';
    return;
  }
  pdfUrlCorrente = c.pdf ? await pdfDelCopione(c.id) : null;
  await mostraPdf(pdfUrlCorrente);
}

async function openCopione() {
  copioneEl().classList.remove('hidden');
  $('#app-version-copione').textContent = `v${APP_VERSION}`;
  if (copioneCorrente === null && (state.copioni || []).length) {
    await apriCopione(state.copioni[0].id);
  } else {
    await apriCopione(copioneCorrente);
  }
}

function closeCopione() {
  copioneEl().classList.add('hidden');
  renderToken++;   // ferma un eventuale rendering in corso
}

/* --------------------------------------------------------------- eventi */
$('#btn-copione').addEventListener('click', () => openCopione().catch(console.error));
$('#btn-copione-close').addEventListener('click', closeCopione);
$('#btn-copione-new').addEventListener('click', () => nuovoCopione().catch(console.error));
$('#copione-select').addEventListener('change', (e) => {
  apriCopione(parseInt(e.target.value, 10)).catch(console.error);
});

$('#btn-copione-rename').addEventListener('click', async () => {
  const c = copioneAttivo();
  if (!c) return;
  const nome = prompt('Nuovo nome del progetto:', c.name);
  if (nome === null) return;
  const res = await api('PUT', `/api/copioni/${c.id}`, { name: nome.trim() || c.name });
  state.copioni = res.copioni;
  renderCopioneSelect();
});

$('#btn-copione-del').addEventListener('click', async () => {
  const c = copioneAttivo();
  if (!c || !confirm(`Eliminare il progetto "${c.name}"? Il PDF e i preset segnati andranno persi.`)) return;
  const res = await api('DELETE', `/api/copioni/${c.id}`);
  state.copioni = res.copioni;
  copioneCorrente = state.copioni.length ? state.copioni[0].id : null;
  await apriCopione(copioneCorrente);
});

$('#copione-pdf').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const c = copioneAttivo();
  if (!file || !c) return;
  try {
    await inviaPdf(c.id, file);
    await apriCopione(c.id);
  } catch (err) {
    alert('Caricamento del PDF fallito: ' + (err.message || err));
  }
});

/* clic sulla linea: inserisce un preset in quel punto */
$('#copione-timeline').addEventListener('click', (e) => {
  if (e.target.closest('.tl-cue')) return;   // clic su un preset già presente
  const c = copioneAttivo();
  if (!c) return;
  const r = e.currentTarget.getBoundingClientRect();
  const pos = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
  aggiungiCue(pos).catch(console.error);
});
