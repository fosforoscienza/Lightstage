'use strict';

/* Versione dell'app, mostrata nel piè di pagina.
   Cambio strutturale -> primo numero, ritocchi -> secondo. Vedi CHANGELOG.md */
const APP_VERSION = '5.23';

/* ------------------------------------------------------------------ stato */
const state = {
  fixtures: [],
  presets: [],
  channels: [],
  copioni: [],
  blackout: false,
  // misure vere del palco, in metri (w = larghezza, d = profondità,
  // target = quota di quello che si vuole illuminare)
  stage: { w: 8, d: 6, target: 0 },
};
let dmx = { available: false, connected: false, port: null, ports: [], error: null };
let presetModificato = false;   // il preset in onda è stato ritoccato a mano
let selectedId = null;          // faro principale (maniglie e mirino)
let selectedIds = new Set();    // tutti i fari scelti insieme
let activePreset = null;
let lanUrl = null;

/* più dispositivi possono essere aperti insieme: le modifiche locali
   hanno la precedenza per 1,5 s, poi lo stato del server fa fede */
let lastInteraction = 0;
function touch() { lastInteraction = Date.now(); }

const NUM_CHANNELS = 8;
const ROLE_COLORS = {
  dimmer: '#f5d76e',
  red: '#ff5252',
  green: '#4cd964',
  blue: '#4aa3ff',
  uv: '#9b5cff',
  white: '#eef1f6',
  strobe: '#ffa640',
  pan: '#2ec9b8',
  tilt: '#1f9e8f',
  focus: '#b9c86b',
  return: '#a08fa5',
  other: '#8a93a5',
};
const ROLE_LABELS = {
  dimmer: 'Dimmer generale',
  red: 'Rosso',
  green: 'Verde',
  blue: 'Blu',
  uv: 'UV',
  white: 'Bianco',
  strobe: 'Strobo',
  pan: 'Pan',
  tilt: 'Tilt',
  focus: 'Focus',
  return: 'Return',
  other: 'Altro',
};

/* modelli di canali pronti, selezionabili quando si aggiunge un faro */
const CHANNEL_TEMPLATES = [
  {
    name: 'Testa mobile Wash Zoom 19x15',
    channels: [
      { label: 'Pan', role: 'pan' },
      { label: 'Tilt', role: 'tilt' },
      { label: 'P/T Speed', role: 'other' },
      { label: 'Dimmer', role: 'dimmer' },
      { label: 'Red', role: 'red' },
      { label: 'Green', role: 'green' },
      { label: 'Blue', role: 'blue' },
      { label: 'White', role: 'white' },
      { label: 'Strobo', role: 'strobe' },
      { label: 'Zoom', role: 'focus' },   // apre il fascio da 10° a 60°
      { label: 'Function mode', role: 'other' },
      { label: 'Mode speed', role: 'other' },
      { label: 'Pan fine', role: 'pan' },
      { label: 'Tilt fine', role: 'tilt' },
      { label: 'Rest (255)', role: 'other' },
      { label: 'Empty', role: 'other' },
    ],
  },
];

const $ = (sel) => document.querySelector(sel);

/* gruppi di pulsantini per le durate di dissolvenza: al contrario di un
   menù a tendina non trattengono il fuoco, così i tasti rapidi (1-9, 0…)
   restano sempre disponibili anche dopo averli usati */
function fadeGroupValue(sel) {
  const on = $(sel).querySelector('button.sel');
  return on ? parseFloat(on.dataset.value) : 0;
}

/* più gruppi possono comandare la stessa impostazione (barra preset e
   schermata griglia): restano sempre allineati fra loro */
const gruppiFade = new Map();   // chiave di memoria -> funzione che applica

function setupFadeGroup(selectors, storageKey, { allowOff = false } = {}) {
  const gruppi = [].concat(selectors).map((s) => $(s)).filter(Boolean);
  const applica = (valore) => {
    let trovato = false;
    gruppi.forEach((g) => g.querySelectorAll('button').forEach((b) => {
      const sel = b.dataset.value === valore;
      if (sel) trovato = true;
      b.classList.toggle('sel', sel);
    }));
    return trovato;
  };
  gruppiFade.set(storageKey, applica);
  // scelta di partenza segnata nell'HTML: ci si torna se quella memorizzata
  // non esiste più (arriva da una versione precedente)
  const iniziale = gruppi[0] && gruppi[0].querySelector('button.sel')
    ? gruppi[0].querySelector('button.sel').dataset.value : null;
  let salvato = localStorage.getItem(storageKey);
  if (salvato === '') salvato = '0';   // prima "niente dissolvenza", ora 0s
  if (salvato !== null && !applica(salvato) && iniziale !== null) applica(iniziale);
  gruppi.forEach((group) => group.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const spegni = allowOff && btn.classList.contains('sel');
    applica(spegni ? '' : btn.dataset.value);
    localStorage.setItem(storageKey, spegni ? '' : btn.dataset.value);
    btn.blur(); // niente fuoco: la barra spaziatrice non lo ricliccherebbe
    aggiornaControlliPreset();
  }));
}

/* imposta un gruppo di durate da fuori (dai comandi accanto al palco) */
function impostaFade(storageKey, valore) {
  localStorage.setItem(storageKey, String(valore));
  const applica = gruppiFade.get(storageKey);
  if (applica) applica(String(valore));
}

async function api(method, url, body) {
  // versione sito (senza server): le richieste vengono gestite in locale
  if (window.LOCAL_BACKEND) return window.LOCAL_BACKEND(method, url, body);
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/* --------------------------------------------- invii ritardati al server */
const pendingPatch = new Map(); // id -> {timer, patch}
function pushFixturePatch(id, patch) {
  touch();
  let e = pendingPatch.get(id);
  if (!e) { e = { timer: null, patch: {} }; pendingPatch.set(id, e); }
  Object.assign(e.patch, patch);
  if (!e.timer) {
    e.timer = setTimeout(() => {
      const p = e.patch;
      e.patch = {};
      e.timer = null;
      api('PUT', `/api/fixtures/${id}`, p).catch(console.error);
    }, 80);
  }
}

const pendingValues = new Map(); // id -> timer
function pushValues(f) {
  touch();
  if (pendingValues.has(f.id)) return;
  pendingValues.set(f.id, setTimeout(() => {
    pendingValues.delete(f.id);
    api('PUT', `/api/fixtures/${f.id}/values`, { values: f.values }).catch(console.error);
  }, 60));
}

/* ------------------------------------------------------- colore del faro */
function fixtureChannels(f) {
  return f.channels || state.channels;
}

function fixtureSpan(f) {
  return fixtureChannels(f).length; // 8 o 16 canali DMX occupati
}

/* ------------------------------------------- puntamento e apertura fascio
   La rotazione impostata sulla mappa è lo "zero" del faro: da lì il canale
   pan fa ruotare il fascio, e il focus ne apre l'angolo da 10° a 60°. */
const PAN_RANGE = 540;   // gradi coperti dal canale pan (tipico di un wash)
const BEAM_MIN = 10;     // apertura minima del fascio, in gradi
const BEAM_MAX = 60;     // apertura massima

/* posizione di un movimento in 0..1, usando il canale fine se presente */
function movePosition(f, ruolo, values) {
  const vals = values || f.values;
  const idx = roleIndexes(f, ruolo);
  if (!idx.length) return null;
  const coarse = vals[idx[0]] || 0;
  const fine = idx.length > 1 ? (vals[idx[1]] || 0) : 0;
  return (coarse * 256 + fine) / 65535;
}

function panPosition(f, values) {
  return movePosition(f, 'pan', values);
}

/* Da che parte gira il movimento quando il valore DMX cresce. Una testa
   appesa a testa in giù gira al contrario di una appoggiata per terra: la
   taratura se ne accorge da sola. */
function versoPan(f) { return f.panflip ? -1 : 1; }
function versoTilt(f) { return f.tiltflip ? -1 : 1; }

/* direzione del fascio: zero della mappa più lo spostamento del pan */
function beamAngle(f, values) {
  const pos = panPosition(f, values);
  if (pos === null) return f.rot;
  return f.rot + versoPan(f) * (pos - (f.panzero || 0)) * PAN_RANGE;
}

/* Valore di pan (0..1) che punta il fascio verso una certa direzione, senza
   toccare lo zero del faro. Il pan copre 540°, quindi la stessa direzione può
   essere raggiunta da più parti: si sceglie quella più vicina a dov'è adesso,
   così la testa fa il movimento più corto. Se la direzione è fuori portata si
   va il più vicino possibile. */
function panForAngle(f, desired) {
  if (!roleIndexes(f, 'pan').length) return null;
  const zero = f.panzero || 0;
  const verso = versoPan(f);
  const a0 = f.rot + verso * (0 - zero) * PAN_RANGE;   // pan tutto a 0
  const a1 = f.rot + verso * (1 - zero) * PAN_RANGE;   // pan tutto a 255
  const min = Math.min(a0, a1);
  const max = Math.max(a0, a1);
  const attuale = beamAngle(f);
  let scelta = null;
  let distanza = Infinity;
  for (let giro = -2; giro <= 2; giro++) {
    const a = desired + 360 * giro;
    const dentro = a >= min && a <= max;
    const d = dentro
      ? Math.abs(a - attuale)
      : 1e6 + Math.min(Math.abs(a - min), Math.abs(a - max));
    if (d < distanza) { distanza = d; scelta = a; }
  }
  return Math.max(0, Math.min(1, zero + verso * (scelta - f.rot) / PAN_RANGE));
}

/* scrive la posizione di un movimento (0..1) sui fader, canale fine compreso */
function setMovePosition(f, ruolo, pos) {
  const idx = roleIndexes(f, ruolo);
  if (!idx.length) return;
  if (idx.length > 1) {
    const raw = Math.max(0, Math.min(65535, Math.round(pos * 65535)));
    f.values[idx[0]] = raw >> 8;
    f.values[idx[1]] = raw & 255;
  } else {
    f.values[idx[0]] = Math.max(0, Math.min(255, Math.round(pos * 65535 / 256)));
  }
}

function setPanPosition(f, pos) {
  setMovePosition(f, 'pan', pos);
}

/* ------------------------------------------------- il palco in tre dimensioni
   La mappa resta una pianta vista dall'alto, ma sappiamo due cose in più:
   quanto è grande il palco davvero (in metri) e a che altezza sta ogni faro.
   Tanto basta: se so che una testa è a 4 m e che il punto da illuminare è a
   3 m di distanza, l'inclinazione del fascio è decisa, non serve un modello
   tridimensionale vero e proprio.

        testa ┐ altezza h
              |\
              | \   <- fascio
              |  \        tilt = angolo dallo strapiombo = atan(distanza / h)
       -------+---*------ pavimento (o quota del bersaglio)
              distanza                                                        */
const TILT_RANGE = 270;   // gradi coperti dal canale tilt (tipico di una testa)
const TILT_PIATTO = 88;   // oltre questa inclinazione il fascio non tocca il palco
const ALTEZZA_DEFAULT = 4;

function stageGeo() {
  const s = state.stage || {};
  return {
    w: s.w > 0 ? s.w : 8,
    d: s.d > 0 ? s.d : 6,
    target: s.target > 0 ? s.target : 0,
  };
}

/* altezza da terra del faro, in metri */
function altezzaFaro(f) {
  const h = parseFloat(f.h);
  return isNaN(h) ? ALTEZZA_DEFAULT : h;
}

/* di quanto il faro sta sopra quello che deve illuminare */
function altezzaUtile(f) {
  return altezzaFaro(f) - stageGeo().target;
}

/* posizione del faro sul palco vero, in metri */
function fixtureMetri(f) {
  const g = stageGeo();
  return { x: f.x * g.w, y: f.y * g.d };
}

/* ---------------------------------------------- il palco dentro il riquadro
   Le coordinate di un faro vanno da 0 a 1 da un capo all'altro del palco, ma
   possono uscirne: un faro piazzato davanti al proscenio ha y più di 1, uno
   dietro il fondale ce l'ha negativo. Il riquadro sullo schermo è più grande
   del palco apposta, e il palco ci sta dentro disegnato con le proporzioni
   vere delle misure. La scala è la stessa nei due sensi, così un metro è un
   metro in qualsiasi direzione e gli angoli sulla mappa sono quelli veri. */
const VISTA_MARGINE = 0.2;   // spazio attorno al palco, in frazioni di palco

function vista(w, h) {
  const g = stageGeo();
  const larg = w || cw;
  const alt = h || ch;
  // quanto spazio tenere sui quattro lati, in frazioni di palco: quello che
  // serve ai fari che stanno fuori, mai meno del margine minimo
  const bordi = [VISTA_MARGINE, VISTA_MARGINE, VISTA_MARGINE, VISTA_MARGINE];
  for (const f of state.fixtures) {
    bordi[0] = Math.max(bordi[0], -f.x);      // a sinistra
    bordi[1] = Math.max(bordi[1], f.x - 1);   // a destra
    bordi[2] = Math.max(bordi[2], -f.y);      // dietro
    bordi[3] = Math.max(bordi[3], f.y - 1);   // davanti
  }
  // a scatti di un decimo, così il palco non balla mentre si trascina un faro
  const [sx, dx, su, giu] = bordi.map((v) => Math.ceil(v * 10) / 10 + 0.05);
  // un filo di margine anche in pixel: i fari sul bordo hanno un'icona e un
  // nome da far stare dentro
  const orlo = Math.min(22, alt * 0.06, larg * 0.06);
  const scala = Math.min((larg - 2 * orlo) / (g.w * (1 + sx + dx)),
                         (alt - 2 * orlo) / (g.d * (1 + su + giu)));
  return {
    scala,                                  // pixel per metro
    w: g.w * scala, h: g.d * scala,         // il palco, in pixel
    ox: (larg - g.w * (1 + sx + dx) * scala) / 2 + g.w * sx * scala,
    oy: (alt - g.d * (1 + su + giu) * scala) / 2 + g.d * su * scala,
  };
}

/* da un punto del riquadro (pixel) alle coordinate del palco (0..1 e oltre) */
function puntoNorm(px, py) {
  const v = vista();
  return { x: (px - v.ox) / v.w, y: (py - v.oy) / v.h };
}

/* da un punto del riquadro (pixel) al palco vero (metri) */
function puntoMetri(px, py) {
  const n = puntoNorm(px, py);
  const g = stageGeo();
  return { x: n.x * g.w, y: n.y * g.d };
}

/* uno spostamento vero (direzione in gradi, distanza in metri) sulla mappa */
function deltaMappa(gradi, metri, w, h) {
  const s = vista(w, h).scala;
  const a = gradi * Math.PI / 180;
  return { x: Math.sin(a) * metri * s, y: Math.cos(a) * metri * s };
}

function tiltZero(f) {
  const v = parseFloat(f.tiltzero);
  return isNaN(v) ? 0.5 : v;
}

/* inclinazione del fascio in gradi: 0 = a piombo, 90 = orizzontale */
function tiltAngle(f, values) {
  const pos = movePosition(f, 'tilt', values);
  if (pos === null) return null;
  return versoTilt(f) * (pos - tiltZero(f)) * TILT_RANGE;
}

/* valore di tilt (0..1) che dà una certa inclinazione; fuori portata si
   arriva il più vicino possibile */
function tiltForAngle(f, gradi) {
  if (!roleIndexes(f, 'tilt').length) return null;
  return Math.max(0, Math.min(1, tiltZero(f) + versoTilt(f) * gradi / TILT_RANGE));
}

/* Dove il fascio tocca il pavimento, guardando dall'alto: distanza in metri
   dal faro e da che parte. null se la testa non ha il tilt, se il faro sta
   sotto il bersaglio o se il fascio è quasi orizzontale: in quei casi si
   disegna come prima, un cono lungo senza pozza di luce. */
function gittata(f, values) {
  const t = tiltAngle(f, values);
  if (t === null) return null;
  const h = altezzaUtile(f);
  if (h <= 0.05) return null;
  const a = Math.abs(t);
  if (a >= TILT_PIATTO) return null;
  return { dist: h * Math.tan(a * Math.PI / 180), h, tilt: a, dietro: t < 0 };
}

/* Come si disegna il fascio su una mappa larga w e alta h. Serve sia al palco
   grande sia alle miniature dei preset, così mostrano la stessa cosa.
     ang   direzione del fascio sullo schermo
     lung  distanza a cui atterra, in pixel
     metri se il fascio tocca il palco: la pozza di luce misurata sul palco
           vero, da disegnare dopo aver messo il foglio in scala */
function proiezione(f, values, w, h) {
  const v = vista(w, h);
  const px = v.ox + f.x * v.w;
  const py = v.oy + f.y * v.h;
  const git = gittata(f, values);
  const azimut = beamAngle(f, values) + (git && git.dietro ? 180 : 0);
  const mezzo = beamHalfAngle(f, values) * Math.PI / 180;
  const unita = deltaMappa(azimut, 1, w, h);
  const ang = Math.atan2(unita.x, unita.y);
  if (!git) {
    const lung = Math.min(w, h) * 0.55;
    return { x: px, y: py, ang, lung, largo: Math.tan(mezzo) * lung, metri: null };
  }
  // il cono taglia il pavimento di sbieco: l'impronta è un'ellisse, più
  // lunga verso il fondo quanto più il fascio è inclinato
  const t = git.tilt * Math.PI / 180;
  const piatto = TILT_PIATTO * Math.PI / 180;
  const vicino = git.h * Math.tan(Math.max(0, t - mezzo));
  const lontano = git.h * Math.tan(Math.min(piatto, t + mezzo));
  const centro = (vicino + lontano) / 2;
  const d = deltaMappa(azimut, centro, w, h);
  return {
    x: px, y: py, ang, largo: null,
    lung: Math.hypot(d.x, d.y),
    metri: {
      azimut: azimut * Math.PI / 180,
      centro,
      largo: Math.max(0.02, (git.h / Math.cos(t)) * Math.tan(mezzo)),
      lungo: Math.max(0.02, (lontano - vicino) / 2),
      sx: v.scala, sy: v.scala,   // quanti pixel vale un metro
    },
  };
}

/* mette il foglio nella scala del palco: da qui in poi si disegna in metri,
   con il fascio che va verso il basso */
function inScala(c2, m) {
  c2.scale(m.sx, m.sy);
  c2.rotate(-m.azimut);
}

/* la pozza di luce a terra, un'ellisse sfumata (si disegna in metri) */
function pozzaDiLuce(c2, m, c, forza) {
  c2.save();
  c2.translate(0, m.centro);
  c2.scale(m.largo, m.lungo);
  const grad = c2.createRadialGradient(0, 0, 0, 0, 0, 1);
  grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${0.9 * forza})`);
  grad.addColorStop(0.6, `rgba(${c.r},${c.g},${c.b},${0.45 * forza})`);
  grad.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
  c2.fillStyle = grad;
  c2.beginPath();
  c2.arc(0, 0, 1, 0, Math.PI * 2);
  c2.fill();
  c2.restore();
}

/* direzione del fascio come si vede sulla mappa, in gradi */
function angoloDisegno(f, values, w, h) {
  return proiezione(f, values, w || cw, h || ch).ang * 180 / Math.PI;
}

/* apertura del fascio in gradi (metà angolo), comandata dal focus */
function beamHalfAngle(f, values) {
  const idx = roleIndexes(f, 'focus');
  if (!idx.length) return 24;   // fari senza focus: apertura fissa come prima
  const vals = values || f.values;
  return (BEAM_MIN + (BEAM_MAX - BEAM_MIN) * ((vals[idx[0]] || 0) / 255)) / 2;
}

function fixtureColor(f) {
  return colorFromValues(f.values, fixtureChannels(f));
}

function colorFromValues(values, channels) {
  let master = null;
  let r = 0, g = 0, b = 0, uv = 0, w = 0;
  let hasColor = false;
  channels.forEach((c, i) => {
    const v = values[i] || 0;
    switch (c.role) {
      case 'dimmer': master = master === null ? v : Math.max(master, v); break;
      case 'red': r = Math.max(r, v); hasColor = true; break;
      case 'green': g = Math.max(g, v); hasColor = true; break;
      case 'blue': b = Math.max(b, v); hasColor = true; break;
      case 'uv': uv = Math.max(uv, v); hasColor = true; break;
      case 'white': w = Math.max(w, v); hasColor = true; break;
    }
  });
  if (!hasColor) {
    if (master === null) master = Math.max(0, ...values);
    r = g = b = 255;
  }
  // il bianco si somma a tutti e tre i colori
  r = Math.min(255, r + w);
  g = Math.min(255, g + w);
  b = Math.min(255, b + w);
  // l'UV in anteprima appare come un viola intenso
  r = Math.min(255, r + uv * 0.45);
  g = Math.min(255, g + uv * 0.10);
  b = Math.min(255, b + uv * 0.95);
  const m = master === null ? 1 : master / 255;
  const peak = Math.max(r, g, b) / 255;
  return { r: r | 0, g: g | 0, b: b | 0, intensity: m * peak };
}

/* --------------------------------------------------------- schede fader */
const cardRefs = new Map(); // id -> {card, inputs[], valEls[], swatch, addrInput}

function overlappingIds() {
  const set = new Set();
  const fs = state.fixtures;
  for (let i = 0; i < fs.length; i++) {
    for (let j = i + 1; j < fs.length; j++) {
      if (fs[i].address <= fs[j].address + fixtureSpan(fs[j]) - 1 &&
          fs[j].address <= fs[i].address + fixtureSpan(fs[i]) - 1) {
        set.add(fs[i].id);
        set.add(fs[j].id);
      }
    }
  }
  return set;
}

function refreshOverlaps() {
  const over = overlappingIds();
  cardRefs.forEach((ref, id) => {
    ref.addrInput.classList.toggle('overlap', over.has(id));
    ref.addrInput.title = over.has(id)
      ? 'Attenzione: i canali si sovrappongono con un altro faro' : '';
  });
}

function updateSwatch(f) {
  const ref = cardRefs.get(f.id);
  if (!ref) return;
  const c = fixtureColor(f);
  const a = state.blackout ? 0 : c.intensity;
  ref.swatch.style.background = `rgba(${c.r},${c.g},${c.b},${Math.max(0.15, a)})`;
  ref.swatch.style.boxShadow = a > 0.05
    ? `0 0 ${8 * a}px rgba(${c.r},${c.g},${c.b},${a})` : 'none';
  if (ref.picker) ref.picker.value = fixtureRgbHex(f);
}

function updateFaderFill(input) {
  input.style.setProperty('--fill', (input.value / 255 * 100) + '%');
}

/* --------------------------------------------------- selettore colore */
function roleIndexes(f, role) {
  const idx = [];
  fixtureChannels(f).forEach((c, i) => { if (c.role === role) idx.push(i); });
  return idx;
}

function fixtureRgbHex(f) {
  const first = (role) => {
    const idx = roleIndexes(f, role);
    return idx.length ? f.values[idx[0]] : 0;
  };
  const hex = (v) => v.toString(16).padStart(2, '0');
  return `#${hex(first('red'))}${hex(first('green'))}${hex(first('blue'))}`;
}

