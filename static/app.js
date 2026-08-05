'use strict';

/* ------------------------------------------------------------------ stato */
const state = {
  fixtures: [],
  presets: [],
  channels: [],
  blackout: false,
};
let dmx = { available: false, connected: false, port: null, ports: [], error: null };
let selectedId = null;
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
  other: '#8a93a5',
};
const ROLE_LABELS = {
  dimmer: 'Dimmer generale',
  red: 'Rosso',
  green: 'Verde',
  blue: 'Blu',
  uv: 'UV',
  white: 'Bianco',
  other: 'Altro',
};

const $ = (sel) => document.querySelector(sel);

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

function fixtureColor(f) {
  let master = null;
  let r = 0, g = 0, b = 0, uv = 0, w = 0;
  let hasColor = false;
  fixtureChannels(f).forEach((c, i) => {
    const v = f.values[i] || 0;
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
    if (master === null) master = Math.max(0, ...f.values);
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
  roleIndexes(f, 'red').forEach((i) => { f.values[i] = r; });
  roleIndexes(f, 'green').forEach((i) => { f.values[i] = g; });
  roleIndexes(f, 'blue').forEach((i) => { f.values[i] = b; });
  // se il dimmer è a zero il colore non si vedrebbe: accendilo
  const dim = roleIndexes(f, 'dimmer');
  if ((r || g || b) && dim.length && dim.every((i) => f.values[i] === 0)) {
    dim.forEach((i) => { f.values[i] = 255; });
  }
  updateFixtureDisplays(f);
  pushValues(f);
  clearActivePreset();
}

function clearActivePreset() {
  if (activePreset !== null) {
    activePreset = null;
    renderPresets();
  }
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
    if (f.id === selectedId) card.classList.add('selected');

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

    const cfg = document.createElement('button');
    cfg.className = 'cfg';
    cfg.textContent = '⚙';
    cfg.title = 'Canali di questo faro';
    cfg.addEventListener('click', (e) => {
      e.stopPropagation();
      openChannelsModal(f);
    });

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Elimina faro';
    del.addEventListener('click', async () => {
      if (!confirm(`Eliminare "${f.name}"?`)) return;
      await api('DELETE', `/api/fixtures/${f.id}`).catch(console.error);
      state.fixtures = state.fixtures.filter((x) => x.id !== f.id);
      if (selectedId === f.id) selectedId = null;
      renderFixtures();
    });

    head.append(swatch, picker, name, addrWrap, cfg, del);

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
        f.values[i] = parseInt(input.value, 10);
        val.textContent = input.value;
        updateFaderFill(input);
        updateSwatch(f);
        pushValues(f);
        clearActivePreset();
      });
      input.addEventListener('pointerdown', () => selectFixture(f.id));
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
      selectFixture(f.id, false);
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

function selectFixture(id, scroll = true) {
  if (selectedId === id) return;
  selectedId = id;
  cardRefs.forEach((ref, fid) => {
    ref.card.classList.toggle('selected', fid === id);
    if (fid === id && scroll) {
      ref.card.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    }
  });
}

/* ---------------------------------------------------------------- preset */
function renderPresets() {
  const bar = $('#presets-bar');
  bar.innerHTML = '';
  state.presets.forEach((p, i) => {
    const slot = document.createElement('div');
    slot.className = 'preset ' + (p ? 'used' : 'empty');
    if (i === activePreset) slot.classList.add('active');

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

async function savePreset(slot, existing) {
  const name = prompt('Nome del preset:', existing ? existing.name : `Preset ${slot + 1}`);
  if (name === null) return;
  const res = await api('POST', `/api/presets/${slot}`, { name: name.trim() || `Preset ${slot + 1}` });
  state.presets = res.presets;
  activePreset = slot;
  renderPresets();
}

async function loadPreset(slot) {
  const res = await api('POST', `/api/presets/${slot}/load`);
  for (const nf of res.fixtures) {
    const f = state.fixtures.find((x) => x.id === nf.id);
    if (f) {
      f.values = nf.values;
      updateFixtureDisplays(f);
    }
  }
  activePreset = slot;
  renderPresets();
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
      dot.classList.add('ok');
      label.textContent = 'connesso al cavo USB-DMX';
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

function fixturePos(f) {
  return { x: f.x * cw, y: f.y * ch };
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
  const th = f.rot * Math.PI / 180;
  return { x: p.x + Math.sin(th) * 40, y: p.y + Math.cos(th) * 40 };
}

function draw() {
  ctx.clearRect(0, 0, cw, ch);

  // griglia
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  const step = 40;
  ctx.beginPath();
  for (let x = step; x < cw; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, ch); }
  for (let y = step; y < ch; y += step) { ctx.moveTo(0, y); ctx.lineTo(cw, y); }
  ctx.stroke();

  // etichette palco
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('F O N D A L E', cw / 2, 16);
  ctx.fillText('P U B B L I C O', cw / 2, ch - 8);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.moveTo(0, ch - 24); ctx.lineTo(cw, ch - 24);
  ctx.stroke();

  // fasci di luce (si sommano come luce reale)
  if (!state.blackout) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const f of state.fixtures) drawBeam(f);
    ctx.restore();
  }

  // corpi dei fari
  for (const f of state.fixtures) drawFixture(f);

  // selezione + maniglia di rotazione
  const sel = state.fixtures.find((f) => f.id === selectedId);
  if (sel) {
    const p = fixturePos(sel);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
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
  }

  requestAnimationFrame(draw);
}

function drawBeam(f) {
  const c = fixtureColor(f);
  if (c.intensity <= 0.004) return;
  const p = fixturePos(f);
  const len = Math.min(cw, ch) * 0.55;
  const half = 24 * Math.PI / 180;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(-f.rot * Math.PI / 180);

  const grad = ctx.createRadialGradient(0, 0, 4, 0, 0, len * 1.05);
  grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${0.55 * c.intensity})`);
  grad.addColorStop(0.6, `rgba(${c.r},${c.g},${c.b},${0.18 * c.intensity})`);
  grad.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-Math.sin(half) * len, Math.cos(half) * len);
  ctx.quadraticCurveTo(0, len * 1.1, Math.sin(half) * len, Math.cos(half) * len);
  ctx.closePath();
  ctx.fill();

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

function drawFixture(f) {
  const p = fixturePos(f);
  const c = fixtureColor(f);
  const on = !state.blackout && c.intensity > 0.01;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(-f.rot * Math.PI / 180);
  ctx.fillStyle = '#242b38';
  ctx.strokeStyle = f.id === selectedId ? '#8fb0ff' : '#3a4356';
  ctx.lineWidth = 1.5;
  roundRect(ctx, -13, -9, 26, 18, 4);
  ctx.fill();
  ctx.stroke();
  // lente sul lato del fascio
  ctx.fillStyle = on ? `rgb(${c.r},${c.g},${c.b})` : '#151922';
  roundRect(ctx, -9, 4, 18, 5, 2);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = 'rgba(223,227,234,0.85)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${f.name} · ${f.address}`, p.x, p.y + 30);
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
let dragMode = null; // 'move' | 'rotate'
let dragFixture = null;
let dragOff = { x: 0, y: 0 };

canvas.addEventListener('pointerdown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const sel = state.fixtures.find((f) => f.id === selectedId);
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
    selectFixture(f.id);
    dragMode = 'move';
    dragFixture = f;
    const p = fixturePos(f);
    dragOff = { x: px - p.x, y: py - p.y };
    canvas.setPointerCapture(e.pointerId);
  } else {
    selectedId = null;
    cardRefs.forEach((ref) => ref.card.classList.remove('selected'));
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragMode || !dragFixture) {
    const rect = canvas.getBoundingClientRect();
    canvas.style.cursor =
      fixtureAt(e.clientX - rect.left, e.clientY - rect.top) ? 'grab' : 'default';
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const f = dragFixture;
  if (dragMode === 'move') {
    f.x = Math.max(0.02, Math.min(0.98, (px - dragOff.x) / cw));
    f.y = Math.max(0.02, Math.min(0.98, (py - dragOff.y) / ch));
    pushFixturePatch(f.id, { x: f.x, y: f.y });
  } else {
    const p = fixturePos(f);
    f.rot = (Math.atan2(px - p.x, py - p.y) * 180 / Math.PI + 360) % 360;
    pushFixturePatch(f.id, { rot: f.rot });
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
  f.rot = (f.rot + (e.deltaY > 0 ? 4 : -4) + 360) % 360;
  pushFixturePatch(f.id, { rot: f.rot });
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

async function addFixture(name, address, channels, count) {
  const pos = newFixturePosition(state.fixtures.length);
  const body = { name, address, x: pos.x, y: pos.y, rot: 0 };
  if (channels) body.channels = channels;
  if (count) body.count = count;
  const res = await api('POST', '/api/fixtures', body);
  state.fixtures.push(res.fixture);
  renderFixtures();
}

function addModalCount() {
  const src = state.fixtures.find((x) => x.id === parseInt($('#add-copy').value, 10));
  return src ? fixtureSpan(src) : (parseInt($('#add-count').value, 10) || 8);
}

function refreshAddModal() {
  // copiando i canali da un faro esistente, il numero di canali segue quello
  const src = state.fixtures.find((x) => x.id === parseInt($('#add-copy').value, 10));
  const countSel = $('#add-count');
  if (src) countSel.value = String(fixtureSpan(src));
  countSel.disabled = !!src;
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
  for (const f of state.fixtures) {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = `Come "${f.name}" (${fixtureSpan(f)} canali)`;
    copySel.append(o);
  }
  $('#add-count').value = '8';
  refreshAddModal();
  openModal('#modal-add');
  $('#add-name').select();
});

$('#btn-add-confirm').addEventListener('click', async () => {
  const name = $('#add-name').value.trim() || `Faro ${state.fixtures.length + 1}`;
  const address = parseInt($('#add-address').value, 10) || 1;
  const src = state.fixtures.find((x) => x.id === parseInt($('#add-copy').value, 10));
  const count = addModalCount();
  closeModals();
  await addFixture(name, address, src ? fixtureChannels(src) : undefined, count);
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

/* blackout */
async function toggleBlackout() {
  const res = await api('PUT', '/api/blackout', { on: !state.blackout });
  state.blackout = res.blackout;
  $('#btn-blackout').classList.toggle('on', state.blackout);
  state.fixtures.forEach(updateSwatch);
}
$('#btn-blackout').addEventListener('click', () => toggleBlackout().catch(console.error));

/* scorciatoie da tastiera per il live: 1–9 e 0 caricano i preset,
   B attiva/disattiva il blackout */
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.matches('input, select, textarea')) return;
  if (document.querySelector('.modal:not(.hidden)')) return;
  const m = /^Digit(\d)$/.exec(e.code);
  if (m) {
    const slot = m[1] === '0' ? 9 : parseInt(m[1], 10) - 1;
    if (state.presets[slot]) loadPreset(slot).catch(console.error);
  } else if (e.code === 'KeyB') {
    toggleBlackout().catch(console.error);
  }
});

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

  if (JSON.stringify(state.presets) !== JSON.stringify(s.presets)) {
    state.presets = s.presets;
    renderPresets();
  }
  if (state.blackout !== s.blackout) {
    state.blackout = s.blackout;
    $('#btn-blackout').classList.toggle('on', state.blackout);
    state.fixtures.forEach(updateSwatch);
  }
  if (structureChanged || channelsChanged) {
    state.channels = s.channels;
    state.fixtures = s.fixtures;
    if (selectedId !== null && !s.fixtures.some((f) => f.id === selectedId)) {
      selectedId = null;
    }
    renderFixtures();
    return;
  }
  for (const nf of s.fixtures) {
    const f = state.fixtures.find((x) => x.id === nf.id);
    if (!f) continue;
    f.x = nf.x; f.y = nf.y; f.rot = nf.rot;
    if (JSON.stringify(f.values) !== JSON.stringify(nf.values)) {
      f.values = nf.values;
      updateFixtureDisplays(f);
    }
  }
}

