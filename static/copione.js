'use strict';

/* ---------------------------------------------------------------- copione
   Pagina con il PDF del copione a destra e, a sinistra, una timeline che
   scorre insieme alle pagine. Sulla timeline si appuntano i preset luci:
   un clic li prepara, la barra spaziatrice li manda in onda. */

let copioneCorrente = null;   // id del progetto aperto
let pdfUrlCorrente = null;    // indirizzo temporaneo del PDF in uso
let renderToken = 0;          // annulla un rendering ancora in corso
let pdfLib = null;            // PDF.js, caricato solo alla prima apertura
let osservatore = null;       // disegna le pagine solo quando servono

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

/* Prepara subito tutte le pagine con la misura giusta (così la timeline è
   alta quanto il copione), ma le disegna solo quando stanno per entrare in
   vista e le libera quando si allontanano: un copione di cento pagine non
   riempie la memoria del browser. */
async function mostraPdf(url) {
  const token = ++renderToken;
  const pagine = $('#copione-pages');
  if (osservatore) { osservatore.disconnect(); osservatore = null; }
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
    const nitidezza = Math.min(2, window.devicePixelRatio || 1);

    // una pagina alla volta: serve la misura, il disegno viene dopo
    const tele = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      if (token !== renderToken) return;
      const base = page.getViewport({ scale: 1 });
      const scala = larghezza / base.width;
      const canvas = document.createElement('canvas');
      canvas.width = 0;    // finché non è disegnata non occupa memoria
      canvas.height = 0;
      canvas.style.width = `${larghezza}px`;
      canvas.style.height = `${base.height * scala}px`;
      pagine.append(canvas);
      tele.push({ canvas, page, vp: page.getViewport({ scale: scala * nitidezza }) });
    }

    const disegna = async (t) => {
      if (t.fatto || t.inCorso) return;
      t.inCorso = true;
      t.canvas.width = t.vp.width;
      t.canvas.height = t.vp.height;
      try {
        await t.page.render({ canvasContext: t.canvas.getContext('2d'), viewport: t.vp }).promise;
        if (token === renderToken) t.fatto = true;
      } finally {
        t.inCorso = false;
      }
    };
    const libera = (t) => {
      if (!t.fatto) return;
      t.canvas.width = 0;    // la misura in CSS resta, il contenuto si libera
      t.canvas.height = 0;
      t.fatto = false;
    };

    osservatore = new IntersectionObserver((voci) => {
      if (token !== renderToken) return;
      for (const v of voci) {
        const t = tele.find((x) => x.canvas === v.target);
        if (!t) continue;
        if (v.isIntersecting) disegna(t).catch(console.error);
        else libera(t);
      }
    }, { root: $('#copione-scroll'), rootMargin: '1200px 0px' });
    tele.forEach((t) => osservatore.observe(t.canvas));
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

    const thumb = document.createElement('canvas');
    thumb.className = 'tl-thumb';
    const testo = document.createElement('span');
    testo.className = 'tl-txt';
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = cue.preset + 1;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p ? p.name : '(preset vuoto)';
    testo.append(n, nm);
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

    el.append(thumb, testo, del);
    el.title = p
      ? `Prepara "${p.name}" — poi barra spaziatrice. Trascina per spostarlo nel copione.`
      : 'Preset vuoto';
    el.addEventListener('pointerdown', (e) => avviaTrascinamento(e, el, cue, c, p));
    wrap.append(el);
    requestAnimationFrame(() => drawPresetThumb(thumb, p));
  }
}

/* ----------------------------------------------- sposta un preset sulla linea
   Il pointerdown non decide subito: se il puntatore si muove di qualche pixel
   diventa un trascinamento, altrimenti al rilascio vale come clic (prepara). */
let trascinato = null;
let ultimaY = null;        // ultima posizione del puntatore, per lo scorrimento
let velocitaScorrimento = 0;
let timerScorrimento = null;

function posDaY(clientY) {
  const r = $('#copione-timeline').getBoundingClientRect();
  return Math.max(0, Math.min(1, (clientY - r.top) / r.height));
}

function spostaSegnaposto() {
  if (!trascinato || ultimaY === null) return;
  trascinato.pos = posDaY(ultimaY);
  trascinato.el.style.top = `${trascinato.pos * 100}%`;
}

/* vicino ai bordi la pagina scorre da sola, così si arriva ovunque */
function impostaScorrimento(v) {
  velocitaScorrimento = v;
  if (v && !timerScorrimento) {
    timerScorrimento = setInterval(() => {
      $('#copione-scroll').scrollTop += velocitaScorrimento;
      spostaSegnaposto();
    }, 16);
  } else if (!v && timerScorrimento) {
    clearInterval(timerScorrimento);
    timerScorrimento = null;
  }
}

function avviaTrascinamento(e, el, cue, c, p) {
  if (e.target.closest('.del') || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  trascinato = { el, cue, c, p, partenza: e.clientY, mosso: false, pos: cue.pos };
  ultimaY = e.clientY;
  el.setPointerCapture(e.pointerId);
  el.classList.add('dragging');
}

function duranteTrascinamento(e) {
  if (!trascinato) return;
  if (!trascinato.mosso && Math.abs(e.clientY - trascinato.partenza) < 4) return;
  trascinato.mosso = true;
  ultimaY = e.clientY;
  const r = $('#copione-scroll').getBoundingClientRect();
  if (e.clientY < r.top + 60) impostaScorrimento(-14);
  else if (e.clientY > r.bottom - 60) impostaScorrimento(14);
  else impostaScorrimento(0);
  spostaSegnaposto();
}

async function fineTrascinamento(e) {
  const t = trascinato;
  if (!t) return;
  trascinato = null;
  ultimaY = null;
  impostaScorrimento(0);
  t.el.classList.remove('dragging');
  if (t.el.hasPointerCapture?.(e.pointerId)) t.el.releasePointerCapture(e.pointerId);
  if (!t.mosso) {
    // era un clic: prepara il preset (riclic = annulla)
    if (!t.p) return;
    armedPreset = armedPreset === t.cue.preset ? null : t.cue.preset;
    syncCueUI();
    return;
  }
  t.cue.pos = t.pos;
  t.c.cues.sort((a, b) => a.pos - b.pos);
  renderCues();
  await salvaCue(t.c);
}

document.addEventListener('pointermove', duranteTrascinamento);
document.addEventListener('pointerup', (e) => fineTrascinamento(e).catch(console.error));
document.addEventListener('pointercancel', (e) => fineTrascinamento(e).catch(console.error));

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
  if (osservatore) { osservatore.disconnect(); osservatore = null; }
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