function applyColorToFixture(f, hexColor) {
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);
  for (const x of [f, ...compagniDi(f)]) {
    roleIndexes(x, 'red').forEach((i) => { x.values[i] = r; });
    roleIndexes(x, 'green').forEach((i) => { x.values[i] = g; });
    roleIndexes(x, 'blue').forEach((i) => { x.values[i] = b; });
    // se il dimmer è a zero il colore non si vedrebbe: accendilo
    const dim = roleIndexes(x, 'dimmer');
    if ((r || g || b) && dim.length && dim.every((i) => x.values[i] === 0)) {
      dim.forEach((i) => { x.values[i] = 255; });
    }
    updateFixtureDisplays(x);
    pushValues(x);
  }
  clearActivePreset();
}

/* Toccando i fader, il colore o il mirino la scena non è più identica al
   preset caricato, ma quel preset resta evidenziato: serve a sapere su cosa
   si sta lavorando. Viene però segnato come modificato, così si vede che
   c'è qualcosa da salvare. */
function clearActivePreset() {
  if (activePreset === null || presetModificato) return;
  presetModificato = true;
  renderPresets();
  syncCueUI();
}


function renderFixtures() {
  const row = $('#fixtures-row');
  row.innerHTML = '';
  cardRefs.clear();
  $('#empty-state').classList.toggle('hidden', state.fixtures.length > 0);
  row.classList.toggle('hidden', state.fixtures.length === 0);

  for (const f of state.fixtures) {
    const card = document.createElement('div');
    card.className = 'fixture-card';
    if (selectedIds.has(f.id)) card.classList.add('selected');
    if (f.id === selectedId) card.classList.add('primary');

    const head = document.createElement('div');
    head.className = 'card-head';

    const swatch = document.createElement('span');
    swatch.className = 'swatch';

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'color-pick';
    picker.title = 'Scegli un colore: i fader RGB si impostano da soli';
    picker.value = fixtureRgbHex(f);
    if (!fixtureChannels(f).some((c) => ['red', 'green', 'blue'].includes(c.role))) {
      picker.classList.add('hidden');
    }
    picker.addEventListener('input', () => applyColorToFixture(f, picker.value));

    const name = document.createElement('input');
    name.className = 'name';
    name.value = f.name;
    name.maxLength = 24;
    name.addEventListener('change', () => {
      f.name = name.value || f.name;
      name.value = f.name;
      pushFixturePatch(f.id, { name: f.name });
    });

    const addrWrap = document.createElement('label');
    addrWrap.className = 'addr';
    addrWrap.append('Ind.');
    const addr = document.createElement('input');
    addr.type = 'number';
    addr.min = 1;
    addr.max = 512 - fixtureSpan(f) + 1;
    addr.value = f.address;
    addr.addEventListener('change', () => {
      let v = parseInt(addr.value, 10);
      if (isNaN(v)) v = f.address;
      v = Math.max(1, Math.min(512 - fixtureSpan(f) + 1, v));
      addr.value = v;
      f.address = v;
      pushFixturePatch(f.id, { address: v });
      refreshOverlaps();
    });
    addrWrap.append(addr);

    // Le teste mobili mostrano l'altezza da terra: non si scrive, la ricava
    // la taratura sui quattro angoli insieme a tutto il resto.
    const geo = [];
    if (roleIndexes(f, 'tilt').length) {
      const altWrap = document.createElement('span');
      altWrap.className = 'hgt';
      altWrap.textContent = `↕ ${altezzaFaro(f).toFixed(1).replace('.', ',')} m`;
      altWrap.classList.toggle('stimata', !f.taratura);
      altWrap.title = f.taratura
        ? 'Altezza da terra, ricavata dalla taratura sui quattro angoli'
        : 'Altezza di partenza: fai la taratura e LightStage trova quella vera';

      const tara = document.createElement('button');
      tara.className = 'cfg';
      tara.textContent = '⌖';
      tara.title = 'Tara il mirino: punta la testa a mano dove vuoi, '
        + 'poi clicca sulla mappa il punto illuminato';
      tara.addEventListener('click', (e) => {
        e.stopPropagation();
        iniziaCalibrazione(f);
      });
      geo.push(altWrap, tara);
    }

    const cfg = document.createElement('button');
    cfg.className = 'cfg';
    cfg.textContent = '⚙';
    cfg.title = 'Canali di questo faro';
    cfg.addEventListener('click', (e) => {
      e.stopPropagation();
      openChannelsModal(f);
    });

    const dup = document.createElement('button');
    dup.className = 'cfg';
    dup.textContent = '⧉';
    dup.title = 'Duplica questo faro (stessi canali, stesse luci)';
    dup.addEventListener('click', (e) => {
      e.stopPropagation();
      duplicaFaro(f).catch((err) => alert('Duplicazione fallita: ' + err.message));
    });

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Elimina faro';
    del.addEventListener('click', async () => {
      if (!confirm(`Eliminare "${f.name}"?`)) return;
      await api('DELETE', `/api/fixtures/${f.id}`).catch(console.error);
      state.fixtures = state.fixtures.filter((x) => x.id !== f.id);
      selectedIds.delete(f.id);
      if (selectedId === f.id) selectedId = [...selectedIds][0] ?? null;
      renderFixtures();
    });

    head.append(swatch, picker, name, addrWrap, ...geo, cfg, dup, del);

    const faders = document.createElement('div');
    faders.className = 'faders';
    const inputs = [];
    const valEls = [];

    for (let i = 0; i < fixtureSpan(f); i++) {
      const ch = fixtureChannels(f)[i] || { label: `CH${i + 1}`, role: 'other' };
      const col = document.createElement('div');
      col.className = 'fader-col';

      const val = document.createElement('div');
      val.className = 'val';
      val.textContent = f.values[i];

      const holder = document.createElement('div');
      holder.className = 'fader';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = 0;
      input.max = 255;
      input.value = f.values[i];
      input.style.setProperty('--accent-c', ROLE_COLORS[ch.role] || ROLE_COLORS.other);
      updateFaderFill(input);
      input.addEventListener('input', () => {
        impostaCanale(f, i, parseInt(input.value, 10));
        clearActivePreset();
      });
      // afferrando un fader la scelta multipla resta: è il senso della cosa
      input.addEventListener('pointerdown', () => focusFixture(f.id));
      holder.append(input);

      const label = document.createElement('div');
      label.className = 'ch-label';
      label.textContent = `${i + 1} ${ch.label}`;
      label.title = ch.label;

      col.append(val, holder, label);
      faders.append(col);
      inputs.push(input);
      valEls.push(val);
    }

    card.append(head, faders);
    card.addEventListener('pointerdown', (e) => {
      if (e.target === del) return;
      if (e.target.closest('.fader')) return;   // se ne occupa il fader
      selectFixture(f.id, false, e.shiftKey);
    });
    row.append(card);
    cardRefs.set(f.id, { card, inputs, valEls, swatch, picker, addrInput: addr });
    updateSwatch(f);
  }
  refreshOverlaps();
  sizeFaders();
}

function sizeFaders() {
  // gli input sono ruotati di 90°: la larghezza va impostata pari
  // all'altezza reale del contenitore
  cardRefs.forEach((ref) => {
    ref.inputs.forEach((input) => {
      const h = input.parentElement.clientHeight;
      if (h > 0) input.style.setProperty('--flen', h + 'px');
    });
  });
}

