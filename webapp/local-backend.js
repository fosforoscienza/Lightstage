'use strict';

/* Backend locale per la versione "sito" di LightStage: nessun server,
   i dati vivono nel localStorage del browser e il DMX esce dal cavo
   USB tramite l'API Web Serial (Chrome/Edge). */
(function () {
  const NUM_CHANNELS = 8;   // predefinito: i fari possono averne anche 16
  const NUM_PRESETS = 100;
  const STORE_KEY = 'lightstage-show';
  const DEFAULT_CHANNELS = [
    { label: 'Dimmer', role: 'dimmer' },
    { label: 'Rosso', role: 'red' },
    { label: 'Verde', role: 'green' },
    { label: 'Blu', role: 'blue' },
    { label: 'UV', role: 'uv' },
    { label: 'Strobo', role: 'strobe' },
    { label: 'Macro', role: 'other' },
    { label: 'Velocità', role: 'other' },
  ];
  const ROLES = new Set(['dimmer', 'red', 'green', 'blue', 'uv', 'white',
    'strobe', 'pan', 'tilt', 'focus', 'return', 'other']);

  const FADE_STEPS = [0, 0.5, 1, 1.5];

  /* durata di dissolvenza del preset: uno dei tempi previsti, 0 = netto */
  function sanitizeFade(raw) {
    const v = parseFloat(raw);
    if (isNaN(v)) return 1;
    return FADE_STEPS.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
  }

  function sanitizeValues(raw, n = NUM_CHANNELS) {
    const vals = new Array(n).fill(0);
    if (Array.isArray(raw)) {
      for (let i = 0; i < Math.min(n, raw.length); i++) {
        const v = parseInt(raw[i], 10);
        if (!isNaN(v)) vals[i] = Math.max(0, Math.min(255, v));
      }
    }
    return vals;
  }

  function sanitizeChannels(raw, fallback, n = NUM_CHANNELS) {
    const base = fallback || DEFAULT_CHANNELS;
    const channels = [];
    if (Array.isArray(raw)) {
      raw.slice(0, n).forEach((c, i) => {
        if (c && typeof c === 'object') {
          channels.push({
            label: String(c.label || `CH${i + 1}`).slice(0, 16),
            role: ROLES.has(c.role) ? c.role : 'other',
          });
        }
      });
    }
    while (channels.length < n) {
      const i = channels.length;
      channels.push(i < base.length
        ? { ...base[i] }
        : { label: `CH${i + 1}`, role: 'other' });
    }
    return channels;
  }

  function fixtureCount(f) {
    return f.channels.length; // 8 o 16
  }

  function requestedCount(b) {
    if (b.count === 16 || parseInt(b.count, 10) === 16) return 16;
    if (Array.isArray(b.channels) && b.channels.length === 16) return 16;
    return NUM_CHANNELS;
  }

  function sanitizeShow(data) {
    const db = {
      next_id: 1,
      fixtures: [],
      presets: new Array(NUM_PRESETS).fill(null),
      channels: DEFAULT_CHANNELS.map((c) => ({ ...c })),
      copioni: [],
      next_copione: 1,
      blackout: false,
    };
    if (!data || typeof data !== 'object') return db;
    db.channels = sanitizeChannels(data.channels);
    for (const f of data.fixtures || []) {
      const id = parseInt(f.id, 10);
      if (isNaN(id)) continue;
      const n = Array.isArray(f.channels) && f.channels.length === 16 ? 16 : NUM_CHANNELS;
      db.fixtures.push({
        id,
        name: String(f.name || 'Faro').slice(0, 24),
        address: Math.max(1, Math.min(512 - n + 1, parseInt(f.address, 10) || 1)),
        values: sanitizeValues(f.values, n),
        channels: sanitizeChannels(f.channels, db.channels, n),
        x: Math.max(0, Math.min(1, parseFloat(f.x) || 0.5)),
        y: Math.max(0, Math.min(1, parseFloat(f.y) || 0.2)),
        rot: ((parseFloat(f.rot) || 0) % 360 + 360) % 360,
        panzero: Math.max(0, Math.min(1, parseFloat(f.panzero) || 0)),
      });
    }
    (data.presets || []).slice(0, NUM_PRESETS).forEach((p, i) => {
      if (p && typeof p === 'object' && p.values) {
        const values = {};
        for (const [k, v] of Object.entries(p.values)) values[k] = sanitizeValues(v, 16);
        db.presets[i] = {
          name: String(p.name || `Preset ${i + 1}`).slice(0, 24),
          fade: sanitizeFade(p.fade),
          dark: !!p.dark,
          values,
        };
      }
    });
    for (const c of data.copioni || []) {
      const id = parseInt(c.id, 10);
      if (isNaN(id)) continue;
      const cues = [];
      for (const q of c.cues || []) {
        const qid = parseInt(q.id, 10);
        const preset = parseInt(q.preset, 10);
        const pos = parseFloat(q.pos);
        if (isNaN(qid) || isNaN(preset) || isNaN(pos)) continue;
        cues.push({
          id: qid,
          pos: Math.max(0, Math.min(1, pos)),
          preset: Math.max(0, Math.min(NUM_PRESETS - 1, preset)),
        });
      }
      cues.sort((a, b) => a.pos - b.pos);
      db.copioni.push({
        id,
        name: String(c.name || 'Copione').slice(0, 40),
        cues,
        pdf: !!c.pdf,
      });
    }
    db.next_copione = Math.max(0, ...db.copioni.map((c) => c.id)) + 1;
    db.blackout = !!data.blackout;
    db.next_id = Math.max(0, ...db.fixtures.map((f) => f.id)) + 1;
    return db;
  }

  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY));
    } catch (err) {
      return null;
    }
  }

  let db = sanitizeShow(load());

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(db));
    } catch (err) {
      console.error('salvataggio non riuscito:', err);
    }
  }

  /* ---------------------------- archivio dei PDF dei copioni nel browser
     I PDF sono troppo grandi per il localStorage: vanno in IndexedDB. */
  const PDF_DB = 'lightstage-pdf';
  function withPdfStore(modo) {
    return new Promise((risolvi, rifiuta) => {
      const req = indexedDB.open(PDF_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('pdf');
      req.onerror = () => rifiuta(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('pdf', modo);
        risolvi({ store: tx.objectStore('pdf'), db: req.result });
      };
    });
  }
  function pdfRequest(modo, azione) {
    return withPdfStore(modo).then(({ store, db: idb }) => new Promise((risolvi, rifiuta) => {
      const r = azione(store);
      r.onsuccess = () => { risolvi(r.result); idb.close(); };
      r.onerror = () => { rifiuta(r.error); idb.close(); };
    }));
  }
  window.LIGHTSTAGE_PDF = {
    salva: (id, blob) => pdfRequest('readwrite', (s2) => s2.put(blob, String(id))),
    leggi: (id) => pdfRequest('readonly', (s2) => s2.get(String(id))),
  };
  function deletePdf(id) {
    return pdfRequest('readwrite', (s2) => s2.delete(String(id)));
  }

  /* ------------------------------------------- uscita DMX via Web Serial
     Con la finestra in secondo piano il browser rallenta i timer a un colpo
     al secondo: l'invio DMX si fermerebbe e le teste, rimaste senza segnale,
     ripartirebbero con il loro programma interno muovendosi da sole. Per
     evitarlo i tempi li scandisce un piccolo worker, che non viene frenato,
     e finché il cavo è collegato la pagina tiene aperto un suono muto: le
     pagine che stanno "suonando" non vengono rallentate. */
  function creaAttesa() {
    try {
      const src = 'onmessage=e=>{setTimeout(()=>postMessage(e.data.id),e.data.ms)}';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const w = new Worker(url);
      const attese = new Map();
      let seq = 0;
      w.onmessage = (e) => {
        const pronto = attese.get(e.data);
        if (pronto) { attese.delete(e.data); pronto(); }
      };
      return (ms) => new Promise((r) => {
        const id = ++seq;
        attese.set(id, r);
        w.postMessage({ id, ms });
      });
    } catch (err) {
      return (ms) => new Promise((r) => setTimeout(r, ms));
    }
  }
  const attendi = creaAttesa();

  let suonoMuto = null;
  function tieniSveglia(on) {
    try {
      if (on && !suonoMuto) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const osc = ctx.createOscillator();
        const vol = ctx.createGain();
        vol.gain.value = 0;              // muto: serve solo a restare svegli
        osc.connect(vol);
        vol.connect(ctx.destination);
        osc.start();
        if (ctx.state === 'suspended') ctx.resume();
        suonoMuto = { ctx, osc };
      } else if (!on && suonoMuto) {
        suonoMuto.osc.stop();
        suonoMuto.ctx.close();
        suonoMuto = null;
      }
    } catch (err) { /* senza audio si va avanti lo stesso */ }
  }

  const dmxOut = {
    port: null,
    writer: null,
    running: false,
    error: null,
    slow: false,      // il browser sta frenando l'invio (finestra nascosta)
    frame: new Uint8Array(513), // byte 0 = start code

    get connected() { return !!this.port; },

    async connect() {
      if (!('serial' in navigator)) {
        this.error = 'questo browser non supporta Web Serial: usa Chrome o Edge';
        return false;
      }
      try {
        const port = await navigator.serial.requestPort();
        await port.open({
          baudRate: 250000,
          dataBits: 8,
          stopBits: 2,
          parity: 'none',
          flowControl: 'none',
        });
        try {
          await port.setSignals({ dataTerminalReady: false, requestToSend: false });
        } catch (err) { /* non tutti i driver lo permettono */ }
        this.port = port;
        this.writer = port.writable.getWriter();
        this.error = null;
        this.running = true;
        this.slow = false;
        tieniSveglia(true);
        this.loop();
        return true;
      } catch (err) {
        // NotFoundError = l'utente ha chiuso la finestra di scelta: non è un errore
        this.error = err && err.name === 'NotFoundError'
          ? null
          : 'connessione fallita: ' + (err.message || err);
        this.port = null;
        this.writer = null;
        return false;
      }
    },

    async disconnect() {
      this.running = false;
      this.slow = false;
      tieniSveglia(false);
      const writer = this.writer;
      const port = this.port;
      this.writer = null;
      this.port = null;
      try { if (writer) writer.releaseLock(); } catch (err) { /* già chiuso */ }
      try { if (port) await port.close(); } catch (err) { /* già chiuso */ }
    },

    async loop() {
      let ultimo = performance.now();
      let lenti = 0;
      while (this.running && this.port) {
        const port = this.port;
        const writer = this.writer;
        try {
          await port.setSignals({ break: true });   // break (minimo 88 µs)
          await attendi(2);
          await port.setSignals({ break: false });
          await writer.write(this.frame);
        } catch (err) {
          this.error = 'errore sul cavo: ' + (err.message || err);
          await this.disconnect();
          break;
        }
        // se il browser ci sta rallentando comunque, meglio dirlo
        const ora = performance.now();
        lenti = ora - ultimo > 250 ? lenti + 1 : 0;
        this.slow = lenti > 4;
        ultimo = ora;
        await attendi(25); // ~25-30 frame al secondo
      }
    },
  };

  function rebuildFrame() {
    const frame = new Uint8Array(513);
    if (!db.blackout) {
      for (const f of db.fixtures) {
        f.values.forEach((v, i) => {
          const ch = f.address + i;
          if (ch >= 1 && ch <= 512) frame[ch] = Math.max(frame[ch], v);
        });
      }
    }
    dmxOut.frame = frame;
  }

  function dmxState() {
    return {
      available: 'serial' in navigator,
      connected: dmxOut.connected,
      port: dmxOut.connected ? 'cavo USB-DMX' : null,
      error: dmxOut.error,
      slow: dmxOut.slow,
      ports: [],
    };
  }

  function findFixture(id) {
    return db.fixtures.find((f) => f.id === id) || null;
  }

  /* ----------------------------- le stesse "rotte" del server, in locale */
  window.LIGHTSTAGE_STATIC = true;
  window.LOCAL_BACKEND = async function (method, url, body) {
    // come una vera API: dentro ed entro solo copie, mai riferimenti condivisi
    const result = await route(method, url,
      body === undefined ? undefined : structuredClone(body));
    return structuredClone(result);
  };

  async function route(method, url, body) {
    const m = method.toUpperCase();
    let match;

    if (m === 'GET' && url === '/api/state') {
      return {
        fixtures: db.fixtures,
        presets: db.presets,
        channels: db.channels,
        copioni: db.copioni,
        blackout: db.blackout,
        dmx: dmxState(),
        lan_url: null,
      };
    }
    if (m === 'GET' && url === '/api/dmx') return dmxState();
    if (m === 'POST' && url === '/api/dmx/connect') {
      await dmxOut.connect();
      return dmxState();
    }
    if (m === 'POST' && url === '/api/dmx/disconnect') {
      await dmxOut.disconnect();
      return dmxState();
    }
    if (m === 'POST' && url === '/api/fixtures') {
      const b = body || {};
      const n = requestedCount(b);
      const fixture = {
        id: db.next_id++,
        name: String(b.name || `Faro ${db.next_id - 1}`).slice(0, 24),
        address: Math.max(1, Math.min(512 - n + 1, parseInt(b.address, 10) || 1)),
        values: sanitizeValues(b.values, n),
        channels: sanitizeChannels(b.channels, db.channels, n),
        x: Math.max(0, Math.min(1, parseFloat(b.x) || 0.5)),
        y: Math.max(0, Math.min(1, parseFloat(b.y) || 0.2)),
        rot: ((parseFloat(b.rot) || 0) % 360 + 360) % 360,
        panzero: Math.max(0, Math.min(1, parseFloat(b.panzero) || 0)),
      };
      db.fixtures.push(fixture);
      rebuildFrame();
      save();
      return { fixture };
    }
    if ((match = /^\/api\/fixtures\/(\d+)\/values$/.exec(url)) && m === 'PUT') {
      const f = findFixture(parseInt(match[1], 10));
      if (!f) throw new Error('faro non trovato');
      f.values = sanitizeValues((body || {}).values, fixtureCount(f));
      rebuildFrame();
      save();
      return { fixture: f };
    }
    if ((match = /^\/api\/fixtures\/(\d+)\/channels$/.exec(url)) && m === 'PUT') {
      const f = findFixture(parseInt(match[1], 10));
      if (!f) throw new Error('faro non trovato');
      const n = fixtureCount(f);
      const raw = (body || {}).channels;
      if (!Array.isArray(raw) || raw.length !== n) {
        throw new Error(`servono ${n} canali`);
      }
      const channels = sanitizeChannels(raw, null, n);
      f.channels = channels;
      if ((body || {}).all) {
        // solo sui fari con lo stesso numero di canali
        if (n === NUM_CHANNELS) db.channels = channels.map((c) => ({ ...c }));
        for (const other of db.fixtures) {
          if (fixtureCount(other) === n) other.channels = channels.map((c) => ({ ...c }));
        }
      }
      save();
      return { fixtures: db.fixtures, channels: db.channels };
    }
    if ((match = /^\/api\/fixtures\/(\d+)$/.exec(url))) {
      const id = parseInt(match[1], 10);
      const f = findFixture(id);
      if (!f) throw new Error('faro non trovato');
      if (m === 'PUT') {
        const b = body || {};
        if ('name' in b) f.name = String(b.name).slice(0, 24) || f.name;
        if ('address' in b) {
          const a = parseInt(b.address, 10);
          if (!isNaN(a)) f.address = Math.max(1, Math.min(512 - fixtureCount(f) + 1, a));
        }
        for (const k of ['x', 'y', 'panzero']) {
          if (k in b) {
            const v = parseFloat(b[k]);
            if (!isNaN(v)) f[k] = Math.max(0, Math.min(1, v));
          }
        }
        if ('rot' in b) {
          const r = parseFloat(b.rot);
          if (!isNaN(r)) f.rot = ((r % 360) + 360) % 360;
        }
        rebuildFrame();
        save();
        return { fixture: f };
      }
      if (m === 'DELETE') {
        db.fixtures = db.fixtures.filter((x) => x.id !== id);
        for (const p of db.presets) if (p) delete p.values[String(id)];
        rebuildFrame();
        save();
        return { ok: true };
      }
    }
    if ((match = /^\/api\/presets\/(\d+)\/load$/.exec(url)) && m === 'POST') {
      const slot = parseInt(match[1], 10);
      const p = db.presets[slot];
      if (!p) throw new Error('preset vuoto');
      for (const f of db.fixtures) {
        const saved = p.values[String(f.id)];
        if (saved !== undefined) f.values = sanitizeValues(saved, fixtureCount(f));
      }
      rebuildFrame();
      save();
      return { fixtures: db.fixtures };
    }
    if ((match = /^\/api\/presets\/(\d+)$/.exec(url)) && m === 'PATCH') {
      const slot = parseInt(match[1], 10);
      const p = db.presets[slot];
      if (!p) throw new Error('preset vuoto');
      const b = body || {};
      if ('name' in b) p.name = String(b.name || p.name).slice(0, 24);
      if ('fade' in b) p.fade = sanitizeFade(b.fade);
      if ('dark' in b) p.dark = !!b.dark;
      save();
      return { presets: db.presets };
    }
    if ((match = /^\/api\/presets\/(\d+)\/copy$/.exec(url)) && m === 'POST') {
      const slot = parseInt(match[1], 10);
      const dest = parseInt((body || {}).to, 10);
      if (!(dest >= 0 && dest < NUM_PRESETS)) throw new Error('spazio di destinazione non valido');
      const p = db.presets[slot];
      if (!p) throw new Error('preset vuoto');
      const values = {};
      for (const k of Object.keys(p.values)) values[k] = [...p.values[k]];
      db.presets[dest] = {
        name: String((body || {}).name || p.name).slice(0, 24),
        fade: sanitizeFade(p.fade),
        dark: !!p.dark,
        values,
      };
      save();
      return { presets: db.presets };
    }
    if ((match = /^\/api\/presets\/(\d+)$/.exec(url))) {
      const slot = parseInt(match[1], 10);
      if (slot < 0 || slot >= NUM_PRESETS) throw new Error('slot non valido');
      if (m === 'POST') {
        const values = {};
        for (const f of db.fixtures) values[String(f.id)] = [...f.values];
        db.presets[slot] = {
          name: String((body || {}).name || `Preset ${slot + 1}`).slice(0, 24),
          fade: sanitizeFade((body || {}).fade),
          dark: !!(body || {}).dark,
          values,
        };
        save();
        return { presets: db.presets };
      }
      if (m === 'DELETE') {
        db.presets[slot] = null;
        save();
        return { presets: db.presets };
      }
    }
    if (m === 'POST' && url === '/api/copioni') {
      const copione = {
        id: db.next_copione++,
        name: String((body || {}).name || `Copione ${db.next_copione - 1}`).slice(0, 40),
        cues: [],
        pdf: false,
      };
      db.copioni.push(copione);
      save();
      return { copione, copioni: db.copioni };
    }
    if ((match = /^\/api\/copioni\/(\d+)$/.exec(url))) {
      const id = parseInt(match[1], 10);
      const c = db.copioni.find((x) => x.id === id);
      if (!c) throw new Error('copione non trovato');
      if (m === 'PUT') {
        const b = body || {};
        if ('name' in b) c.name = String(b.name).slice(0, 40) || c.name;
        if (Array.isArray(b.cues)) {
          c.cues = b.cues
            .map((q) => ({
              id: parseInt(q.id, 10),
              pos: Math.max(0, Math.min(1, parseFloat(q.pos))),
              preset: Math.max(0, Math.min(NUM_PRESETS - 1, parseInt(q.preset, 10))),
            }))
            .filter((q) => !isNaN(q.id) && !isNaN(q.pos) && !isNaN(q.preset))
            .sort((a, b2) => a.pos - b2.pos);
        }
        save();
        return { copione: c, copioni: db.copioni };
      }
      if (m === 'DELETE') {
        db.copioni = db.copioni.filter((x) => x.id !== id);
        save();
        deletePdf(id).catch(() => {});
        return { copioni: db.copioni };
      }
    }
    if ((match = /^\/api\/copioni\/(\d+)\/pdf$/.exec(url)) && m === 'PUT') {
      const c = db.copioni.find((x) => x.id === parseInt(match[1], 10));
      if (c) { c.pdf = true; save(); }
      return { copioni: db.copioni };
    }
    if (m === 'PUT' && url === '/api/blackout') {
      db.blackout = !!(body || {}).on;
      rebuildFrame();
      save();
      return { blackout: db.blackout };
    }
    throw new Error(`rotta sconosciuta: ${m} ${url}`);
  };

  rebuildFrame();

  /* ------------------------------------------- esporta / importa show */
  document.getElementById('btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lightstage-show.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById('import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        db = sanitizeShow(JSON.parse(reader.result));
        save();
        location.reload();
      } catch (err) {
        alert('File non valido: ' + (err.message || err));
      }
    };
    reader.readAsText(file);
  });

  /* ------------------- show online con codice (foglio Google + script) */
  const CLOUD_URL_KEY = 'lightstage-cloud-url';
  const SHOW_NAME_KEY = 'lightstage-show-name';
  const cloudUrlInput = document.getElementById('cloud-url');
  cloudUrlInput.value = localStorage.getItem(CLOUD_URL_KEY) || '';
  cloudUrlInput.addEventListener('change', () => {
    localStorage.setItem(CLOUD_URL_KEY, cloudUrlInput.value.trim());
  });

  // nome del setup su cui si sta lavorando (dall'ultimo salva/carica online)
  let currentShowName = localStorage.getItem(SHOW_NAME_KEY) || '';
  function setCurrentShowName(n) {
    currentShowName = (n || '').trim();
    if (currentShowName) localStorage.setItem(SHOW_NAME_KEY, currentShowName);
    else localStorage.removeItem(SHOW_NAME_KEY);
  }

  document.getElementById('btn-cloud').addEventListener('click', () => {
    const nameInput = document.getElementById('cloud-name');
    if (!nameInput.value.trim() && currentShowName) nameInput.value = currentShowName;
    document.getElementById('modal-cloud').classList.remove('hidden');
  });

  function cloudUrl() {
    const url = (cloudUrlInput.value || '').trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url)) {
      alert("Prima incolla l'URL della web app di Apps Script " +
        '(finisce con /exec). Trovi le istruzioni nel link della finestra.');
      return null;
    }
    localStorage.setItem(CLOUD_URL_KEY, url);
    return url;
  }

  async function cloudJson(res) {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error("lo script non ha risposto in JSON: controlla che la " +
        "distribuzione sia con accesso 'Chiunque' e che l'URL finisca con /exec");
    }
  }

  async function cloudSaveRequest(url, name, overwrite) {
    // text/plain evita il preflight CORS, che Apps Script non gestisce
    const body = { data: db };
    if (name) body.name = name;
    if (overwrite) body.overwrite = true;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    });
    return cloudJson(res);
  }

  async function saveOnline(url, name, overwriteDirect) {
    let out = await cloudSaveRequest(url, name, overwriteDirect);
    if (!out.ok && out.exists) {
      // nome già usato: blocco e chiedo prima di sovrascrivere
      const conferma = confirm(
        `Il nome "${name}" è già usato da un altro salvataggio.\n\n` +
        'Vuoi SOVRASCRIVERLO con lo show attuale?\n' +
        '(Annulla per scegliere un altro nome)');
      if (!conferma) return;
      out = await cloudSaveRequest(url, name, true);
    }
    if (!out.ok || !out.code) throw new Error(out.error || 'risposta non valida');
    setCurrentShowName(out.code);
    if (out.updated) {
      alert(`Setup "${out.code}" aggiornato con lo show attuale.`);
    } else if (name) {
      alert(`Setup salvato online con il nome "${out.code}".`);
    } else {
      prompt('Show salvato online! Annota questo codice per ricaricarlo ovunque:', out.code);
    }
  }

  document.getElementById('btn-cloud-save').addEventListener('click', async () => {
    const url = cloudUrl();
    if (!url) return;
    const name = document.getElementById('cloud-name').value.trim();
    const btn = document.getElementById('btn-cloud-save');
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = 'Salvataggio…';
    try {
      await saveOnline(url, name, false);
    } catch (err) {
      alert('Salvataggio online fallito: ' + (err.message || err));
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  });

  /* 💾 in alto: salva il setup corrente, chiedendo se sovrascrivere
     quello su cui si sta lavorando o dargli un nuovo nome */
  document.getElementById('btn-save').addEventListener('click', async () => {
    const urlVal = (cloudUrlInput.value || '').trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(urlVal)) {
      document.getElementById('modal-cloud').classList.remove('hidden');
      alert("Per salvare i setup online configura prima il foglio Google: " +
        "incolla l'URL dello script nella finestra Online (vedi istruzioni).");
      return;
    }
    let name;
    let overwrite = false;
    if (currentShowName) {
      overwrite = confirm(
        `Stai lavorando sul setup "${currentShowName}".\n\n` +
        'OK = sovrascrivilo con lo stato attuale\n' +
        'Annulla = salvalo come nuovo setup con un altro nome');
      if (overwrite) {
        name = currentShowName;
      } else {
        const nuovo = prompt('Nome del nuovo setup:', currentShowName);
        if (nuovo === null) return;
        name = nuovo.trim();
        if (!name) return;
      }
    } else {
      const nuovo = prompt('Nome del setup da salvare (vuoto = codice automatico):', '');
      if (nuovo === null) return;
      name = nuovo.trim();
    }
    try {
      await saveOnline(urlVal, name, overwrite);
    } catch (err) {
      alert('Salvataggio online fallito: ' + (err.message || err));
    }
  });

  document.getElementById('btn-cloud-list').addEventListener('click', async () => {
    const url = cloudUrl();
    if (!url) return;
    const box = document.getElementById('cloud-list');
    box.classList.remove('hidden');
    box.textContent = 'Carico l\'elenco…';
    try {
      const res = await fetch(url + '?list=1');
      const out = await cloudJson(res);
      if (!out.ok || !Array.isArray(out.shows)) {
        if (out && out.error === 'codice mancante') {
          // risposta tipica delle versioni vecchie dello script
          throw new Error('il foglio risponde ma lo script è una VERSIONE ' +
            'VECCHIA. Incolla il nuovo Code.gs e poi: Distribuisci → Gestisci ' +
            'distribuzioni → ✏️ → Versione: "Nuova versione" → Distribuisci. ' +
            "(L'URL non cambia)");
        }
        throw new Error(out.error ||
          "aggiorna lo script all'ultima versione (vedi istruzioni)");
      }
      box.innerHTML = '';
      if (!out.shows.length) {
        box.textContent = 'Nessun salvataggio ancora.';
        return;
      }
      for (const s of out.shows.reverse()) {
        const item = document.createElement('button');
        item.className = 'cloud-item';
        const quando = s.date ? new Date(s.date).toLocaleString('it-IT') : '';
        item.textContent = s.code + (quando ? ` — ${quando}` : '');
        item.title = 'Clic per usare questo salvataggio';
        item.addEventListener('click', () => {
          document.getElementById('cloud-code').value = s.code;
        });
        box.append(item);
      }
    } catch (err) {
      box.textContent = 'Elenco non disponibile: ' + (err.message || err);
    }
  });

  document.getElementById('btn-cloud-load').addEventListener('click', async () => {
    const url = cloudUrl();
    if (!url) return;
    const code = document.getElementById('cloud-code').value.trim();
    if (!code) {
      alert('Inserisci il codice dello show da caricare.');
      return;
    }
    const btn = document.getElementById('btn-cloud-load');
    btn.disabled = true;
    try {
      const res = await fetch(url + '?code=' + encodeURIComponent(code));
      const out = await cloudJson(res);
      if (!out.ok || !out.data) {
        throw new Error(out.error || 'nome o codice non trovato');
      }
      const data = sanitizeShow(out.data);
      if (!data.fixtures.length &&
          !confirm('Questo salvataggio non contiene fari: caricarlo comunque ' +
            'sostituendo lo show attuale?')) {
        btn.disabled = false;
        return;
      }
      db = data;
      save();
      setCurrentShowName(code);
      sessionStorage.setItem('lightstage-cloud-loaded', code);
      location.reload();
    } catch (err) {
      alert('Caricamento fallito: ' + (err.message || err));
      btn.disabled = false;
    }
  });

  // conferma visiva dopo un caricamento riuscito (post-ricarica pagina)
  const caricato = sessionStorage.getItem('lightstage-cloud-loaded');
  if (caricato) {
    sessionStorage.removeItem('lightstage-cloud-loaded');
    const toast = document.createElement('div');
    toast.id = 'toast';
    toast.textContent = `Show "${caricato}" caricato dal foglio Google ✓`;
    document.body.append(toast);
    setTimeout(() => toast.remove(), 6000);
  }
})();