/* indirizzo per gli altri dispositivi */
$('#btn-network').addEventListener('click', () => {
  if (lanUrl) {
    prompt('Apri questo indirizzo da telefono, tablet o altri computer\n' +
      'collegati alla stessa rete Wi-Fi (copialo pure):', lanUrl);
  }
});

/* ------------------------------------------------------------------ init */
async function init() {
  const s = await api('GET', '/api/state');
  state.fixtures = s.fixtures;
  state.presets = s.presets;
  state.channels = s.channels;
  state.blackout = s.blackout;
  dmx = s.dmx;
  lanUrl = s.lan_url;
  $('#btn-network').classList.toggle('hidden', !lanUrl);
  $('#btn-blackout').classList.toggle('on', state.blackout);
  renderFixtures();
  renderPresets();
  renderDmx();
  resizeCanvas();
  requestAnimationFrame(draw);
  setInterval(async () => {
    try {
      // le modifiche fatte da altri dispositivi arrivano qui
      if (Date.now() - lastInteraction < 1500 || dragMode) {
        dmx = await api('GET', '/api/dmx');
      } else {
        const s2 = await api('GET', '/api/state');
        dmx = s2.dmx;
        lanUrl = s2.lan_url;
        $('#btn-network').classList.toggle('hidden', !lanUrl);
        applyRemoteState(s2);
      }
      renderDmx();
    } catch (err) { /* server non raggiungibile: riprova al prossimo giro */ }
  }, 2000);
}

window.addEventListener('resize', () => { resizeCanvas(); sizeFaders(); });
init().catch((err) => {
  console.error(err);
  alert('Impossibile contattare il server LightStage: ' + err.message);
});