function updateFixtureDisplays(f) {
  const ref = cardRefs.get(f.id);
  if (!ref) return;
  f.values.forEach((v, i) => {
    ref.inputs[i].value = v;
    updateFaderFill(ref.inputs[i]);
    ref.valEls[i].textContent = v;
  });
  updateSwatch(f);
}

/* ------------------------------------------------- scelta di più fari
   Con Maiusc si aggiungono altri fari alla scelta, ma solo se hanno gli
   stessi canali: muovendo un fader si muovono tutti insieme. */
function tipoFaro(f) {
  return fixtureChannels(f).map((c) => c.role).join(',');
}

/* gli altri fari scelti con gli stessi canali di f */
function compagniDi(f) {
  const tipo = tipoFaro(f);
  return state.fixtures.filter((x) => x.id !== f.id && selectedIds.has(x.id)
    && tipoFaro(x) === tipo);
}

let avvisoTimer = null;
function avvisoSelezione(testo) {
  const hint = $('#multi-hint');
  if (!hint) return;
  hint.textContent = testo;
  hint.classList.remove('hidden');
  hint.classList.add('warn');
  clearTimeout(avvisoTimer);
  avvisoTimer = setTimeout(() => { hint.classList.remove('warn'); aggiornaSelezione(); }, 2400);
}

function aggiornaSelezione(scroll = false) {
  cardRefs.forEach((ref, fid) => {
    ref.card.classList.toggle('selected', selectedIds.has(fid));
    ref.card.classList.toggle('primary', fid === selectedId);
    if (fid === selectedId && scroll) {
      ref.card.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    }
  });
  const hint = $('#multi-hint');
  if (!hint || hint.classList.contains('warn')) return;
  hint.classList.toggle('hidden', selectedIds.size < 2);
  hint.textContent = `${selectedIds.size} fari insieme: i fader li muovono tutti`;
}

function selectFixture(id, scroll = true, aggiungi = false) {
  const f = state.fixtures.find((x) => x.id === id);
  if (!f) return;
  stopAiming();   // cambiando faro il puntamento in corso decade
  if (aggiungi && selectedIds.has(id) && selectedIds.size > 1) {
    selectedIds.delete(id);                       // riclic: si toglie
    if (selectedId === id) selectedId = [...selectedIds][0];
  } else if (aggiungi && selectedIds.size && !selectedIds.has(id)) {
    const gia = state.fixtures.find((x) => selectedIds.has(x.id));
    if (gia && tipoFaro(gia) !== tipoFaro(f)) {
      avvisoSelezione('Insieme si possono scegliere solo fari con gli stessi canali');
      return;
    }
    selectedIds.add(id);
    selectedId = id;
  } else {
    if (selectedId === id && selectedIds.size === 1) return;
    selectedIds = new Set([id]);
    selectedId = id;
  }
  aggiornaSelezione(scroll);
}

/* tiene la scelta com'è, cambiando solo il faro principale */
function focusFixture(id) {
  if (!selectedIds.has(id)) { selectFixture(id, false); return; }
  selectedId = id;
  aggiornaSelezione();
}

function deselezionaTutti() {
  selectedId = null;
  selectedIds = new Set();
  aggiornaSelezione();
}

/* cambia un canale sul faro e su tutti gli altri scelti dello stesso tipo */
function impostaCanale(f, i, v) {
  for (const x of [f, ...compagniDi(f)]) {
    if (i >= x.values.length) continue;
    x.values[i] = v;
    updateFixtureDisplays(x);
    pushValues(x);
  }
}

/* --------------------------------------------- impostazioni di ogni preset
   Ogni preset porta con sé la durata della dissolvenza con cui entra e se le
   teste mobili devono spostarsi accese o al buio. I comandi qui sotto sono
   gli stessi ovunque: nella griglia e nel copione modificano quel preset,
   accanto al palco valgono per il prossimo preset che si salva. */
const FADE_STEPS = [0, 0.5, 1, 1.5];
const FADE_LABELS = ['0', '0,5', '1', '1,5'];
/* tempo lasciato alle teste per arrivare, al buio: da un minimo per uno
   spostamento piccolo a un massimo per un giro completo */
const ATTESA_MIN = 350;
const ATTESA_MAX = 2500;

function presetFade(p) {
  const v = p && typeof p.fade === 'number' ? p.fade : fadeGroupValue('#preset-fade');
  return FADE_STEPS.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
}

function presetDark(p) {
  return p && typeof p.dark === 'boolean' ? p.dark : defaultDark();
}

function defaultDark() {
  return localStorage.getItem('lightstage-preset-dark') === '1';
}

function setDefaultDark(on) {
  localStorage.setItem('lightstage-preset-dark', on ? '1' : '');
  aggiornaControlliPreset();
}

const controlliPreset = [];   // {el, aggiorna}: si aggiornano tutti insieme
function aggiornaControlliPreset() {
  // i comandi di celle non più a schermo (griglia ridisegnata) si scartano
  for (let i = controlliPreset.length - 1; i >= 0; i--) {
    if (controlliPreset[i].el.isConnected) controlliPreset[i].aggiorna();
    else controlliPreset.splice(i, 1);
  }
}

const ICONA_TESTA = '<svg viewBox="0 0 20 20" aria-hidden="true">'
  + '<path class="raggio" d="M7.2 5 L3 0 H17 L12.8 5 Z"/>'
  + '<rect class="corpo" x="6" y="4.2" width="8" height="7.2" rx="1.6"/>'
  + '<path class="forcella" d="M5 14.5 V9 M15 14.5 V9"/>'
  + '<rect class="base" x="3.6" y="14.5" width="12.8" height="3" rx="1.4"/></svg>';

/* leggi() -> {fade, dark}; scrivi(patch) applica la modifica */
function costruisciControlliPreset(leggi, scrivi, { orizzontale = false } = {}) {
  const box = document.createElement('div');
  box.className = 'preset-ctl' + (orizzontale ? ' oriz' : '');
  const gruppo = document.createElement('div');
  gruppo.className = 'pc-fade';
  const bottoni = FADE_STEPS.map((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = FADE_LABELS[i];
    b.title = s === 0
      ? 'Entra di netto, senza dissolvenza'
      : `Entra in dissolvenza di ${FADE_LABELS[i]} secondi`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      b.blur();   // il fuoco resta libero per la barra spaziatrice
      scrivi({ fade: s });
    });
    gruppo.append(b);
    return b;
  });
  const testa = document.createElement('button');
  testa.type = 'button';
  testa.className = 'pc-head';
  testa.innerHTML = ICONA_TESTA;
  testa.addEventListener('click', (e) => {
    e.stopPropagation();
    testa.blur();
    scrivi({ dark: !leggi().dark });
  });
  box.append(gruppo, testa);
  // solo i pulsanti fermano l'evento: sullo sfondo del riquadro il preset
  // resta afferrabile come prima (trascinamento nel copione, clic nella griglia)
  const soloPulsanti = (e) => { if (e.target.closest('button')) e.stopPropagation(); };
  box.addEventListener('pointerdown', soloPulsanti);
  box.addEventListener('click', soloPulsanti);

  const aggiorna = () => {
    const { fade, dark } = leggi();
    bottoni.forEach((b, i) => b.classList.toggle('sel', FADE_STEPS[i] === fade));
    testa.classList.toggle('on', !dark);
    testa.title = dark
      ? 'Le teste mobili si spostano al buio, poi le luci risalgono (clic per spostarle accese)'
      : 'Le teste mobili si spostano accese (clic per spostarle al buio)';
  };
  aggiorna();
  const voce = { el: box, aggiorna };
  controlliPreset.push(voce);
  return voce;
}

/* cambia solo le impostazioni di un preset, senza toccare le luci salvate */
async function patchPreset(slot, patch) {
  const p = state.presets[slot];
  if (!p) return;
  Object.assign(p, patch);          // subito a schermo, poi si conferma
  aggiornaControlliPreset();
  const res = await api('PATCH', `/api/presets/${slot}`, patch);
  state.presets = res.presets;
  aggiornaControlliPreset();
}

/* ---------------------------------------------------------------- preset */
function renderPresets() {
  const bar = $('#presets-slots');
  bar.innerHTML = '';
  state.presets.forEach((p, i) => {
    const slot = document.createElement('div');
    slot.className = 'preset ' + (p ? 'used' : 'empty');
    if (i === activePreset) {
      slot.classList.add(luciGiu() ? 'held' : 'active');
      if (presetModificato) slot.classList.add('dirty');
    }

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = i + 1;

    const pname = document.createElement('span');
    pname.className = 'pname';
    pname.textContent = p ? p.name : 'vuoto';

    const actions = document.createElement('span');
    actions.className = 'p-actions';

    const save = document.createElement('button');
    save.textContent = '💾';
    save.title = p ? 'Sovrascrivi con le luci attuali' : 'Salva le luci attuali';
    save.addEventListener('click', async (e) => {
      e.stopPropagation();
      await savePreset(i, p);
    });
    actions.append(save);

    if (p) {
      const clear = document.createElement('button');
      clear.textContent = '✕';
      clear.title = 'Svuota preset';
      clear.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Svuotare il preset "${p.name}"?`)) return;
        const res = await api('DELETE', `/api/presets/${i}`);
        state.presets = res.presets;
        if (activePreset === i) activePreset = null;
        renderPresets();
      });
      actions.append(clear);
    }

    slot.append(num, pname, actions);
    slot.title = p ? `Carica "${p.name}"` : 'Slot vuoto: clic per salvare le luci attuali';
    slot.addEventListener('click', async () => {
      if (p) await loadPreset(i);
      else await savePreset(i, null);
    });
    bar.append(slot);
  });
}

/* ------------------------------------------------- griglia dei 100 preset */
const gridCells = new Map(); // slot -> {cell, canvas, nameEl, badge}
let armedPreset = null;      // preset preparato, parte con la barra spaziatrice

/* miniatura del palco con le luci di un preset (o del look attuale) */
function drawPresetThumb(canvas, preset) {
  const ctx2 = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 180;
  const h = canvas.clientHeight || 80;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2.clearRect(0, 0, w, h);

  // il palco, appena accennato: serve a capire dove cade la luce
  const v = vista(w, h);
  ctx2.fillStyle = 'rgba(255,255,255,0.03)';
  ctx2.fillRect(v.ox, v.oy, v.w, v.h);
  ctx2.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx2.lineWidth = 1;
  ctx2.strokeRect(v.ox, v.oy, v.w, v.h);

  ctx2.save();
  ctx2.globalCompositeOperation = 'lighter';
  for (const f of state.fixtures) {
    // slot vuoto: nessun fascio, solo i fari spenti
    const values = preset ? preset.values[String(f.id)] : null;
    if (!values) continue;
    const c = colorFromValues(values, fixtureChannels(f));
    if (c.intensity <= 0.02) continue;
    const pr = proiezione(f, values, w, h);
    ctx2.save();
    ctx2.translate(pr.x, pr.y);
    if (!pr.metri) {
      ctx2.rotate(-pr.ang);
      const len = h * 0.75;
      const grad = ctx2.createRadialGradient(0, 0, 1, 0, 0, len);
      grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${0.75 * c.intensity})`);
      grad.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
      ctx2.fillStyle = grad;
      const half = Math.tan(beamHalfAngle(f, values) * Math.PI / 180) * len;
      ctx2.beginPath();
      ctx2.moveTo(0, 0);
      ctx2.lineTo(-half, len);
      ctx2.lineTo(half, len);
      ctx2.closePath();
      ctx2.fill();
    } else {
      // stessa pozza di luce del palco grande, in piccolo
      inScala(ctx2, pr.metri);
      pozzaDiLuce(ctx2, pr.metri, c, c.intensity);
    }
    ctx2.restore();
  }
  ctx2.restore();

  // corpi dei fari
  for (const f of state.fixtures) {
    const values = preset ? preset.values[String(f.id)] : null;
    const c = values ? colorFromValues(values, fixtureChannels(f)) : null;
    const { x, y } = fixturePos(f, w, h);
    ctx2.fillStyle = c && c.intensity > 0.02
      ? `rgb(${c.r},${c.g},${c.b})` : '#39414f';
    if (isMovingHead(f)) {
      ctx2.beginPath();
      ctx2.arc(x, y, 2.8, 0, Math.PI * 2);
      ctx2.fill();
    } else {
      ctx2.fillRect(x - 2.5, y - 2, 5, 4);
    }
  }
}

