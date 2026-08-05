'use strict';

/* Backend locale per la versione "sito" di LightStage: nessun server,
   i dati vivono nel localStorage del browser e il DMX esce dal cavo
   USB tramite l'API Web Serial (Chrome/Edge). */
(function () {
  const NUM_CHANNELS = 8;   // predefinito: i fari possono averne anche 16
  const NUM_PRESETS = 10;
  const STORE_KEY = 'lightstage-show';
  const DEFAULT_CHANNELS = [
    { label: 'Dimmer', role: 'dimmer' },
    { label: 'Rosso', role: 'red' },
    { label: 'Verde', role: 'green' },
    { label: 'Blu', role: 'blue' },
    { label: 'UV', role: 'uv' },
    { label: 'Strobo', role: 'other' },
    { label: 'Macro', role: 'other' },
    { label: 'Velocità', role: 'other' },
  ];
  const ROLES = new Set(['dimmer', 'red', 'green', 'blue', 'uv', 'white', 'other']);

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
      });
    }
    (data.presets || []).slice(0, NUM_PRESETS).forEach((p, i) => {
      if (p && typeof p === 'object' && p.values) {
        const values = {};
        for (const [k, v] of Object.entries(p.values)) values[k] = sanitizeValues(v, 16);
        db.presets[i] = { name: String(p.name || `Preset ${i + 1}`).slice(0, 24), values };
      }
    });
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

  /* ------------------------------------------- uscita DMX via Web Serial */
  const dmxOut = {
    port: null,
    writer: null,
    running: false,
    error: null,
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
      const writer = this.writer;
      const port = this.port;
      this.writer = null;
      this.port = null;
      try { if (writer) writer.releaseLock(); } catch (err) { /* già chiuso */ }
      try { if (port) await port.close(); } catch (err) { /* già chiuso */ }
    },

    async loop() {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      while (this.running && this.port) {
        const port = this.port;
        const writer = this.writer;
        try {
          await port.setSignals({ break: true });   // break (minimo 88 µs)
          await sleep(2);
          await port.setSignals({ break: false });
          await writer.write(this.frame);
        } catch (err) {
          this.error = 'errore sul cavo: ' + (err.message || err);
          await this.disconnect();
          break;
        }
        await sleep(25); // ~25-30 frame al secondo
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
        for (const k of ['x', 'y']) {
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
    if ((match = /^\/api\/presets\/(\d+)$/.exec(url))) {
      const slot = parseInt(match[1], 10);
      if (slot < 0 || slot >= NUM_PRESETS) throw new Error('slot non valido');
      if (m === 'POST') {
        const values = {};
        for (const f of db.fixtures) values[String(f.id)] = [...f.values];
        db.presets[slot] = {
          name: String((body || {}).name || `Preset ${slot + 1}`).slice(0, 24),
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
  const cloudUrlInput = document.getElementById('cloud-url');
  cloudUrlInput.value = localStorage.getItem(CLOUD_URL_KEY) || '';
  cloudUrlInput.addEventListener('change', () => {
    localStorage.setItem(CLOUD_URL_KEY, cloudUrlInput.value.trim());
  });

  document.getElementById('btn-cloud').addEventListener('click', () => {
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

  document.getElementById('btn-cloud-save').addEventListener('click', async () => {
    const url = cloudUrl();
    if (!url) return;
    const btn = document.getElementById('btn-cloud-save');
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = 'Salvataggio…';
    try {
      // text/plain evita il preflight CORS, che Apps Script non gestisce
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ data: db }),
      });
      const out = await res.json();
      if (!out.ok || !out.code) throw new Error(out.error || 'risposta non valida');
      prompt('Show salvato online! Annota questo codice per ricaricarlo ovunque:', out.code);
    } catch (err) {
      alert('Salvataggio online fallito: ' + (err.message || err));
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
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
      const out = await res.json();
      if (!out.ok || !out.data) throw new Error(out.error || 'codice non trovato');
      db = sanitizeShow(out.data);
      save();
      location.reload();
    } catch (err) {
      alert('Caricamento fallito: ' + (err.message || err));
      btn.disabled = false;
    }
  });
})();