function renderGrid() {
  const wrap = $('#preset-grid-cells');
  wrap.innerHTML = '';
  gridCells.clear();
  state.presets.forEach((p, i) => {
    const cell = document.createElement('div');
    cell.className = 'grid-cell' + (p ? '' : ' empty');

    const canvas = document.createElement('canvas');
    cell.append(canvas);

    const badge = document.createElement('span');
    badge.className = 'cell-badge';
    cell.append(badge);

    if (p) {
      // fade e movimento delle teste di questo preset, sul lato sinistro
      const ctl = costruisciControlliPreset(
        () => ({ fade: presetFade(state.presets[i]), dark: presetDark(state.presets[i]) }),
        (patch) => patchPreset(i, patch).catch(console.error));
      ctl.el.classList.add('cell-side');
      cell.append(ctl.el);
    }

    const foot = document.createElement('div');
    foot.className = 'cell-foot';
    const num = document.createElement('span');
    num.className = 'cell-num';
    num.textContent = i + 1;
    const nameEl = document.createElement('span');
    nameEl.className = 'cell-name';
    nameEl.textContent = p ? p.name : 'vuoto';
    foot.append(num, nameEl);
    cell.append(foot);

    const actions = document.createElement('div');
    actions.className = 'cell-actions';
    const save = document.createElement('button');
    save.textContent = '💾';
    save.title = p ? 'Sovrascrivi con le luci attuali' : 'Salva le luci attuali';
    save.addEventListener('click', async (e) => {
      e.stopPropagation();
      await savePreset(i, p);
    });
    actions.append(save);
    if (p) {
      const dup = document.createElement('button');
      dup.textContent = '⧉';
      dup.title = 'Duplica in un altro spazio';
      dup.addEventListener('click', (e) => {
        e.stopPropagation();
        openDuplicate(i);
      });
      actions.append(dup);

      const clear = document.createElement('button');
      clear.textContent = '✕';
      clear.title = 'Svuota preset';
      clear.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Svuotare il preset "${p.name}"?`)) return;
        const res = await api('DELETE', `/api/presets/${i}`);
        state.presets = res.presets;
        if (activePreset === i) activePreset = null;
        if (armedPreset === i) armedPreset = null;
        renderPresets();
        renderGrid();
      });
      actions.append(clear);
    }
    cell.append(actions);

    cell.title = p
      ? `Prepara "${p.name}" — poi barra spaziatrice per mandarlo in onda`
      : 'Vuoto: clic per salvarci le luci attuali';
    cell.addEventListener('click', async () => {
      if (!p) {
        await savePreset(i, null);
        return;
      }
      // clic = prepara (rosso lampeggiante); riclic sul preparato = annulla
      armedPreset = armedPreset === i ? null : i;
      syncCueUI();
    });

    wrap.append(cell);
    gridCells.set(i, { cell, canvas, nameEl, badge });
  });
  updateGridSelection();
  aggiornaControlliPreset();
  // le miniature si disegnano dopo il layout, così hanno le misure giuste
  requestAnimationFrame(() => {
    gridCells.forEach((ref, slot) => drawPresetThumb(ref.canvas, state.presets[slot]));
  });
}

/* preset in onda e preparato vanno mostrati uguali su tutte le schermate */
function syncCueUI() {
  updateGridSelection();
  // su tablet il GO si preme col dito: si accende solo se c'è un preset pronto
  $$('.js-go').forEach((b) => { b.disabled = armedPreset === null; });
  if (typeof updateCopioneCues === 'function') updateCopioneCues();
}

/* le luci sono abbassate: FTB in corso oppure blackout */
function luciGiu() {
  return ftbSnapshot !== null || state.blackout;
}

/* aggiorna solo i bordi, senza ridisegnare le 100 miniature */
function updateGridSelection() {
  const giu = luciGiu();
  gridCells.forEach((ref, slot) => {
    const live = slot === activePreset && state.presets[slot];
    const armed = slot === armedPreset;
    ref.cell.classList.toggle('live', !!live && !armed && !giu);
    ref.cell.classList.toggle('held', !!live && !armed && giu);
    ref.cell.classList.toggle('armed', armed);
    ref.cell.classList.toggle('dirty', !!live && !armed && presetModificato);
    ref.badge.textContent = armed ? 'PRONTO'
      : (live ? (presetModificato ? 'MODIFICATO' : (giu ? 'AL BUIO' : 'IN ONDA')) : '');
  });
}

/* manda in onda il preset preparato (barra spaziatrice) */
async function fireArmedPreset() {
  if (armedPreset === null || !state.presets[armedPreset]) return;
  const slot = armedPreset;
  armedPreset = null;
  await loadPreset(slot);
  syncCueUI();
}

function openGrid() {
  renderGrid();
  $('#preset-grid').classList.remove('hidden');
}

function closeGrid() {
  $('#preset-grid').classList.add('hidden');
}

$('#btn-grid').addEventListener('click', openGrid);
$('#btn-grid-close').addEventListener('click', closeGrid);

/* passaggio diretto fra le tre schermate, dai pulsanti in fondo.
   Dopo il clic il pulsante lascia il fuoco: altrimenti la barra spaziatrice
   lo ricliccherebbe invece di mandare in onda il preset. */
function vaiA(sel, azione) {
  const b = $(sel);
  if (!b) return;
  b.addEventListener('click', () => {
    b.blur();
    azione();
  });
}
vaiA('#btn-grid-to-main', closeGrid);
vaiA('#btn-grid-to-copione', () => {
  closeGrid();
  openCopione().catch(console.error);
});
vaiA('#btn-copione-to-main', () => closeCopione());
vaiA('#btn-copione-to-grid', () => {
  closeCopione();
  openGrid();
});

async function savePreset(slot, existing) {
  const name = prompt('Nome del preset:', existing ? existing.name : `Preset ${slot + 1}`);
  if (name === null) return;
  // il preset nasce con il fade e il movimento scelti accanto al palco
  const res = await api('POST', `/api/presets/${slot}`, {
    name: name.trim() || `Preset ${slot + 1}`,
    fade: existing ? presetFade(existing) : fadeGroupValue('#preset-fade'),
    dark: existing ? presetDark(existing) : defaultDark(),
  });
  state.presets = res.presets;
  activePreset = slot;
  presetModificato = false;
  renderPresets();
  if (!$('#preset-grid').classList.contains('hidden')) renderGrid();
  syncCueUI();
}

/* ------------------------------------------------------- duplica un preset
   Si sceglie il nome della copia e in quale dei 100 spazi metterla. */
let dupFrom = null;

function primoSpazioLibero(dopo) {
  for (let i = dopo + 1; i < state.presets.length; i++) if (!state.presets[i]) return i;
  for (let i = 0; i < state.presets.length; i++) if (!state.presets[i]) return i;
  return dopo;
}

function aggiornaAvvisoDuplica() {
  const n = parseInt($('#dup-slot').value, 10);
  const avviso = $('#dup-warn');
  if (!(n >= 1 && n <= state.presets.length)) {
    avviso.textContent = `Scegli un numero da 1 a ${state.presets.length}.`;
    avviso.className = 'small warn';
    return;
  }
  const occupato = state.presets[n - 1];
  if (occupato) {
    avviso.textContent = `Lo spazio ${n} contiene "${occupato.name}": verrà sostituito.`;
    avviso.className = 'small warn';
  } else {
    avviso.textContent = `Lo spazio ${n} è libero.`;
    avviso.className = 'small';
  }
}

function openDuplicate(slot) {
  const p = state.presets[slot];
  if (!p) return;
  dupFrom = slot;
  $('#dup-from').textContent = `Copia di "${p.name}" (spazio ${slot + 1}).`;
  $('#dup-name').value = `${p.name} (copia)`.slice(0, 24);
  $('#dup-slot').max = String(state.presets.length);
  $('#dup-slot').value = String(primoSpazioLibero(slot) + 1);
  aggiornaAvvisoDuplica();
  openModal('#modal-dup');
  $('#dup-name').focus();
  $('#dup-name').select();
}

async function confirmDuplicate() {
  if (dupFrom === null) return;
  const n = parseInt($('#dup-slot').value, 10);
  if (!(n >= 1 && n <= state.presets.length)) return;
  const dest = n - 1;
  const occupato = state.presets[dest];
  if (occupato && !confirm(`Lo spazio ${n} contiene "${occupato.name}". Sostituirlo?`)) return;
  const nome = $('#dup-name').value.trim() || state.presets[dupFrom].name;
  const res = await api('POST', `/api/presets/${dupFrom}/copy`, { to: dest, name: nome });
  state.presets = res.presets;
  dupFrom = null;
  closeModals();
  renderPresets();
  if (!$('#preset-grid').classList.contains('hidden')) renderGrid();
  syncCueUI();
}

$('#dup-slot').addEventListener('input', aggiornaAvvisoDuplica);
$('#btn-dup-confirm').addEventListener('click',
  () => confirmDuplicate().catch((err) => alert('Duplicazione fallita: ' + err.message)));
$('#dup-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#btn-dup-confirm').click();
});

async function loadPreset(slot) {
  const p = state.presets[slot];
  if (!p) return;
  activePreset = slot;
  presetModificato = false;
  renderPresets();
  syncCueUI();
  const durata = presetFade(p) * 1000;
  const targets = new Map();
  for (const f of state.fixtures) {
    const saved = p.values[String(f.id)];
    if (saved === undefined) continue;
    const n = fixtureSpan(f);
    targets.set(f.id, Array.from({ length: n }, (_, i) => {
      const v = parseInt(saved[i], 10);
      return isNaN(v) ? 0 : Math.max(0, Math.min(255, v));
    }));
  }
  // Con l'FTB attivo il preset non riaccende le luci: diventa quello che
  // tornerà in scena quando si toglie l'FTB. Movimento, zoom e macro si
  // spostano subito, così le teste si preparano al buio.
  if (ftbSnapshot !== null) {
    for (const f of state.fixtures) {
      const to = targets.get(f.id);
      if (!to) continue;
      ftbSnapshot.set(f.id, [...to]);
      const chans = fixtureChannels(f);
      const spenti = ruoliSpegnimento(f);
      f.values = f.values.map((v, i) => (spenti.has(chans[i].role) ? v : to[i]));
      updateFixtureDisplays(f);
      pushValues(f);
    }
    return;
  }
  // teste al buio: si spegne, si sposta, si riaccende sulla nuova posizione
  if (presetDark(p) && state.fixtures.some(isMovingHead)) {
    await entraAlBuio(targets, durata);
    return;
  }
  if (durata <= 0) {
    for (const f of state.fixtures) {
      const to = targets.get(f.id);
      if (!to) continue;
      f.values = to;
      updateFixtureDisplays(f);
      pushValues(f);
    }
    return;
  }
  // sfuma tutto tranne il movimento: pan e tilt vanno subito in posizione
  fadeValues(targets, durata, { skip: PRESET_SNAP_ROLES });
}

/* Entrata con le teste che si spostano al buio. Riguarda solo le teste
   mobili: gli altri fari cambiano scena come sempre, con il fade del preset,
   mentre le teste spengono, si spostano al buio e si riaccendono arrivate in
   posizione. Con fade 0 la discesa e la risalita durano un quarto di secondo:
   serve un minimo di buio, altrimenti lo spostamento si vedrebbe comunque. */
async function entraAlBuio(targets, durata) {
  const respiro = Math.max(250, durata);
  const teste = new Map();       // le teste mobili, con la scena di arrivo
  const altri = new Map();       // par e simili: cambiano subito, come sempre
  const spente = new Map();      // le teste con il solo dimmer a zero
  for (const f of state.fixtures) {
    const to = targets.get(f.id);
    if (!to) continue;
    if (!isMovingHead(f)) { altri.set(f.id, to); continue; }
    teste.set(f.id, to);
    const chans = fixtureChannels(f);
    const spenti = ruoliSpegnimento(f);
    spente.set(f.id, f.values.map((v, i) => (spenti.has(chans[i].role) ? 0 : v)));
  }

  // gli altri fari non aspettano le teste: partono subito col loro fade
  if (altri.size) {
    if (durata > 0) fadeValues(altri, durata, { skip: PRESET_SNAP_ROLES });
    else {
      for (const f of state.fixtures) {
        const to = altri.get(f.id);
        if (!to) continue;
        f.values = to;
        updateFixtureDisplays(f);
        pushValues(f);
      }
    }
  }
  if (!teste.size) return;

  const attesa = attesaMovimento(teste);   // va misurata prima di spostare
  if (!await fadeValues(spente, respiro, { only: ruoliSpegnimento })) return;

  // al buio: movimento, zoom e macro vanno in posizione, il dimmer resta giù
  const token = ++fadeSeq;
  for (const id of teste.keys()) fadePadrone.set(id, token);
  for (const f of state.fixtures) {
    const to = teste.get(f.id);
    if (!to) continue;
    const chans = fixtureChannels(f);
    const spenti = ruoliSpegnimento(f);
    f.values = f.values.map((v, i) => (spenti.has(chans[i].role) ? v : to[i]));
    updateFixtureDisplays(f);
    pushValues(f);
  }
  await new Promise((r) => setTimeout(r, attesa));
  // se nel frattempo è partito un altro comando su queste teste, ci si ferma
  if ([...teste.keys()].some((id) => fadePadrone.get(id) !== token)) return;
  await fadeValues(teste, respiro, { only: ruoliSpegnimento });
}

/* Bersaglio "tutto spento": i canali di luce a zero, tutto il resto com'è.
   Azzerare anche pan e tilt farebbe partire le teste verso la posizione
   zero appena si preme, invece di lasciarle ferme fino al buio. */
function soloLuciAZero() {
  return new Map(state.fixtures.map((f) => {
    const chans = fixtureChannels(f);
    return [f.id, f.values.map((v, i) => (ruoliSpegnimento(f).has(chans[i].role) ? 0 : v))];
  }));
}

/* Quanto aspettare al buio: una testa impiega circa due secondi e mezzo per
   un giro intero, quindi il tempo segue l'ampiezza dello spostamento. */
function attesaMovimento(targets) {
  let massimo = 0;
  for (const f of state.fixtures) {
    const to = targets.get(f.id);
    if (!to) continue;
    fixtureChannels(f).forEach((c, i) => {
      if (c.role !== 'pan' && c.role !== 'tilt') return;
      massimo = Math.max(massimo, Math.abs((to[i] || 0) - (f.values[i] || 0)) / 255);
    });
  }
  return Math.round(ATTESA_MIN + massimo * (ATTESA_MAX - ATTESA_MIN));
}

/* ------------------------------------------------------------------- DMX */
function renderDmx() {
  const sel = $('#port-select');
  if (window.LIGHTSTAGE_STATIC) {
    // con Web Serial la porta si sceglie dalla finestra del browser
    sel.classList.add('hidden');
    $('#btn-refresh-ports').classList.add('hidden');
    const dot = $('#dmx-dot');
    const label = $('#dmx-label');
    const btn = $('#btn-connect');
    dot.className = 'status-dot';
    if (dmx.connected) {
      dot.classList.add(dmx.slow ? 'err' : 'ok');
      label.textContent = dmx.slow
        ? 'invio rallentato: tieni la finestra in primo piano'
        : 'connesso al cavo USB-DMX';
      label.title = dmx.slow
        ? 'Il browser sta frenando la pagina perché è in secondo piano: '
          + 'i fari possono perdere il segnale.'
        : '';
      btn.textContent = 'Disconnetti';
    } else if (dmx.error) {
      dot.classList.add('err');
      label.textContent = dmx.error;
      label.title = dmx.error;
      btn.textContent = 'Connetti cavo';
    } else {
      label.textContent = dmx.available
        ? 'cavo non collegato (solo anteprima)'
        : 'serve Chrome o Edge per il DMX';
      btn.textContent = 'Connetti cavo';
    }
    return;
  }
  const current = sel.value;
  const wanted = dmx.ports.map((p) => p.device);
  const have = Array.from(sel.options).map((o) => o.value);
  if (JSON.stringify(wanted) !== JSON.stringify(have)) {
    sel.innerHTML = '';
    if (dmx.ports.length === 0) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'nessuna porta trovata';
      sel.append(o);
    }
    for (const p of dmx.ports) {
      const o = document.createElement('option');
      o.value = p.device;
      o.textContent = (p.likely ? '● ' : '') + `${p.device} — ${p.description}` +
        (p.likely ? '  (probabile cavo DMX)' : '');
      sel.append(o);
    }
    if (wanted.includes(current)) sel.value = current;
    else if (dmx.port && wanted.includes(dmx.port)) sel.value = dmx.port;
    else {
      // preseleziona la porta che sembra un cavo USB-DMX
      const guess = dmx.ports.find((p) => p.likely);
      if (guess) sel.value = guess.device;
    }
  }
  const dot = $('#dmx-dot');
  const label = $('#dmx-label');
  const btn = $('#btn-connect');
  dot.className = 'status-dot';
  if (dmx.connected) {
    dot.classList.add('ok');
    label.textContent = `connesso: ${dmx.port}`;
    btn.textContent = 'Disconnetti';
  } else if (dmx.error) {
    dot.classList.add('err');
    label.textContent = dmx.error;
    label.title = dmx.error;
    btn.textContent = 'Connetti';
  } else {
    label.textContent = dmx.available ? 'non connesso (solo anteprima)' : 'pyserial non installato';
    btn.textContent = 'Connetti';
  }
}

/* ------------------------------------------------------------ anteprima */
const canvas = $('#stage');
const ctx = canvas.getContext('2d');
let cw = 0, ch = 0;

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cw = rect.width;
  ch = rect.height;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function fixturePos(f, w, h) {
  const v = vista(w, h);
  return { x: v.ox + f.x * v.w, y: v.oy + f.y * v.h };
}

function fixtureAt(px, py) {
  for (let i = state.fixtures.length - 1; i >= 0; i--) {
    const f = state.fixtures[i];
    const p = fixturePos(f);
    if (Math.hypot(px - p.x, py - p.y) < 20) return f;
  }
  return null;
}

function handlePos(f) {
  const p = fixturePos(f);
  const th = angoloDisegno(f) * Math.PI / 180;
  return { x: p.x + Math.sin(th) * 40, y: p.y + Math.cos(th) * 40 };
}

/* ------------------------------------------------------------- puntamento
   Sul faro selezionato compare un mirino: cliccandolo il puntatore diventa
   un mirino e il clic successivo sul palco imposta il pan verso quel punto,
   senza spostare lo zero del faro. */
let aimFixture = null;          // faro in attesa del punto da illuminare
let aimPointer = null;          // {x, y}: dove sta il mouse mentre si punta
let aimMode = 'punta';          // 'punta' manda il fascio lì, 'calibra' impara da lì

function canAim(f) {
  return !!f && roleIndexes(f, 'pan').length > 0;
}

/* Il mirino sta dalla parte opposta al fascio: così la luce non lo copre mai
   e non finisce sulla maniglia di rotazione, che sta invece sul fascio. Se
   quel punto cadrebbe fuori dal palco si prova di lato, sempre lontano dal
   fascio, e in ultimo si rientra dentro il bordo. */
const AIM_MARGIN = 13;
/* di quanto stare lontani dal fascio: il cono è al massimo 60°, quindi anche
   il ripiego più stretto (65°) resta fuori dalla luce */
const AIM_ANGLES = [180, 150, -150, 120, -120, 95, -95, 65, -65];
const AIM_RADII = [38, 27];

function aimHandlePos(f) {
  const p = fixturePos(f);
  const base = angoloDisegno(f);
  const punto = (scarto, raggio) => {
    const th = (base + scarto) * Math.PI / 180;
    return { x: p.x + Math.sin(th) * raggio, y: p.y + Math.cos(th) * raggio };
  };
  for (const raggio of AIM_RADII) {
    for (const scarto of AIM_ANGLES) {
      const a = punto(scarto, raggio);
      if (a.x > AIM_MARGIN && a.x < cw - AIM_MARGIN
          && a.y > AIM_MARGIN && a.y < ch - AIM_MARGIN) return a;
    }
  }
  const a = punto(180, AIM_RADII[0]);
  return {
    x: Math.max(AIM_MARGIN, Math.min(cw - AIM_MARGIN, a.x)),
    y: Math.max(AIM_MARGIN, Math.min(ch - AIM_MARGIN, a.y)),
  };
}

function drawAimHandle(f) {
  const a = aimHandlePos(f);
  const attivo = aimFixture === f;
  ctx.save();
  ctx.fillStyle = attivo ? 'rgba(91, 140, 255, 0.95)' : 'rgba(16, 20, 27, 0.9)';
  ctx.strokeStyle = attivo ? '#fff' : '#5b8cff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(a.x, a.y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = attivo ? '#fff' : '#5b8cff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(a.x - 6, a.y); ctx.lineTo(a.x - 2, a.y);
  ctx.moveTo(a.x + 2, a.y); ctx.lineTo(a.x + 6, a.y);
  ctx.moveTo(a.x, a.y - 6); ctx.lineTo(a.x, a.y - 2);
  ctx.moveTo(a.x, a.y + 2); ctx.lineTo(a.x, a.y + 6);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(a.x, a.y, 2.2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/* filo che collega il faro al punto che sta per essere illuminato */
function drawAimLine() {
  if (!aimFixture || !state.fixtures.includes(aimFixture)) return;
  if (aimMode === 'calibra') drawAimBadge();
  if (!aimPointer) return;
  const p = fixturePos(aimFixture);
  ctx.save();
  ctx.strokeStyle = aimMode === 'calibra'
    ? 'rgba(245, 215, 110, 0.75)' : 'rgba(91, 140, 255, 0.7)';
  ctx.setLineDash([5, 5]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(aimPointer.x, aimPointer.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(aimPointer.x, aimPointer.y, 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/* spiega cosa si aspetta il programma mentre si tara un faro */
function drawAimBadge() {
  const testo = `Clicca dove ${aimFixture.name} sta illuminando adesso`;
  ctx.save();
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  const w = ctx.measureText(testo).width + 18;
  const y = ch - 58;   // in basso, dove non copre i fari appesi al fondale
  roundRect(ctx, cw / 2 - w / 2, y, w, 22, 7);
  ctx.fillStyle = 'rgba(16, 20, 27, 0.92)';
  ctx.fill();
  ctx.strokeStyle = '#f5d76e';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#f5d76e';
  ctx.fillText(testo, cw / 2, y + 15);
  ctx.restore();
}

/* Punta il faro verso un punto del palco: il pan dà la direzione, il tilt
   l'inclinazione, che si ricava dall'altezza del faro e dalla distanza. */
function aimAt(f, px, py) {
  const bersaglio = puntoMetri(px, py);
  // tutte le teste scelte guardano lo stesso punto, ognuna dal suo posto
  for (const x of [f, ...compagniDi(f)]) {
    const p = fixtureMetri(x);
    const dx = bersaglio.x - p.x;
    const dy = bersaglio.y - p.y;
    const direzione = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    const pan = panForAngle(x, direzione);
    if (pan !== null) setPanPosition(x, pan);
    // quanto abbassare il fascio: 0 = a piombo, 90 = orizzontale
    const inclinazione = Math.atan2(Math.hypot(dx, dy), altezzaUtile(x)) * 180 / Math.PI;
    const tilt = tiltForAngle(x, inclinazione);
    if (tilt !== null) setMovePosition(x, 'tilt', tilt);
    if (pan === null && tilt === null) continue;
    updateFixtureDisplays(x);
    pushValues(x);
  }
  clearActivePreset();
}

/* ---------------------------------------------------------------- taratura
   Il mirino sa dove mandare il fascio solo se conosce i due "zeri" del faro:
   la direzione a pan fermo e il tilt che punta a piombo. Invece di chiederli
   a numeri, si punta la testa a mano e si dice a LightStage dove è finita la
   luce: da quel punto ricava tutti e due. */
function calibraFaro(f, px, py) {
  const b = puntoMetri(px, py);
  const p = fixtureMetri(f);
  const dx = b.x - p.x;
  const dy = b.y - p.y;
  const patch = {};
  if (roleIndexes(f, 'pan').length) {
    f.rot = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    f.panzero = panPosition(f) ?? 0;
    patch.rot = f.rot;
    patch.panzero = f.panzero;
  }
  const tilt = movePosition(f, 'tilt');
  if (tilt !== null) {
    const inclinazione = Math.atan2(Math.hypot(dx, dy), altezzaUtile(f)) * 180 / Math.PI;
    f.tiltzero = tilt - versoTilt(f) * inclinazione / TILT_RANGE;
    patch.tiltzero = f.tiltzero;
  }
  if (!Object.keys(patch).length) return;
  // ritoccando gli zeri a mano, le misure del giro dei quattro angoli non
  // descrivono più com'è messa questa testa: si buttano
  if (f.taratura) { f.taratura = null; patch.taratura = null; }
  pushFixturePatch(f.id, patch);
}

/* ---------------------------------------- taratura sui quattro angoli
   Si puntano a mano tutte le teste su un angolo del pavimento e si segna;
   poi gli altri tre. Da quelle otto misure per testa si ricava tutto: dove
   sta, quanto è alta, i suoi due zeri e da che parte gira il movimento.

   È il conto che in topografia si chiama resezione: si conoscono i punti
   guardati e con che angoli li si guarda, si cerca da dove li si guarda.
   Prima il pan, che dà posizione e zero del pan; sapendo dov'è la testa le
   distanze sono note, e allora il tilt dà altezza e zero del tilt.          */
function angoliPalco() {
  const g = stageGeo();
  return [
    { x: 0, y: 0, nome: 'in fondo a sinistra' },
    { x: g.w, y: 0, nome: 'in fondo a destra' },
    { x: g.w, y: g.d, nome: 'davanti a destra' },
    { x: 0, y: g.d, nome: 'davanti a sinistra' },
  ];
}

function testeDaTarare() {
  return state.fixtures.filter(
    (f) => roleIndexes(f, 'pan').length && roleIndexes(f, 'tilt').length);
}

/* il punto che sta più vicino possibile a tutte le rette di mira */
function incrocioRette(punti, direzioni) {
  let a = 0, b = 0, d = 0, e = 0, g = 0;
  for (let i = 0; i < punti.length; i++) {
    const nx = direzioni[i].y;      // normale alla retta di mira
    const ny = -direzioni[i].x;
    const k = nx * punti[i].x + ny * punti[i].y;
    a += nx * nx; b += nx * ny; d += ny * ny;
    e += nx * k; g += ny * k;
  }
  const det = a * d - b * b;
  if (Math.abs(det) < 1e-9) return null;   // mire tutte parallele: niente da fare
  return { x: (e * d - b * g) / det, y: (a * g - b * e) / det };
}

/* cerca il minimo di una funzione su un intervallo, prima a passi grossi e
   poi stringendo attorno al migliore */
function cercaMinimo(da, a, passo, valuta) {
  let migliore = null;
  const giro = (d1, a1, p1) => {
    for (let v = d1; v <= a1 + 1e-9; v += p1) {
      const c = valuta(v);
      if (c && (!migliore || c.res < migliore.res)) migliore = c;
    }
  };
  giro(da, a, passo);
  for (let p = passo / 4; p > passo / 400; p /= 4) {
    if (!migliore) return null;
    giro(migliore.v - p * 4, migliore.v + p * 4, p);
  }
  return migliore;
}

/* posizione e zero del pan, provando un verso di rotazione */
function risolviAzimut(misure, angoli, verso) {
  return cercaMinimo(0, 359, 1, (fi0) => {
    const dir = misure.map((m) => {
      const b = (fi0 + verso * PAN_RANGE * m.pan) * Math.PI / 180;
      return { x: Math.sin(b), y: Math.cos(b) };
    });
    const P = incrocioRette(angoli, dir);
    if (!P) return null;
    let res = 0;
    for (let i = 0; i < angoli.length; i++) {
      // la retta di mira è la stessa anche guardando dall'altra parte: si
      // tiene solo la soluzione in cui l'angolo sta davanti al faro, non
      // dietro, altrimenti esce una posizione specchiata di 180°
      if ((angoli[i].x - P.x) * dir[i].x
          + (angoli[i].y - P.y) * dir[i].y <= 0) return null;
      const s = dir[i].y * (P.x - angoli[i].x) - dir[i].x * (P.y - angoli[i].y);
      res += s * s;
    }
    return { v: fi0, fi0, P, res };
  });
}

/* altezza e zero del tilt, note le distanze dai quattro angoli */
function risolviAltezza(misure, distanze, verso) {
  return cercaMinimo(0.3, 20, 0.05, (h) => {
    const scarti = misure.map((m, i) =>
      Math.atan2(distanze[i], h) * 180 / Math.PI - verso * TILT_RANGE * m.tilt);
    const t0 = scarti.reduce((s, x) => s + x, 0) / scarti.length;
    const res = scarti.reduce((s, x) => s + (x - t0) * (x - t0), 0);
    return { v: h, h, t0, res };
  });
}

/* Quanto sbaglia, in metri: con i valori trovati si ricalcola dove sarebbe
   finito il fascio a ogni angolo e si misura quanto è lontano dall'angolo
   vero. È il numero da mostrare, l'unico che si capisce a occhio. */
function scartoTaratura(r, misure, angoli) {
  let somma = 0;
  for (let i = 0; i < angoli.length; i++) {
    const az = (r.fi0 + r.vp * PAN_RANGE * misure[i].pan) * Math.PI / 180;
    const inc = (r.t0 + r.vt * TILT_RANGE * misure[i].tilt) * Math.PI / 180;
    if (!(inc > 0.01) || inc > 1.53) { somma += 99; continue; }   // fascio piatto
    const d = r.h * Math.tan(inc);
    somma += Math.hypot(r.P.x + Math.sin(az) * d - angoli[i].x,
                        r.P.y + Math.cos(az) * d - angoli[i].y);
  }
  return somma / angoli.length;
}

/* la taratura di una testa: prova i due versi di pan e i due di tilt e
   tiene la combinazione che sbaglia meno */
function risolviTaratura(misure, angoli = angoliPalco()) {
  let migliore = null;
  for (const vp of [1, -1]) {
    const az = risolviAzimut(misure, angoli, vp);
    if (!az) continue;
    const dist = angoli.map((c) => Math.hypot(c.x - az.P.x, c.y - az.P.y));
    for (const vt of [1, -1]) {
      const alt = risolviAltezza(misure, dist, vt);
      if (!alt) continue;
      const r = { vp, vt, fi0: az.fi0, P: az.P, h: alt.h, t0: alt.t0 };
      r.scarto = scartoTaratura(r, misure, angoli);
      if (!migliore || r.scarto < migliore.scarto) migliore = r;
    }
  }
  return migliore;
}

/* i numeri trovati diventano le impostazioni del faro */
function patchDaTaratura(r, misure) {
  const g = stageGeo();
  return {
    // un faro può stare fuori dal palco: sulla mappa c'è posto anche lì
    x: Math.max(-1, Math.min(2, r.P.x / g.w)),
    y: Math.max(-1, Math.min(2, r.P.y / g.d)),
    h: Math.max(0, Math.min(30, r.h)),
    rot: ((r.fi0 % 360) + 360) % 360,
    panzero: 0,
    tiltzero: -r.t0 / (r.vt * TILT_RANGE),
    panflip: r.vp < 0,
    tiltflip: r.vt < 0,
    taratura: misure,
  };
}

async function applicaTaratura(f, r, misure) {
  const patch = patchDaTaratura(r, misure);
  Object.assign(f, patch);
  updateFixtureDisplays(f);
  await api('PUT', `/api/fixtures/${f.id}`, patch);
}

/* Cambiando le misure del palco cambiano anche gli angoli puntati, quindi i
   conti vanno rifatti: le misure grezze restano salvate apposta. */
async function ricalcolaTarature() {
  const teste = state.fixtures.filter((f) => f.taratura);
  if (!teste.length) return;
  for (const f of teste) {
    const r = risolviTaratura(f.taratura);
    if (r) await applicaTaratura(f, r, f.taratura);
  }
  renderFixtures();
  avvisoSelezione(`Taratura rifatta sulle nuove misure del palco (${teste.length} teste)`);
}

function iniziaCalibrazione(f) {
  selectFixture(f.id);
  aimFixture = f;
  aimMode = 'calibra';
  aimPointer = null;
  canvas.style.cursor = 'crosshair';
  canvas.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function stopAiming() {
  if (!aimFixture) return;
  aimFixture = null;
  aimPointer = null;
  aimMode = 'punta';
  canvas.style.cursor = 'default';
}

/* ------------------------------------------------- misure vere del palco
   Larghezza e profondità dicono quanti metri c'è tra un faro e l'altro, il
   bersaglio a che quota si vuole la luce: a terra o all'altezza dei volti. */
function renderGeo() {
  const g = stageGeo();
  // il campo su cui si sta scrivendo non si tocca: la risposta del server
  // arriva mentre si sta ancora battendo l'altra misura
  const scrivi = (sel, v) => {
    const el = $(sel);
    if (el && el !== document.activeElement) el.value = v;
  };
  scrivi('#geo-w', g.w);
  scrivi('#geo-d', g.d);
  scrivi('#geo-target', String(g.target));
}

function salvaGeo() {
  const g = {
    w: parseFloat($('#geo-w').value) || 8,
    d: parseFloat($('#geo-d').value) || 6,
    target: parseFloat($('#geo-target').value) || 0,
  };
  state.stage = g;
  touch();
  api('PUT', '/api/stage', g).then((r) => {
    if (r && r.stage) state.stage = r.stage;
    renderGeo();
    // gli angoli del palco sono cambiati: la taratura va rifatta sui nuovi
    return ricalcolaTarature();
  }).catch(console.error);
}

['#geo-w', '#geo-d', '#geo-target'].forEach(
  (sel) => $(sel).addEventListener('change', salvaGeo));

/* ------------------------------------------- il giro dei quattro angoli
   Una tappa alla volta: si punta, si segna, si passa all'angolo dopo. Le
   misure restano in memoria finché non si applicano, così si può rifare
   un angolo venuto male senza ricominciare. */
let taraStato = null;   // {passo, misure: Map(id -> [{pan, tilt}]), esiti}
const TARA_BUONA = 0.30;   // sotto i 30 cm di scarto la taratura è da tenere

function iniziaTaratura() {
  const teste = testeDaTarare();
  if (!teste.length) {
    alert('Non ci sono teste mobili con pan e tilt da tarare.');
    return;
  }
  stopAiming();
  taraStato = { passo: 0, misure: new Map(teste.map((f) => [f.id, []])) };
  aggiornaBarraTara();
}

function fineTaratura() {
  taraStato = null;
  $('#tara-bar').classList.add('hidden');
}

function aggiornaBarraTara() {
  const bar = $('#tara-bar');
  if (!taraStato) { bar.classList.add('hidden'); return; }
  const angolo = angoliPalco()[taraStato.passo];
  const quante = taraStato.misure.size;
  bar.classList.remove('hidden');
  $('#tara-testo').innerHTML = `<b>Angolo ${taraStato.passo + 1} di 4</b> · punta `
    + `${quante === 1 ? 'la testa' : `tutte e ${quante} le teste`} sull'angolo del `
    + `pavimento <b>${angolo.nome}</b>, poi segna`;
  $('#tara-indietro').classList.toggle('hidden', taraStato.passo === 0);
}

function segnaAngolo() {
  if (!taraStato) return;
  for (const [id, misure] of taraStato.misure) {
    const f = state.fixtures.find((x) => x.id === id);
    if (!f) continue;
    misure[taraStato.passo] = {
      pan: panPosition(f) ?? 0,
      tilt: movePosition(f, 'tilt') ?? 0,
    };
  }
  taraStato.passo++;
  if (taraStato.passo < 4) aggiornaBarraTara();
  else mostraEsitiTaratura();
}

function mostraEsitiTaratura() {
  const esiti = [];
  for (const [id, misure] of taraStato.misure) {
    const f = state.fixtures.find((x) => x.id === id);
    if (f) esiti.push({ f, misure, r: risolviTaratura(misure) });
  }
  taraStato.esiti = esiti;

  const box = $('#tara-esiti');
  box.innerHTML = '';
  for (const e of esiti) {
    const riga = document.createElement('label');
    riga.className = 'tara-riga';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = !!e.r && e.r.scarto < TARA_BUONA;
    e.chk = chk;
    const testo = document.createElement('span');
    if (!e.r) {
      riga.classList.add('male');
      testo.innerHTML = `<b>${e.f.name}</b> — non riesco a ricavarne la posizione`;
    } else {
      const cm = Math.round(e.r.scarto * 100);
      const buona = e.r.scarto < TARA_BUONA;
      riga.classList.toggle('male', !buona);
      const versi = (e.r.vp < 0 ? ', pan invertito' : '')
        + (e.r.vt < 0 ? ', tilt invertito' : '');
      testo.innerHTML = `<b>${e.f.name}</b> — posizione ${e.r.P.x.toFixed(1)} × `
        + `${e.r.P.y.toFixed(1)} m, altezza ${e.r.h.toFixed(1)} m${versi}`
        + ` · scarto ${cm} cm ${buona ? '✓' : '⚠'}`;
    }
    riga.append(chk, testo);
    box.append(riga);
  }
  const male = esiti.filter((e) => !e.r || e.r.scarto >= TARA_BUONA).length;
  $('#tara-intro').textContent = male
    ? (male === 1 ? 'Una testa' : `${male} teste`)
      + ` su ${esiti.length} non torna${male === 1 ? '' : 'no'}: forse non era `
      + "puntata proprio sull'angolo, oppure ha un'escursione di pan/tilt diversa "
      + 'dal solito. Lascia la spunta solo a quelle giuste e rifai il giro per le altre.'
    : 'Lo scarto è quanto sbaglierebbe il fascio ai quattro angoli con questi '
      + 'valori: sotto i 30 cm la taratura è buona.';
  openModal('#modal-tara');
}

$('#btn-tara').addEventListener('click', iniziaTaratura);
$('#tara-salva').addEventListener('click', segnaAngolo);
$('#tara-esci').addEventListener('click', fineTaratura);
$('#tara-indietro').addEventListener('click', () => {
  if (!taraStato || !taraStato.passo) return;
  taraStato.passo--;
  aggiornaBarraTara();
});
$('#tara-rifai').addEventListener('click', () => {
  closeModals();
  if (!taraStato) return;
  taraStato.passo = 0;
  taraStato.esiti = null;
  aggiornaBarraTara();
});
$('#tara-applica').addEventListener('click', async () => {
  if (!taraStato || !taraStato.esiti) return;
  const scelti = taraStato.esiti.filter((e) => e.r && e.chk.checked);
  for (const e of scelti) {
    await applicaTaratura(e.f, e.r, e.misure).catch(console.error);
  }
  closeModals();
  fineTaratura();
  renderFixtures();
  if (scelti.length) {
    avvisoSelezione(`Tarate ${scelti.length} teste: posizione, altezza e zeri aggiornati`);
  }
});

/* il bersaglio da puntare, lampeggiante sull'angolo giusto della mappa */
function drawAngoloTara() {
  if (!taraStato || taraStato.passo > 3) return;
  const v = vista();
  const a = angoliPalco()[taraStato.passo];
  const x = Math.max(20, Math.min(cw - 20, v.ox + a.x * v.scala));
  const y = Math.max(20, Math.min(ch - 20, v.oy + a.y * v.scala));
  const r = 15 + Math.sin(performance.now() / 300) * 4;
  ctx.save();
  ctx.strokeStyle = '#f5d76e';
  ctx.fillStyle = 'rgba(245, 215, 110, 0.15)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - r - 6, y); ctx.lineTo(x + r + 6, y);
  ctx.moveTo(x, y - r - 6); ctx.lineTo(x, y + r + 6);
  ctx.stroke();
  ctx.restore();
}

function draw() {
  ctx.clearRect(0, 0, cw, ch);

  disegnaPalco();

  // fasci di luce (si sommano come luce reale)
  if (!state.blackout) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const f of state.fixtures) drawBeam(f);
    ctx.restore();
  }

  // corpi dei fari
  for (const f of state.fixtures) drawFixture(f);

  // selezione: il cerchio su tutti i fari scelti, le maniglie sul principale
  for (const f of state.fixtures) {
    if (!selectedIds.has(f.id)) continue;
    const p = fixturePos(f);
    ctx.strokeStyle = f.id === selectedId
      ? 'rgba(255,255,255,0.5)' : 'rgba(91,140,255,0.55)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const sel = state.fixtures.find((f) => f.id === selectedId);
  if (sel) {
    const p = fixturePos(sel);
    const hp = handlePos(sel);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(hp.x, hp.y);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(hp.x, hp.y, 6, 0, Math.PI * 2);
    ctx.fill();
    if (canAim(sel)) drawAimHandle(sel);
  }
  drawAimLine();
  drawAngoloTara();

  const inRotazione = dragMode === 'rotate' && dragFixture
    ? dragFixture
    : (rotateHint && performance.now() < rotateHint.until ? rotateHint.f : null);
  if (inRotazione && state.fixtures.includes(inRotazione)) drawRotateBadge(inRotazione);

  requestAnimationFrame(draw);
}

/* Il palco: un rettangolo con le proporzioni vere delle misure, con la
   griglia da un metro dentro. Tutt'attorno resta spazio per i fari che stanno
   fuori — davanti al proscenio, di lato, dietro il fondale. */
function disegnaPalco() {
  const g = stageGeo();
  const v = vista();
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.022)';
  ctx.fillRect(v.ox, v.oy, v.w, v.h);

  const passo = g.w > 24 || g.d > 24 ? 5 : 1;   // metri tra una linea e l'altra
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let m = passo; m < g.w - 1e-6; m += passo) {
    const x = v.ox + m * v.scala;
    ctx.moveTo(x, v.oy); ctx.lineTo(x, v.oy + v.h);
  }
  for (let m = passo; m < g.d - 1e-6; m += passo) {
    const y = v.oy + m * v.scala;
    ctx.moveTo(v.ox, y); ctx.lineTo(v.ox + v.w, y);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.strokeRect(v.ox, v.oy, v.w, v.h);

  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('F O N D A L E', v.ox + v.w / 2, Math.max(11, v.oy - 6));
  ctx.fillText('P U B B L I C O', v.ox + v.w / 2, Math.min(ch - 3, v.oy + v.h + 14));
  ctx.textAlign = 'left';
  ctx.fillText(`${g.w} × ${g.d} m`, v.ox + 4, v.oy + v.h - 5);
  ctx.restore();
}

function drawBeam(f) {
  const c = fixtureColor(f);
  if (c.intensity <= 0.004) return;
  const pr = proiezione(f, null, cw, ch);
  ctx.save();
  ctx.translate(pr.x, pr.y);

  if (!pr.metri) {
    // niente tilt, o fascio quasi orizzontale: cono lungo, come sempre
    ctx.save();
    ctx.rotate(-pr.ang);   // da qui in poi il fascio va verso il basso (+y)
    const len = pr.lung;
    const grad = ctx.createRadialGradient(0, 0, 4, 0, 0, len * 1.05);
    grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${0.55 * c.intensity})`);
    grad.addColorStop(0.6, `rgba(${c.r},${c.g},${c.b},${0.18 * c.intensity})`);
    grad.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-pr.largo, len);
    ctx.quadraticCurveTo(0, len * 1.1, pr.largo, len);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else {
    // il fascio arriva a terra: si vedono il corridoio di luce e la pozza
    const m = pr.metri;
    ctx.save();
    inScala(ctx, m);
    const scia = ctx.createLinearGradient(0, 0, 0, m.centro);
    scia.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${0.4 * c.intensity})`);
    scia.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
    ctx.fillStyle = scia;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-m.largo, m.centro);
    ctx.lineTo(m.largo, m.centro);
    ctx.closePath();
    ctx.fill();
    pozzaDiLuce(ctx, m, c, c.intensity);
    ctx.restore();
  }

  // bagliore sulla lente
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 14);
  glow.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${0.9 * c.intensity})`);
  glow.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* una testa mobile si riconosce dai canali di movimento */
function isMovingHead(f) {
  return fixtureChannels(f).some((c) => c.role === 'pan' || c.role === 'tilt');
}

function drawFixture(f) {
  const p = fixturePos(f);
  const c = fixtureColor(f);
  const on = !state.blackout && c.intensity > 0.01;
  const lente = on ? `rgb(${c.r},${c.g},${c.b})` : '#151922';
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(-angoloDisegno(f) * Math.PI / 180);
  ctx.strokeStyle = f.id === selectedId ? '#8fb0ff' : '#3a4356';
  ctx.lineWidth = 1.5;

  if (isMovingHead(f)) {
    // vista dall'alto: base tonda, forcella e testa orientata verso il fascio
    ctx.fillStyle = '#1b2029';
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#2b3444';
    roundRect(ctx, -11, -2, 4, 14, 2);   // braccio sinistro
    ctx.fill();
    ctx.stroke();
    roundRect(ctx, 7, -2, 4, 14, 2);     // braccio destro
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#242b38';
    roundRect(ctx, -6, 0, 12, 13, 3);    // testa
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = lente;
    ctx.beginPath();
    ctx.arc(0, 8, 4, 0, Math.PI * 2);    // lente tonda
    ctx.fill();
  } else {
    // par: corpo squadrato con la lente a fascia
    ctx.fillStyle = '#242b38';
    roundRect(ctx, -13, -9, 26, 18, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = lente;
    roundRect(ctx, -9, 4, 18, 5, 2);
    ctx.fill();
  }
  ctx.restore();

  // il nome sta sotto il faro, ma passa sopra se lo spazio in basso non basta
  const testo = `${f.name} · ${f.address}`;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  const mezzo = ctx.measureText(testo).width / 2;
  const x = Math.max(mezzo + 4, Math.min(cw - mezzo - 4, p.x));
  const y = p.y + 30 > ch - 6 ? p.y - 20 : p.y + 30;
  ctx.fillStyle = 'rgba(10, 12, 16, 0.65)';   // velo scuro per leggerlo sul fascio
  roundRect(ctx, x - mezzo - 3, y - 9, mezzo * 2 + 6, 12, 3);
  ctx.fill();
  ctx.fillStyle = 'rgba(223,227,234,0.9)';
  ctx.fillText(testo, x, y);
}

function roundRect(c2, x, y, w, h, r) {
  c2.beginPath();
  c2.moveTo(x + r, y);
  c2.arcTo(x + w, y, x + w, y + h, r);
  c2.arcTo(x + w, y + h, x, y + h, r);
  c2.arcTo(x, y + h, x, y, r);
  c2.arcTo(x, y, x + w, y, r);
  c2.closePath();
}

/* interazione con il palco */
const ROT_STEP = 15;      // scatti con il tasto Maiusc
let rotateHint = null;    // {f, until}: mostra i gradi mentre si ruota

function showRotateHint(f, ms = 1000) {
  rotateHint = { f, until: performance.now() + ms };
}

/* targhetta con i gradi accanto al faro che si sta ruotando */
function drawRotateBadge(f) {
  const p = fixturePos(f);
  const testo = `${Math.round(f.rot) % 360}°`;
  ctx.font = 'bold 12px sans-serif';
  const w = ctx.measureText(testo).width + 14;
  const x = p.x - w / 2;
  const y = p.y - 42;
  ctx.fillStyle = 'rgba(16, 20, 27, 0.9)';
  ctx.strokeStyle = '#5b8cff';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, 20, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#e8ecf3';
  ctx.textAlign = 'center';
  ctx.fillText(testo, p.x, y + 14);
}

let dragMode = null; // 'move' | 'rotate'
let dragFixture = null;
let dragOff = { x: 0, y: 0 };

canvas.addEventListener('pointerdown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const sel = state.fixtures.find((f) => f.id === selectedId);

  // si sta puntando: questo clic sceglie il punto da illuminare
  if (aimFixture) {
    if (aimMode === 'calibra') {
      calibraFaro(aimFixture, px, py);
      stopAiming();
      return;
    }
    const a = aimHandlePos(aimFixture);
    // riclic sul mirino: si esce senza cambiare niente
    if (Math.hypot(px - a.x, py - a.y) >= 14) aimAt(aimFixture, px, py);
    stopAiming();
    return;
  }
  if (canAim(sel)) {
    const a = aimHandlePos(sel);
    if (Math.hypot(px - a.x, py - a.y) < 14) {
      aimFixture = sel;
      aimPointer = { x: px, y: py };
      canvas.style.cursor = 'crosshair';
      return;
    }
  }
  if (sel) {
    const hp = handlePos(sel);
    if (Math.hypot(px - hp.x, py - hp.y) < 11) {
      dragMode = 'rotate';
      dragFixture = sel;
      canvas.setPointerCapture(e.pointerId);
      return;
    }
  }
  const f = fixtureAt(px, py);
  if (f) {
    selectFixture(f.id, true, e.shiftKey);
    if (e.shiftKey) return;          // con Maiusc si sceglie soltanto
    dragMode = 'move';
    dragFixture = f;
    const p = fixturePos(f);
    dragOff = { x: px - p.x, y: py - p.y };
    canvas.setPointerCapture(e.pointerId);
  } else {
    deselezionaTutti();
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (aimFixture) {
    const rect = canvas.getBoundingClientRect();
    aimPointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    canvas.style.cursor = 'crosshair';
    return;
  }
  if (!dragMode || !dragFixture) {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const sel = state.fixtures.find((f) => f.id === selectedId);
    if (canAim(sel)) {
      const a = aimHandlePos(sel);
      if (Math.hypot(px - a.x, py - a.y) < 14) {
        canvas.style.cursor = 'crosshair';
        return;
      }
    }
    canvas.style.cursor = fixtureAt(px, py) ? 'grab' : 'default';
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const f = dragFixture;
  if (dragMode === 'move') {
    // si può uscire dal palco: i fari stanno spesso davanti o di lato
    const n = puntoNorm(px - dragOff.x, py - dragOff.y);
    f.x = Math.max(-1, Math.min(2, n.x));
    f.y = Math.max(-1, Math.min(2, n.y));
    pushFixturePatch(f.id, { x: f.x, y: f.y });
  } else {
    // la direzione è quella vera sul palco, non quella sullo schermo
    const p = fixtureMetri(f);
    const m = puntoMetri(px, py);
    let ang = (Math.atan2(m.x - p.x, m.y - p.y) * 180 / Math.PI + 360) % 360;
    if (e.shiftKey) ang = (Math.round(ang / ROT_STEP) * ROT_STEP) % 360;
    f.rot = ang;
    f.panzero = panPosition(f) ?? 0;   // la nuova direzione diventa lo zero
    pushFixturePatch(f.id, { rot: f.rot, panzero: f.panzero });
    showRotateHint(f);
  }
});

canvas.addEventListener('pointerup', () => {
  dragMode = null;
  dragFixture = null;
});

canvas.addEventListener('wheel', (e) => {
  const rect = canvas.getBoundingClientRect();
  const f = fixtureAt(e.clientX - rect.left, e.clientY - rect.top);
  if (!f) return;
  e.preventDefault();
  const verso = e.deltaY > 0 ? 1 : -1;
  f.rot = e.shiftKey
    ? (Math.round(f.rot / ROT_STEP) * ROT_STEP + verso * ROT_STEP + 360) % 360
    : (f.rot + verso * 4 + 360) % 360;
  f.panzero = panPosition(f) ?? 0;
  pushFixturePatch(f.id, { rot: f.rot, panzero: f.panzero });
  showRotateHint(f);
}, { passive: false });

/* ---------------------------------------------------------------- modali */
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModals() {
  document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
}
document.querySelectorAll('.modal-close').forEach((b) =>
  b.addEventListener('click', closeModals));
document.querySelectorAll('.modal').forEach((m) =>
  m.addEventListener('pointerdown', (e) => { if (e.target === m) closeModals(); }));

function nextFreeAddress(n = NUM_CHANNELS) {
  let addr = 1;
  for (const f of [...state.fixtures].sort((a, b) => a.address - b.address)) {
    const span = fixtureSpan(f);
    if (addr + n - 1 >= f.address && addr <= f.address + span - 1) {
      addr = f.address + span;
    }
  }
  return Math.min(addr, 512 - n + 1);
}

function newFixturePosition(n) {
  return { x: 0.12 + 0.76 * ((n % 8) / 7), y: 0.15 + 0.18 * Math.floor(n / 8) };
}

/* Nome della copia: se finisce con un numero lo si fa avanzare (Par 1 ->
   Par 2), altrimenti si aggiunge "copia". */
function nomeCopia(nome) {
  const usati = new Set(state.fixtures.map((f) => f.name));
  const m = /^(.*?)(\d+)\s*$/.exec(nome);
  if (m) {
    let n = parseInt(m[2], 10);
    let scelto;
    do { scelto = `${m[1]}${++n}`.slice(0, 24); } while (usati.has(scelto) && n < 999);
    return scelto;
  }
  let scelto = `${nome} copia`.slice(0, 24);
  let n = 2;
  while (usati.has(scelto)) scelto = `${nome} copia ${n++}`.slice(0, 24);
  return scelto;
}

/* Duplica un faro: stessi canali, stesse luci, stessa direzione. Cambiano
   il nome, l'indirizzo (il primo libero) e la posizione, spostata di poco
   per non finire esattamente sopra l'originale. */
async function duplicaFaro(f) {
  const n = fixtureSpan(f);
  const res = await api('POST', '/api/fixtures', {
    name: nomeCopia(f.name),
    address: nextFreeAddress(n),
    count: n,
    channels: fixtureChannels(f).map((c) => ({ ...c })),
    values: [...f.values],
    x: Math.min(2, f.x + 0.05),
    y: Math.min(2, f.y + 0.05),
    rot: f.rot,
    panzero: f.panzero || 0,
    h: altezzaFaro(f),
    tiltzero: tiltZero(f),
    panflip: !!f.panflip,
    tiltflip: !!f.tiltflip,
    // la taratura no: la copia è un altro faro, appeso da un'altra parte
  });
  state.fixtures.push(res.fixture);
  renderFixtures();
  selectFixture(res.fixture.id);
}

async function addFixture(name, address, channels, count) {
  const pos = newFixturePosition(state.fixtures.length);
  const body = { name, address, x: pos.x, y: pos.y, rot: 0 };
  if (channels) body.channels = channels;
  if (count) body.count = count;
  const res = await api('POST', '/api/fixtures', body);
  state.fixtures.push(res.fixture);
  renderFixtures();
}

function addModalTemplate() {
  const m = /^tpl:(\d+)$/.exec($('#add-copy').value);
  return m ? CHANNEL_TEMPLATES[parseInt(m[1], 10)] : null;
}

function addModalCount() {
  const src = state.fixtures.find((x) => x.id === parseInt($('#add-copy').value, 10));
  if (src) return fixtureSpan(src);
  const tpl = addModalTemplate();
  if (tpl) return tpl.channels.length;
  return parseInt($('#add-count').value, 10) || 8;
}

function buildAddChannelRows() {
  const n = parseInt($('#add-count').value, 10) || 8;
  const wrap = $('#add-channels-rows');
  // cambiando 8<->16 si conservano le righe già compilate
  const prev = Array.from(wrap.children).map((row) => ({
    label: row.children[1].value,
    role: row.children[2].value,
  }));
  wrap.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const row = document.createElement('div');
    row.className = 'ch-row';
    const num = document.createElement('span');
    num.className = 'ch-num';
    num.textContent = `CH ${i + 1}`;
    const label = document.createElement('input');
    label.type = 'text';
    label.maxLength = 16;
    label.placeholder = `CH${i + 1}`;
    const role = document.createElement('select');
    for (const [value, text] of Object.entries(ROLE_LABELS)) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      role.append(o);
    }
    if (prev[i]) {
      label.value = prev[i].label;
      role.value = prev[i].role;
    } else {
      role.value = 'other';
    }
    // scegliendo il ruolo, il nome si compila da solo (se non personalizzato)
    role.addEventListener('change', () => {
      const cur = label.value.trim();
      if (!cur || Object.values(ROLE_LABELS).includes(cur)) {
        label.value = role.value === 'other' ? '' : ROLE_LABELS[role.value];
      }
    });
    row.append(num, label, role);
    wrap.append(row);
  }
}

function refreshAddModal() {
  const selVal = $('#add-copy').value;
  // copiando i canali da un faro o da un modello, il numero di canali segue quello
  const src = state.fixtures.find((x) => x.id === parseInt(selVal, 10));
  const tpl = addModalTemplate();
  const isNew = selVal === 'new';
  const countSel = $('#add-count');
  if (src) countSel.value = String(fixtureSpan(src));
  else if (tpl) countSel.value = String(tpl.channels.length);
  countSel.disabled = !!src || !!tpl;
  $('#add-channels-box').classList.toggle('hidden', !isNew);
  if (isNew) buildAddChannelRows();
  $('#add-address').value = nextFreeAddress(addModalCount());
}

$('#add-copy').addEventListener('change', refreshAddModal);
$('#add-count').addEventListener('change', refreshAddModal);

$('#btn-add').addEventListener('click', () => {
  $('#add-name').value = `Faro ${state.fixtures.length + 1}`;
  const copySel = $('#add-copy');
  copySel.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'Predefiniti (UkFog UV+RGB)';
  copySel.append(def);
  CHANNEL_TEMPLATES.forEach((tpl, i) => {
    const o = document.createElement('option');
    o.value = `tpl:${i}`;
    o.textContent = `${tpl.name} (${tpl.channels.length} canali)`;
    copySel.append(o);
  });
  const nuovo = document.createElement('option');
  nuovo.value = 'new';
  nuovo.textContent = 'Nuovo set di canali…';
  copySel.append(nuovo);
  for (const f of state.fixtures) {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = `Come "${f.name}" (${fixtureSpan(f)} canali)`;
    copySel.append(o);
  }
  $('#add-count').value = '8';
  $('#add-channels-rows').innerHTML = '';
  refreshAddModal();
  openModal('#modal-add');
  $('#add-name').select();
});

$('#btn-add-confirm').addEventListener('click', async () => {
  const name = $('#add-name').value.trim() || `Faro ${state.fixtures.length + 1}`;
  const address = parseInt($('#add-address').value, 10) || 1;
  const selVal = $('#add-copy').value;
  const src = state.fixtures.find((x) => x.id === parseInt(selVal, 10));
  const tpl = addModalTemplate();
  const count = addModalCount();
  let channels;
  if (selVal === 'new') {
    channels = Array.from($('#add-channels-rows').children).map((row, i) => ({
      label: row.children[1].value.trim() || `CH${i + 1}`,
      role: row.children[2].value,
    }));
  } else if (src) {
    channels = fixtureChannels(src);
  } else if (tpl) {
    channels = tpl.channels.map((c) => ({ ...c }));
  }
  closeModals();
  await addFixture(name, address, channels, count);
});

$('#btn-setup8').addEventListener('click', async () => {
  for (let i = 0; i < 8; i++) {
    await addFixture(`Faro ${i + 1}`, 1 + i * NUM_CHANNELS);
  }
});

/* configurazione canali (per faro) */
let channelsFixture = null;

function openChannelsModal(f) {
  channelsFixture = f;
  $('#channels-title').textContent = `Canali — ${f.name}`;
  const rows = $('#channels-rows');
  rows.innerHTML = '';
  fixtureChannels(f).forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'ch-row';
    const num = document.createElement('span');
    num.className = 'ch-num';
    num.textContent = `CH ${i + 1}`;
    const label = document.createElement('input');
    label.type = 'text';
    label.maxLength = 16;
    label.value = c.label;
    const role = document.createElement('select');
    for (const [value, text] of Object.entries(ROLE_LABELS)) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      role.append(o);
    }
    role.value = c.role;
    row.append(num, label, role);
    rows.append(row);
  });
  openModal('#modal-channels');
}

async function saveChannels(all) {
  if (!channelsFixture) return;
  const rows = Array.from($('#channels-rows').children);
  const channels = rows.map((row, i) => ({
    label: row.children[1].value.trim() || `CH${i + 1}`,
    role: row.children[2].value,
  }));
  const res = await api('PUT', `/api/fixtures/${channelsFixture.id}/channels`,
    { channels, all });
  state.fixtures = res.fixtures;
  state.channels = res.channels;
  closeModals();
  renderFixtures();
}

$('#btn-channels-save').addEventListener('click', () => saveChannels(false).catch(console.error));
$('#btn-channels-save-all').addEventListener('click', () => {
  if (!confirm('Applicare questi canali a TUTTI i fari?')) return;
  saveChannels(true).catch(console.error);
});

/* FTB e Blackout hanno un pulsante nella barra in alto e uno nella griglia
   dei preset: restano sempre accesi o spenti insieme */
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
function setButtonsOn(sel, on) {
  $$(sel).forEach((b) => b.classList.toggle('on', on));
}

/* blackout */
async function toggleBlackout() {
  const res = await api('PUT', '/api/blackout', { on: !state.blackout });
  state.blackout = res.blackout;
  setButtonsOn('.js-blackout', state.blackout);
  state.fixtures.forEach(updateSwatch);
  renderPresets();
  syncCueUI();   // il preset in onda passa al giallo (e viceversa)
}
$$('.js-blackout').forEach((b) =>
  b.addEventListener('click', () => toggleBlackout().catch(console.error)));
$$('.js-go').forEach((b) => {
  b.disabled = true;   // si accende quando c'è un preset pronto
  b.addEventListener('click', () => {
    b.blur();
    fireArmedPreset().catch(console.error);
  });
});

/* FTB: interruttore di dissolvenza a nero. Primo clic: memorizza le luci
   e le spegne gradualmente, il pulsante lampeggia rosso. Secondo clic:
   riporta tutto com'era prima, sempre in dissolvenza. Pan/Tilt/Focus/
   Return e i canali "Altro" (macro, velocità...) non vengono mai toccati. */
/* Con FTB e Blackout va a zero il dimmer: colori, strobo e posizione
   restano dove sono, così al ritorno la scena è identica. I fari senza
   canale dimmer non avrebbero modo di spegnersi: per quelli si abbassano
   i colori. */
const DIMMER_ROLES = new Set(['dimmer']);
const LUCI_ROLES = new Set(['dimmer', 'red', 'green', 'blue', 'uv', 'white', 'strobe']);

function ruoliSpegnimento(f) {
  return roleIndexes(f, 'dimmer').length ? DIMMER_ROLES : LUCI_ROLES;
}
/* nel passaggio tra preset il movimento non sfuma: le teste si riposizionano
   di netto, mentre luci, colori e zoom seguono la dissolvenza */
const PRESET_SNAP_ROLES = new Set(['pan', 'tilt']);
let fadeSeq = 0;
const fadePadrone = new Map();   // id faro -> dissolvenza che lo sta comandando
let ftbSnapshot = null;   // valori prima dell'FTB (null = FTB non attivo)

/* only: solo questi ruoli sfumano (gli altri restano fermi)
   skip: questi ruoli vanno subito a destinazione, gli altri sfumano */
/* restituisce una promessa: vera se la dissolvenza è arrivata in fondo,
   falsa se un'altra l'ha interrotta (serve al movimento al buio) */
function fadeValues(targets, durata, { only = null, skip = null } = {}) {
  // il comando dei fari toccati passa a questa dissolvenza; gli altri
  // proseguono per conto loro
  const token = ++fadeSeq;
  for (const id of targets.keys()) fadePadrone.set(id, token);
  const mio = (f) => fadePadrone.get(f.id) === token;
  // only/skip possono essere un insieme di ruoli oppure una funzione del
  // faro, perché lo spegnimento dipende da quali canali quel faro ha
  const insieme = (s, f) => (typeof s === 'function' ? s(f) : s);
  const sfumaSu = (f) => {
    const soli = only && insieme(only, f);
    const salta = skip && insieme(skip, f);
    return (ruolo) => (soli ? soli.has(ruolo) : !(salta && salta.has(ruolo)));
  };

  // i canali esclusi dalla dissolvenza scattano subito
  for (const f of state.fixtures) {
    const to = targets.get(f.id);
    if (!to || !mio(f)) continue;
    const chans = fixtureChannels(f);
    const sfuma = sfumaSu(f);
    f.values = f.values.map((v, i) => (sfuma(chans[i].role) ? v : to[i]));
    updateFixtureDisplays(f);
    pushValues(f);
  }

  const inizio = performance.now();
  const partenza = state.fixtures.map((f) => ({ f, from: [...f.values] }));
  // con la finestra nascosta requestAnimationFrame non scatta: senza una
  // rete di sicurezza la dissolvenza resterebbe congelata a metà
  const prossimo = (fn) => {
    let fatto = false;
    const unaVolta = () => { if (!fatto) { fatto = true; fn(); } };
    requestAnimationFrame(unaVolta);
    setTimeout(unaVolta, 250);
  };
  return new Promise((finita) => {
    const step = () => {
      const restano = partenza.some(({ f }) => targets.has(f.id) && mio(f));
      if (!restano) { finita(false); return; }
      const t = durata > 0 ? Math.min(1, (performance.now() - inizio) / durata) : 1;
      for (const { f, from } of partenza) {
        const to = targets.get(f.id);
        if (!to || !mio(f)) continue;
        const chans = fixtureChannels(f);
        const sfuma = sfumaSu(f);
        f.values = f.values.map((v, i) =>
          sfuma(chans[i].role)
            ? Math.round(from[i] + (to[i] - from[i]) * t)
            : v);
        updateFixtureDisplays(f);
        pushValues(f);
      }
      if (t < 1) prossimo(step);
      else finita(true);
    };
    prossimo(step);
  });
}

function ftbFade(target) {
  return fadeValues(target, fadeGroupValue('#ftb-time') * 1000, { only: ruoliSpegnimento });
}

function toggleFtb() {
  if (state.fixtures.length === 0) return;
  if (ftbSnapshot === null) {
    ftbSnapshot = new Map(state.fixtures.map((f) => [f.id, [...f.values]]));
    setButtonsOn('.js-ftb', true);
    ftbFade(soloLuciAZero());   // il movimento resta dov'è
  } else {
    const target = ftbSnapshot;
    ftbSnapshot = null;
    setButtonsOn('.js-ftb', false);
    ftbFade(target);
  }
  // il preset in onda resta segnato: giallo lampeggiante mentre le luci
  // sono giù, verde quando tornano su
  renderPresets();
  syncCueUI();
}

$$('.js-ftb').forEach((b) => b.addEventListener('click', toggleFtb));
setupFadeGroup(['#ftb-time', '#ftb-time-grid', '#ftb-time-copione'], 'lightstage-ftb-time');
setupFadeGroup(['#preset-fade', '#preset-fade-grid', '#preset-fade-copione'],
  'lightstage-preset-fade');

/* comandi accanto al palco: valgono per il prossimo preset che si salva */
(function controlliNuovoPreset() {
  const box = $('#stage-ctl');
  if (!box) return;
  const ctl = costruisciControlliPreset(
    () => ({ fade: fadeGroupValue('#preset-fade'), dark: defaultDark() }),
    (patch) => {
      if ('fade' in patch) impostaFade('lightstage-preset-fade', patch.fade);
      if ('dark' in patch) setDefaultDark(patch.dark);
      aggiornaControlliPreset();
    });
  box.append(ctl.el);
}());

/* scarica lo show come file (backup / trasferimento) */
function exportShow() {
  const data = {
    fixtures: state.fixtures,
    presets: state.presets,
    channels: state.channels,
    copioni: state.copioni,
    blackout: state.blackout,
    stage: state.stage,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'lightstage-show.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* scorciatoie da tastiera: 1–9/0 preset, B blackout, F fade to black;
   con Cmd/Ctrl: C connetti cavo, N nuovo faro, O finestra online, S salva */
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.altKey) return;
  if (e.code === 'Escape') {
    if (aimFixture) { stopAiming(); return; }
    if (taraStato && $('#modal-tara').classList.contains('hidden')) {
      fineTaratura();
      return;
    }
    if (!$('#copione').classList.contains('hidden')) { closeCopione(); return; }
    if (!$('#preset-grid').classList.contains('hidden')) { closeGrid(); return; }
  }
  if (e.code === 'Space') {
    e.preventDefault(); // niente scorrimento della pagina
    fireArmedPreset().catch(console.error);
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    if (e.code === 'KeyC') {
      if (window.getSelection().toString()) return; // lascia copiare il testo
      e.preventDefault();
      $('#btn-connect').click();
    } else if (e.code === 'KeyO') {
      const cloud = $('#btn-cloud');
      if (cloud) {
        e.preventDefault();
        cloud.click();
      }
    } else if (e.code === 'KeyS') {
      e.preventDefault();
      const save = $('#btn-save');
      if (save) save.click();
      else exportShow();
    }
    return;
  }
  if (document.querySelector('.modal:not(.hidden)')) return;
  const m = /^Digit(\d)$/.exec(e.code);
  if (m) {
    const slot = m[1] === '0' ? 9 : parseInt(m[1], 10) - 1;
    if (state.presets[slot]) loadPreset(slot).catch(console.error);
  } else if (e.code === 'KeyB') {
    toggleBlackout().catch(console.error);
  } else if (e.code === 'KeyF') {
    toggleFtb();
  } else if (e.code === 'KeyN') {
    // senza preventDefault la "n" finirebbe nel campo nome appena aperto
    e.preventDefault();
    $('#btn-add').click();
  } else if (e.code === 'KeyG') {
    if ($('#preset-grid').classList.contains('hidden')) openGrid();
    else closeGrid();
  } else if (e.code === 'KeyC') {
    if ($('#copione').classList.contains('hidden')) openCopione().catch(console.error);
    else closeCopione();
  }
});

/* Esporta e importa: è la strada per portare fari e preset dalla versione
   web a questa e viceversa. Nella versione web i due pulsanti li gestisce il
   suo backend locale, qui passano dal server. */
if (!window.LIGHTSTAGE_STATIC) {
  $('#btn-export').addEventListener('click', exportShow);
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm('Caricando il file, fari e preset di adesso vengono sostituiti. Procedere?')) return;
    const lettore = new FileReader();
    lettore.onload = async () => {
      try {
        await api('POST', '/api/import', JSON.parse(lettore.result));
        location.reload();
      } catch (err) {
        alert('File non valido: ' + (err.message || err));
      }
    };
    lettore.readAsText(file);
  });
}

/* connessione DMX */
$('#btn-connect').addEventListener('click', async () => {
  if (dmx.connected) {
    dmx = await api('POST', '/api/dmx/disconnect');
  } else {
    const port = window.LIGHTSTAGE_STATIC ? 'webserial' : $('#port-select').value;
    if (!port) return;
    dmx = await api('POST', '/api/dmx/connect', { port });
    if (!dmx.connected && dmx.error) {
      alert('Connessione fallita.\n\n' + dmx.error);
    }
  }
  renderDmx();
});

$('#btn-refresh-ports').addEventListener('click', async () => {
  dmx = await api('GET', '/api/dmx');
  renderDmx();
});

/* --------------------------------- sincronizzazione con altri dispositivi */
function applyRemoteState(s) {
  const structure = (fs) => JSON.stringify(fs.map((f) => [f.id, f.name, f.address, f.channels]));
  const structureChanged = structure(state.fixtures) !== structure(s.fixtures);
  const channelsChanged = JSON.stringify(state.channels) !== JSON.stringify(s.channels);

  if (JSON.stringify(state.copioni) !== JSON.stringify(s.copioni || [])) {
    state.copioni = s.copioni || [];
    if (typeof renderCopioneSelect === 'function') renderCopioneSelect();
    if (typeof updateCopioneCues === 'function') updateCopioneCues();
  }
  if (JSON.stringify(state.presets) !== JSON.stringify(s.presets)) {
    state.presets = s.presets;
    renderPresets();
    if (!$('#preset-grid').classList.contains('hidden')) renderGrid();
  }
  if (s.stage && JSON.stringify(state.stage) !== JSON.stringify(s.stage)) {
    state.stage = s.stage;
    renderGeo();
  }
  if (state.blackout !== s.blackout) {
    state.blackout = s.blackout;
    setButtonsOn('.js-blackout', state.blackout);
    state.fixtures.forEach(updateSwatch);
  }
  if (structureChanged || channelsChanged) {
    state.channels = s.channels;
    state.fixtures = s.fixtures;
    selectedIds = new Set([...selectedIds].filter(
      (id) => s.fixtures.some((f) => f.id === id)));
    if (selectedId !== null && !s.fixtures.some((f) => f.id === selectedId)) {
      selectedId = [...selectedIds][0] ?? null;
    }
    renderFixtures();
    return;
  }
  for (const nf of s.fixtures) {
    const f = state.fixtures.find((x) => x.id === nf.id);
    if (!f) continue;
    f.x = nf.x; f.y = nf.y; f.rot = nf.rot; f.panzero = nf.panzero;
    f.h = nf.h; f.tiltzero = nf.tiltzero; f.taratura = nf.taratura;
    f.panflip = nf.panflip; f.tiltflip = nf.tiltflip;
    if (JSON.stringify(f.values) !== JSON.stringify(nf.values)) {
      f.values = nf.values;
      updateFixtureDisplays(f);
    }
  }
}

/* ------------------------------- lavoro a più mani sullo stesso progetto
   Il server avvisa appena qualcosa cambia (regia, iPad, telefono...), così
   l'aggiornamento è immediato invece di aspettare il giro successivo. */
let showRev = -1;
let refreshTimer = null;

async function refreshFromServer() {
  const s2 = await api('GET', '/api/state');
  showRev = s2.rev !== undefined ? s2.rev : showRev;
  dmx = s2.dmx;
  lanUrl = s2.lan_url;
  $('#btn-network').classList.toggle('hidden', !lanUrl);
  applyRemoteState(s2);
  renderDmx();
}

function scheduleRefresh() {
  // mentre si sta manovrando qui, le modifiche locali hanno la precedenza
  if (Date.now() - lastInteraction < 1500 || dragMode || refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshFromServer().catch(() => { /* riprova al prossimo avviso */ });
  }, 120);
}

function startLiveSync() {
  if (window.LIGHTSTAGE_STATIC || !window.EventSource) return;
  try {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      const rev = parseInt(e.data, 10);
      if (rev === showRev) return;   // è una modifica fatta da qui
      scheduleRefresh();
    };
    // in caso di caduta il browser riconnette da solo; resta il giro ogni 2 s
  } catch (err) {
    /* niente notifiche: si continua con il controllo periodico */
  }
}

/* indirizzo per gli altri dispositivi */
$('#btn-network').addEventListener('click', () => {
  if (lanUrl) {
    prompt('Apri questo indirizzo da telefono, tablet o altri computer\n' +
      'collegati alla stessa rete Wi-Fi (copialo pure):', lanUrl);
  }
});

/* ------------------------------------------------- avviso di aggiornamento
   Il browser può servire una copia vecchia dell'app anche dopo un
   aggiornamento del sito: version.json viene letto ignorando la cache, così
   la versione nuova viene notata comunque e basta un clic per caricarla. */
async function checkForUpdate() {
  if (document.getElementById('update-bar')) return;   // avviso già mostrato
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const info = await res.json();
    if (!info.version || info.version === APP_VERSION) return;
    const bar = document.createElement('div');
    bar.id = 'update-bar';
    bar.append(`È disponibile la versione ${info.version} (stai usando la ${APP_VERSION}).`);
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = 'Aggiorna adesso';
    btn.addEventListener('click', () => {
      location.replace(`${location.pathname}?v=${encodeURIComponent(info.version)}`);
    });
    const close = document.createElement('button');
    close.className = 'btn ghost';
    close.textContent = 'Più tardi';
    close.addEventListener('click', () => bar.remove());
    bar.append(btn, close);
    document.body.append(bar);
  } catch (err) {
    /* offline o file assente: nessun avviso */
  }
}

/* il controllo si ripete da solo: chi tiene la pagina aperta tutto il giorno
   si accorge dell'aggiornamento entro un minuto, senza ricaricare a mano */
setInterval(() => checkForUpdate(), 60000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkForUpdate();
});

/* ------------------------------------------------------------------ init */
async function init() {
  const s = await api('GET', '/api/state');
  state.fixtures = s.fixtures;
  state.presets = s.presets;
  state.channels = s.channels;
  state.copioni = s.copioni || [];
  state.blackout = s.blackout;
  if (s.stage) state.stage = s.stage;
  dmx = s.dmx;
  lanUrl = s.lan_url;
  if (s.rev !== undefined) showRev = s.rev;
  $('#btn-network').classList.toggle('hidden', !lanUrl);
  setButtonsOn('.js-blackout', state.blackout);
  $('#app-version').textContent = `v${APP_VERSION}`;
  $('#app-version-grid').textContent = `v${APP_VERSION}`;
  // su Windows/Linux la legenda mostra Ctrl al posto di ⌘
  if (!/Mac/i.test(navigator.platform)) {
    document.querySelectorAll('#credits kbd.mod').forEach((k) => {
      k.textContent = k.textContent.replace('⌘', 'Ctrl+');
    });
  }
  renderGeo();
  renderFixtures();
  renderPresets();
  renderDmx();
  resizeCanvas();
  requestAnimationFrame(draw);
  checkForUpdate();
  setInterval(async () => {
    try {
      // le modifiche fatte da altri dispositivi arrivano qui
      if (Date.now() - lastInteraction < 1500 || dragMode) {
        dmx = await api('GET', '/api/dmx');
      } else {
        await refreshFromServer();
      }
      renderDmx();
    } catch (err) { /* server non raggiungibile: riprova al prossimo giro */ }
  }, 2000);
  startLiveSync();
}

window.addEventListener('resize', () => { resizeCanvas(); sizeFaders(); });
init().catch((err) => {
  console.error(err);
  alert('Impossibile contattare il server LightStage: ' + err.message);
});
