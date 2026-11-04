'use strict';

/* ---------------------------------------------------------------- musica
   Si carica un brano e le luci gli vanno dietro: l'intensità segue il
   volume e salta sui colpi della cassa, il colore cambia a ogni colpo, le
   teste mobili si spostano a tempo attorno alla posizione che hanno.

   Il brano suona dal computer (casse, mixer) e intanto il programma lo
   ascolta con l'analizzatore del browser: niente da installare, funziona
   uguale nella versione web e in quella Python.

   Come convive con il resto: la musica parte dalla scena che c'è sul palco
   (la "base") e ci gira attorno. Tutto quello che cambia da fuori mentre
   suona — un preset lanciato, un fader mosso a mano — diventa la nuova base,
   così il movimento delle teste si sposta sulla scena nuova invece di
   tornare indietro. Quando la musica si ferma i fari tornano sulla base. */

const MUSICA_KEY = 'lightstage-musica';

/* quanto si muovono le teste attorno alla loro posizione, in gradi */
const MUSICA_AMPIEZZE = {
  ferme: { pan: 0, tilt: 0 },
  poco: { pan: 15, tilt: 8 },
  medio: { pan: 35, tilt: 15 },
  tanto: { pan: 70, tilt: 30 },
};
const MUSICA_TICK = 30;          // ms fra un aggiornamento e l'altro
const MUSICA_COLPO_MIN = 260;    // ms minimi fra due colpi (≈ 230 BPM)

const musica = {
  // brano
  el: null,              // <audio>
  ctx: null,             // AudioContext, creato al primo play
  analyser: null,
  freq: null,
  url: null,
  nome: '',
  // opzioni (si ricordano fra una sessione e l'altra)
  opz: {
    luci: true,           // luci a tempo accese
    fari: 'tutti',        // 'tutti' | 'scelti'
    colori: 'musica',     // 'musica' | 'sfalsati' | 'preset'
    teste: 'medio',       // vedi MUSICA_AMPIEZZE
    reattivita: 0.6,      // 0..1
    luminosita: 1,        // 0..1
    volume: 0.9,          // 0..1
  },
  scelti: [],             // i fari fissati con «Scelti»
  // motore
  timer: null,
  ultimoTick: 0,
  attivo: false,          // le luci stanno andando a tempo
  sospeso: false,         // fermo un attimo mentre si salva un preset
  base: new Map(),        // id faro -> scena su cui gira la musica
  ultimo: new Map(),      // id faro -> ultimi valori scritti dalla musica
  mov: new Map(),         // id faro -> {p, t}: dove sta andando la testa
  // analisi
  storia: [],             // energia dei bassi nell'ultimo secondo e mezzo
  bassiPrima: 0,
  picco: 0.05,            // guadagno automatico: il punto più forte recente
  livello: 0,             // volume normalizzato e smussato, 0..1
  impulso: 0,             // lampo del colpo, decade in fretta
  ultimoColpo: 0,
  intervalli: [],
  bpm: 0,
  colpi: 0,
  tinta: 0,               // tinta di partenza del colore, in gradi
  tintaVista: 0,
  bersaglio: { p: 0, t: 0 },
  master: 1,              // scende a zero con l'FTB
};

function musicaCaricaOpzioni() {
  try {
    const s = JSON.parse(localStorage.getItem(MUSICA_KEY) || 'null');
    if (s && typeof s === 'object') {
      for (const k of Object.keys(musica.opz)) {
        if (typeof s[k] === typeof musica.opz[k]) musica.opz[k] = s[k];
      }
    }
  } catch (err) { /* niente memoria: si parte dai valori di sempre */ }
  if (!MUSICA_AMPIEZZE[musica.opz.teste]) musica.opz.teste = 'medio';
  if (!['musica', 'sfalsati', 'preset'].includes(musica.opz.colori)) musica.opz.colori = 'musica';
  // «scelti» non sopravvive a un ricaricamento: la scelta dei fari no
  musica.opz.fari = 'tutti';
}

function musicaSalvaOpzioni() {
  try { localStorage.setItem(MUSICA_KEY, JSON.stringify(musica.opz)); } catch (err) { /* pazienza */ }
}

/* ------------------------------------------------------------ pannello */
const musicaUI = {};

function musicaCostruisciPannello() {
  const p = document.createElement('section');
  p.id = 'musica';
  p.className = 'hidden';
  p.innerHTML = `
    <header>
      <span class="mu-titolo">&#127925; Musica</span>
      <span class="mu-bpm" title="Battiti al minuto, stimati dai colpi della cassa">&mdash; BPM</span>
      <button type="button" class="mu-chiudi" title="Nascondi il pannello (la musica continua) — tasto M">&#10005;</button>
    </header>
    <div class="mu-riga mu-file">
      <label class="btn ghost" title="Carica un brano (mp3, wav, m4a, ogg…) — o trascinalo qui">&#128194; Brano
        <input type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac" hidden>
      </label>
      <span class="mu-nome">Nessun brano caricato</span>
    </div>
    <div class="mu-riga mu-trasporto">
      <button type="button" class="btn mu-play" disabled title="Play / pausa">&#9654;</button>
      <button type="button" class="btn ghost mu-stop" disabled title="Ferma e torna all'inizio">&#9632;</button>
      <span class="mu-tempo">0:00</span>
      <input type="range" class="mu-pos" min="0" max="1000" value="0" disabled>
      <span class="mu-durata">0:00</span>
    </div>
    <canvas class="mu-spettro" width="320" height="44"></canvas>
    <div class="mu-riga">
      <span class="mu-lbl">Luci a tempo</span>
      <span class="fade-group" data-opz="luci">
        <button type="button" data-value="false">spente</button>
        <button type="button" data-value="true">accese</button>
      </span>
    </div>
    <div class="mu-riga">
      <span class="mu-lbl">Fari</span>
      <span class="fade-group" data-opz="fari">
        <button type="button" data-value="tutti" title="Tutti i fari dello show">tutti</button>
        <button type="button" data-value="scelti" title="Solo i fari scelti adesso sulla mappa (Maiusc+clic per sceglierne più d'uno)">scelti</button>
      </span>
      <span class="mu-nota mu-quanti"></span>
    </div>
    <div class="mu-riga">
      <span class="mu-lbl">Colori</span>
      <span class="fade-group" data-opz="colori">
        <button type="button" data-value="musica" title="Tutti i fari dello stesso colore, che cambia a ogni colpo">uguali</button>
        <button type="button" data-value="sfalsati" title="Ogni faro un colore diverso, e tutti cambiano a ogni colpo">arcobaleno</button>
        <button type="button" data-value="preset" title="Restano i colori della scena: la musica muove solo intensità e teste">del preset</button>
      </span>
    </div>
    <div class="mu-riga">
      <span class="mu-lbl">Teste</span>
      <span class="fade-group" data-opz="teste" title="Quanto si muovono le teste mobili attorno alla loro posizione">
        <button type="button" data-value="ferme">ferme</button>
        <button type="button" data-value="poco">poco</button>
        <button type="button" data-value="medio">medio</button>
        <button type="button" data-value="tanto">tanto</button>
      </span>
    </div>
    <label class="mu-riga mu-slider" title="Quanto le luci saltano sui colpi: poco = respirano col volume, tanto = lampeggiano sulla cassa">
      <span class="mu-lbl">Reattivit&agrave;</span>
      <input type="range" data-opz="reattivita" min="0" max="100">
    </label>
    <label class="mu-riga mu-slider" title="Intensità massima delle luci mentre suona la musica">
      <span class="mu-lbl">Luminosit&agrave;</span>
      <input type="range" data-opz="luminosita" min="0" max="100">
    </label>
    <label class="mu-riga mu-slider" title="Volume del brano">
      <span class="mu-lbl">Volume</span>
      <input type="range" data-opz="volume" min="0" max="100">
    </label>
  `;
  document.body.append(p);
  musicaUI.pannello = p;
  musicaUI.file = p.querySelector('input[type=file]');
  musicaUI.nome = p.querySelector('.mu-nome');
  musicaUI.play = p.querySelector('.mu-play');
  musicaUI.stop = p.querySelector('.mu-stop');
  musicaUI.tempo = p.querySelector('.mu-tempo');
  musicaUI.durata = p.querySelector('.mu-durata');
  musicaUI.pos = p.querySelector('.mu-pos');
  musicaUI.spettro = p.querySelector('.mu-spettro');
  musicaUI.bpm = p.querySelector('.mu-bpm');
  musicaUI.quanti = p.querySelector('.mu-quanti');

  p.querySelector('.mu-chiudi').addEventListener('click', () => musicaMostra(false));
  musicaUI.file.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) musicaCaricaBrano(file);
    e.target.value = '';
  });
  musicaUI.play.addEventListener('click', () => { musicaUI.play.blur(); musicaPlayPausa(); });
  musicaUI.stop.addEventListener('click', () => { musicaUI.stop.blur(); musicaStop(); });
  musicaUI.pos.addEventListener('input', () => {
    const el = musica.el;
    if (el && isFinite(el.duration)) el.currentTime = musicaUI.pos.value / 1000 * el.duration;
  });

  // i gruppi di pulsantini
  p.querySelectorAll('.fade-group[data-opz]').forEach((g) => {
    g.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      btn.blur();
      const chiave = g.dataset.opz;
      let v = btn.dataset.value;
      if (chiave === 'luci') v = v === 'true';
      if (chiave === 'fari' && v === 'scelti') {
        const ids = [...selectedIds].filter((id) => state.fixtures.some((f) => f.id === id));
        if (!ids.length) {
          musicaAvviso('Prima scegli i fari sulla mappa (clic, Maiusc+clic per più d\'uno)');
          return;
        }
        musica.scelti = ids;
      }
      musica.opz[chiave] = v;
      musicaSalvaOpzioni();
      musicaAggiornaPannello();
    });
  });
  // i cursori
  p.querySelectorAll('input[type=range][data-opz]').forEach((r) => {
    r.addEventListener('input', () => {
      musica.opz[r.dataset.opz] = r.value / 100;
      if (r.dataset.opz === 'volume' && musica.el) musica.el.volume = musica.opz.volume;
      musicaSalvaOpzioni();
    });
    // lasciato il cursore il fuoco se ne va, così i tasti rapidi tornano a funzionare
    r.addEventListener('change', () => r.blur());
  });
  musicaUI.pos.addEventListener('change', () => musicaUI.pos.blur());

  // un brano si può anche trascinare sul pannello
  p.addEventListener('dragover', (e) => { e.preventDefault(); p.classList.add('sopra'); });
  p.addEventListener('dragleave', () => p.classList.remove('sopra'));
  p.addEventListener('drop', (e) => {
    e.preventDefault();
    p.classList.remove('sopra');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) musicaCaricaBrano(file);
  });

  musicaAggiornaPannello();
}

/* un pulsante 🎵 nel piè di pagina di ogni schermata */
function musicaPulsanti() {
  const crea = () => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost js-musica';
    b.title = 'Musica: carica un brano e le luci vanno a tempo (tasto M)';
    b.innerHTML = '&#127925; Musica';
    b.addEventListener('click', () => { b.blur(); musicaMostra(); });
    return b;
  };
  const destra = document.querySelector('#credits .credits-right');
  if (destra) destra.prepend(crea());
  document.querySelectorAll('#grid-legend .foot-nav, #copione-foot .foot-nav').forEach((nav) => {
    nav.prepend(crea());
  });
  const tasti = document.querySelector('#credits .credits-keys');
  if (tasti) {
    const k = document.createElement('span');
    k.className = 'key-item';
    k.innerHTML = '<kbd>M</kbd><em>musica</em>';
    const dopo = [...tasti.querySelectorAll('.key-item')].find((x) => /copione/.test(x.textContent));
    if (dopo) dopo.after(k); else tasti.append(k);
  }
}

function musicaMostra(on) {
  const p = musicaUI.pannello;
  const vedi = on === undefined ? p.classList.contains('hidden') : on;
  p.classList.toggle('hidden', !vedi);
  if (vedi) musicaAggiornaPannello();
}

let musicaAvvisoTimer = null;
function musicaAvviso(testo) {
  const q = musicaUI.quanti;
  q.textContent = testo;
  q.classList.add('warn');
  clearTimeout(musicaAvvisoTimer);
  musicaAvvisoTimer = setTimeout(() => {
    q.classList.remove('warn');
    musicaAggiornaPannello();
  }, 2600);
}

function musicaMinuti(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

function musicaAggiornaPannello() {
  const p = musicaUI.pannello;
  if (!p) return;
  p.querySelectorAll('.fade-group[data-opz]').forEach((g) => {
    const v = String(musica.opz[g.dataset.opz]);
    g.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.value === v));
  });
  p.querySelectorAll('input[type=range][data-opz]').forEach((r) => {
    if (document.activeElement !== r) r.value = Math.round(musica.opz[r.dataset.opz] * 100);
  });
  const el = musica.el;
  const pronto = !!el;
  musicaUI.play.disabled = !pronto;
  musicaUI.stop.disabled = !pronto;
  musicaUI.pos.disabled = !pronto;
  const suona = musicaSuona();
  musicaUI.play.innerHTML = suona ? '&#10074;&#10074;' : '&#9654;';
  musicaUI.play.classList.toggle('primary', suona);
  if (!musicaUI.quanti.classList.contains('warn')) {
    musicaUI.quanti.textContent = musica.opz.fari === 'scelti'
      ? `${musicaFari().length} ${musicaFari().length === 1 ? 'faro' : 'fari'}` : '';
  }
  musicaAggiornaTempo();
  document.querySelectorAll('.js-musica').forEach((b) => b.classList.toggle('suona', suona));
}

function musicaAggiornaTempo() {
  const el = musica.el;
  if (!el) return;
  musicaUI.tempo.textContent = musicaMinuti(el.currentTime);
  musicaUI.durata.textContent = musicaMinuti(el.duration);
  if (document.activeElement !== musicaUI.pos && isFinite(el.duration) && el.duration > 0) {
    musicaUI.pos.value = Math.round(el.currentTime / el.duration * 1000);
  }
}

/* --------------------------------------------------------------- brano */
function musicaCaricaBrano(file) {
  if (file.type && !file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|aac|ogg|oga|flac|opus|webm)$/i.test(file.name)) {
    musicaAvviso('Questo non sembra un file audio');
    return;
  }
  if (!musica.el) {
    const el = new Audio();
    el.preload = 'auto';
    el.addEventListener('play', musicaAlPlay);
    el.addEventListener('pause', musicaAllaPausa);
    el.addEventListener('ended', musicaAllaPausa);
    el.addEventListener('timeupdate', musicaAggiornaTempo);
    el.addEventListener('loadedmetadata', musicaAggiornaPannello);
    el.addEventListener('error', () => {
      musicaUI.nome.textContent = `Il browser non riesce a leggere «${musica.nome}»`;
    });
    musica.el = el;
  }
  const el = musica.el;
  el.pause();
  if (musica.url) URL.revokeObjectURL(musica.url);
  musica.url = URL.createObjectURL(file);
  musica.nome = file.name.replace(/\.[^.]+$/, '');
  el.src = musica.url;
  el.volume = musica.opz.volume;
  el.load();
  musicaUI.nome.textContent = musica.nome;
  musicaUI.nome.title = file.name;
  musicaAzzeraAnalisi();
  musicaAggiornaPannello();
}

/* l'analizzatore si collega al primo play: il browser lascia partire l'audio
   solo dopo un clic */
function musicaPreparaAudio() {
  if (musica.ctx) {
    if (musica.ctx.state === 'suspended') musica.ctx.resume().catch(() => {});
    return;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;   // senza Web Audio la musica suona, le luci no
  try {
    const ctx = new Ctx();
    const src = ctx.createMediaElementSource(musica.el);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.45;
    src.connect(an);
    an.connect(ctx.destination);
    musica.ctx = ctx;
    musica.analyser = an;
    musica.freq = new Uint8Array(an.frequencyBinCount);
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch (err) {
    console.error(err);
  }
}

function musicaSuona() {
  return !!(musica.el && !musica.el.paused && !musica.el.ended);
}

function musicaPlayPausa() {
  const el = musica.el;
  if (!el) { musicaUI.file.click(); return; }
  if (musicaSuona()) { el.pause(); return; }
  musicaPreparaAudio();
  el.play().catch((err) => {
    console.error(err);
    musicaAvviso('Il browser non lascia partire il brano: riprova con un clic');
  });
}

function musicaStop() {
  const el = musica.el;
  if (!el) return;
  el.pause();
  el.currentTime = 0;
  musicaAggiornaTempo();
}

function musicaAlPlay() {
  musicaPreparaAudio();
  if (!musica.timer) {
    musica.ultimoTick = performance.now();
    musica.timer = setInterval(musicaTick, MUSICA_TICK);
  }
  musicaAggiornaPannello();
}

function musicaAllaPausa() {
  if (musica.timer) { clearInterval(musica.timer); musica.timer = null; }
  musicaFermaLuci();
  musica.impulso = 0;
  musica.livello = 0;
  musicaDisegnaSpettro();
  musicaAggiornaPannello();
}

function musicaAzzeraAnalisi() {
  musica.storia = [];
  musica.intervalli = [];
  musica.bpm = 0;
  musica.picco = 0.05;
  musica.livello = 0;
  musica.impulso = 0;
  musica.ultimoColpo = 0;
  musicaUI.bpm.innerHTML = '&mdash; BPM';
}

/* -------------------------------------------------------------- analisi
   Tre bande (bassi, medi, alti) dallo spettro. Il volume viene diviso per il
   punto più forte degli ultimi secondi, così un brano registrato basso
   accende le luci quanto uno registrato forte. Un colpo è un salto dei bassi
   sopra la loro media recente: abbastanza per cassa e basso, che sono quello
   che si sente "a tempo". */
function musicaAnalizza(dt, ora) {
  const an = musica.analyser;
  if (!an) return;
  an.getByteFrequencyData(musica.freq);
  const f = musica.freq;
  const hz = musica.ctx.sampleRate / an.fftSize;
  const banda = (a, b) => {
    const i0 = Math.max(1, Math.floor(a / hz));
    const i1 = Math.min(f.length - 1, Math.ceil(b / hz));
    let s = 0;
    for (let i = i0; i <= i1; i++) s += f[i];
    return i1 >= i0 ? s / (i1 - i0 + 1) / 255 : 0;
  };
  const bassi = banda(35, 150);
  const medi = banda(250, 2000);
  const alti = banda(3000, 10000);
  musica.alti = alti;
  const livello = bassi * 0.5 + medi * 0.35 + alti * 0.15;

  musica.picco = Math.max(0.04, livello, musica.picco * Math.exp(-dt / 8));
  const norm = Math.min(1, livello / musica.picco);
  musica.livello += (norm - musica.livello) * (1 - Math.exp(-dt / 0.07));
  musica.impulso *= Math.exp(-dt / 0.17);

  // colpi
  const st = musica.storia;
  st.push({ t: ora, v: bassi });
  while (st.length && ora - st[0].t > 1500) st.shift();
  let media = 0;
  for (const x of st) media += x.v;
  media /= st.length;
  let varianza = 0;
  for (const x of st) varianza += (x.v - media) ** 2;
  const dev = Math.sqrt(varianza / st.length);
  const k = 1.5 - 1.1 * musica.opz.reattivita;
  const sale = bassi > musica.bassiPrima;
  musica.bassiPrima = bassi;
  if (st.length > 10 && sale && bassi > 0.1
      && bassi > media + k * dev && bassi > media * 1.06
      && ora - musica.ultimoColpo > MUSICA_COLPO_MIN) {
    musicaColpo(ora, true);
  } else if (ora - musica.ultimoColpo > 2500 && musica.livello > 0.15) {
    // brano senza cassa (o in una parte lenta): si cambia lo stesso, piano
    musicaColpo(ora, false);
  }
}

function musicaColpo(ora, vero) {
  if (vero) {
    const dt = ora - musica.ultimoColpo;
    if (dt > 280 && dt < 1500) {
      musica.intervalli.push(dt);
      if (musica.intervalli.length > 16) musica.intervalli.shift();
      // media della metà centrale: scarta i colpi persi e quelli doppi
      const ord = [...musica.intervalli].sort((a, b) => a - b);
      const centro = ord.slice(Math.floor(ord.length / 4), Math.ceil(ord.length * 3 / 4));
      const med = centro.reduce((s, x) => s + x, 0) / centro.length;
      if (ord.length >= 4) {
        musica.bpm = Math.round(60000 / med);
        musicaUI.bpm.textContent = `${musica.bpm} BPM`;
      }
    }
    musica.impulso = 1;
  }
  musica.ultimoColpo = ora;
  musica.colpi++;
  // il colore salta: di più se il brano è brillante (tanti alti)
  musica.tinta = (musica.tinta + (vero ? 55 + 70 * (musica.alti || 0) : 30)) % 360;
  // le teste cambiano direzione: a ogni colpo se il tempo è lento, uno sì e
  // uno no se è veloce, così hanno il tempo di arrivare
  const veloce = musica.bpm > 135;
  if (!veloce || musica.colpi % 2 === 0 || !vero) {
    musica.bersaglio = { p: Math.random() * 2 - 1, t: Math.random() * 2 - 1 };
  }
  document.querySelectorAll('.js-musica.suona').forEach((b) => {
    b.classList.remove('colpo');
    void b.offsetWidth;   // riparte l'animazione
    b.classList.add('colpo');
  });
}

function musicaDisegnaSpettro() {
  const cv = musicaUI.spettro;
  if (!cv || musicaUI.pannello.classList.contains('hidden')) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const f = musica.freq;
  const suona = musicaSuona();
  const col = musicaColore(musica.opz.colori === 'preset' ? 210 : musica.tintaVista);
  if (f && suona) {
    const hz = musica.ctx.sampleRate / musica.analyser.fftSize;
    const barre = 40;
    const bw = (w - 30) / barre;
    for (let i = 0; i < barre; i++) {
      // bande in scala logaritmica, da 30 Hz a 14 kHz
      const a = 30 * Math.pow(14000 / 30, i / barre);
      const b = 30 * Math.pow(14000 / 30, (i + 1) / barre);
      let s = 0;
      let n = 0;
      for (let j = Math.floor(a / hz); j <= Math.ceil(b / hz) && j < f.length; j++) { s += f[j]; n++; }
      const v = n ? s / n / 255 : 0;
      const bh = Math.max(1, v * (h - 4));
      c.fillStyle = `rgba(${col.r},${col.g},${col.b},${0.35 + 0.6 * v})`;
      c.fillRect(i * bw + 1, h - bh - 2, bw - 2, bh);
    }
  } else {
    c.fillStyle = '#566074';
    c.font = '11px system-ui, sans-serif';
    c.textBaseline = 'middle';
    c.fillText(musica.el ? 'in pausa' : 'carica un brano per cominciare', 6, h / 2);
  }
  // il pallino del colpo
  const r = 7 + 5 * musica.impulso;
  c.beginPath();
  c.arc(w - 14, h / 2, r, 0, Math.PI * 2);
  c.fillStyle = suona
    ? `rgba(${col.r},${col.g},${col.b},${0.25 + 0.75 * musica.impulso})`
    : '#262c38';
  c.fill();
}

/* ------------------------------------------------------------- colori */
function musicaColore(tinta) {
  const h = ((tinta % 360) + 360) % 360 / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x]
    : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

/* sulle tinte viola si accende anche l'UV, se il faro ce l'ha */
function musicaUv(tinta) {
  const t = ((tinta % 360) + 360) % 360;
  return Math.max(0, 1 - Math.abs(t - 275) / 35);
}

/* ---------------------------------------------------------------- luci */
function musicaFari() {
  if (musica.opz.fari === 'scelti') {
    return state.fixtures.filter((f) => musica.scelti.includes(f.id));
  }
  return state.fixtures;
}

/* la scena su cui gira la musica (l'FTB la usa per tornare dov'era) */
function musicaScena(f) {
  const b = musica.attivo ? musica.base.get(f.id) : null;
  return b && b.length === f.values.length ? b : f.values;
}

function musicaPosizione(f, ruolo, vals) {
  return movePosition(f, ruolo, vals);
}

function musicaScriviPosizione(f, ruolo, vals, pos) {
  const idx = roleIndexes(f, ruolo);
  if (!idx.length) return;
  pos = Math.max(0, Math.min(1, pos));
  if (idx.length > 1) {
    const raw = Math.round(pos * 65535);
    vals[idx[0]] = raw >> 8;
    vals[idx[1]] = raw & 255;
  } else {
    vals[idx[0]] = Math.round(pos * 65535 / 256);
  }
}

function musicaTick() {
  const ora = performance.now();
  const dt = Math.min(0.15, (ora - musica.ultimoTick) / 1000);
  musica.ultimoTick = ora;
  musicaAnalizza(dt, ora);
  // il colore arriva in fretta ma non di colpo secco
  let diff = ((musica.tinta - musica.tintaVista + 540) % 360) - 180;
  musica.tintaVista = (musica.tintaVista + diff * (1 - Math.exp(-dt / 0.045)) + 360) % 360;
  musicaDisegnaSpettro();

  const vai = musica.opz.luci && musicaSuona() && !!musica.analyser;
  if (!vai) {
    if (musica.attivo) musicaFermaLuci();
    return;
  }
  if (musica.sospeso) return;
  musica.attivo = true;
  musicaApplica(dt);
}

function musicaApplica(dt) {
  const ftb = typeof ftbSnapshot !== 'undefined' && ftbSnapshot !== null;
  // l'FTB abbassa anche la musica, con la sua durata
  const durataFtb = Math.max(0.05, fadeGroupValue('#ftb-time'));
  const verso = ftb ? -1 : 1;
  musica.master = Math.max(0, Math.min(1, musica.master + verso * dt / durataFtb));

  const r = musica.opz.reattivita;
  const fondo = 0.6 - 0.45 * r;   // quanto della luce segue il volume, il resto i colpi
  const luce = Math.max(0, Math.min(1,
    fondo * musica.livello + (1 - fondo) * Math.max(musica.impulso, musica.livello ** 2)))
    * musica.opz.luminosita * musica.master;
  const amp = MUSICA_AMPIEZZE[musica.opz.teste];
  const periodo = musica.bpm ? 60 / musica.bpm : 0.5;
  const tau = Math.max(0.12, Math.min(0.8, periodo * 0.45));
  const segui = 1 - Math.exp(-dt / tau);

  const fari = musicaFari();
  const ids = new Set(fari.map((f) => f.id));
  // un faro tolto dalla scelta (o eliminato) torna sulla sua scena
  for (const id of [...musica.base.keys()]) {
    if (!ids.has(id)) musicaRilascia(id);
  }
  const teste = fari.filter((f) => typeof isMovingHead === 'function' && isMovingHead(f));

  fari.forEach((f, k) => {
    const chans = fixtureChannels(f);
    let b = musica.base.get(f.id);
    const u = musica.ultimo.get(f.id);
    if (!b || b.length !== f.values.length) {
      // la scena di partenza; con l'FTB attivo le luci vere sono nello snapshot
      b = [...f.values];
      const snap = ftb ? ftbSnapshot.get(f.id) : null;
      if (snap && snap.length === b.length) b = [...snap];
      musica.base.set(f.id, b);
    } else if (u && u.length === f.values.length) {
      // quello che è cambiato da fuori diventa la nuova scena; durante l'FTB
      // però le luci che scendono sono dell'FTB, non della scena
      const spenti = ftb ? ruoliSpegnimento(f) : null;
      for (let i = 0; i < b.length; i++) {
        if (f.values[i] !== u[i] && !(spenti && spenti.has(chans[i].role))) b[i] = f.values[i];
      }
    }

    const out = [...b];
    const haDimmer = chans.some((c) => c.role === 'dimmer');
    const modo = musica.opz.colori;
    const tinta = modo === 'sfalsati'
      ? musica.tintaVista + k * (360 / Math.max(1, fari.length))
      : musica.tintaVista;
    const col = modo === 'preset' ? null : musicaColore(tinta);
    const uv = musicaUv(tinta);
    const scala = haDimmer ? 1 : luce;   // senza dimmer si abbassano i colori
    chans.forEach((c, i) => {
      switch (c.role) {
        case 'dimmer': out[i] = Math.round(255 * luce); break;
        case 'red': out[i] = Math.round((col ? col.r : b[i]) * scala); break;
        case 'green': out[i] = Math.round((col ? col.g : b[i]) * scala); break;
        case 'blue': out[i] = Math.round((col ? col.b : b[i]) * scala); break;
        case 'white': out[i] = Math.round((col ? 0 : b[i]) * scala); break;
        case 'uv': out[i] = Math.round((col ? 255 * uv : b[i]) * scala); break;
        default: break;
      }
    });

    // movimento delle teste: attorno alla posizione della scena, a specchio
    // una sì e una no, come in un balletto
    const kt = teste.indexOf(f);
    if (kt >= 0 && (amp.pan || amp.tilt)) {
      let m = musica.mov.get(f.id);
      if (!m) { m = { p: 0, t: 0 }; musica.mov.set(f.id, m); }
      const segno = kt % 2 ? -1 : 1;
      m.p += (musica.bersaglio.p * segno - m.p) * segui;
      m.t += (musica.bersaglio.t - m.t) * segui;
      const p0 = musicaPosizione(f, 'pan', b);
      if (p0 !== null && amp.pan) {
        musicaScriviPosizione(f, 'pan', out, p0 + m.p * amp.pan / PAN_RANGE);
      }
      const t0 = musicaPosizione(f, 'tilt', b);
      if (t0 !== null && amp.tilt) {
        musicaScriviPosizione(f, 'tilt', out, t0 + m.t * amp.tilt / TILT_RANGE);
      }
    }

    musica.ultimo.set(f.id, out);
    if (out.some((v, i) => v !== f.values[i])) {
      f.values = [...out];
      updateFixtureDisplays(f);
      pushValues(f);
    }
  });
}

/* un faro torna sulla sua scena */
function musicaRilascia(id) {
  const b = musica.base.get(id);
  musica.base.delete(id);
  musica.ultimo.delete(id);
  musica.mov.delete(id);
  const f = state.fixtures.find((x) => x.id === id);
  if (!f || !b || b.length !== f.values.length) return;
  const ftb = typeof ftbSnapshot !== 'undefined' && ftbSnapshot !== null;
  let out = [...b];
  if (ftb) {
    // con l'FTB attivo le luci restano giù: la scena torna quando lo si toglie
    ftbSnapshot.set(id, [...b]);
    const chans = fixtureChannels(f);
    const spenti = ruoliSpegnimento(f);
    out = out.map((v, i) => (spenti.has(chans[i].role) ? 0 : v));
  }
  f.values = out;
  updateFixtureDisplays(f);
  pushValues(f);
}

function musicaFermaLuci() {
  for (const id of [...musica.base.keys()]) musicaRilascia(id);
  musica.attivo = false;
  musica.master = (typeof ftbSnapshot !== 'undefined' && ftbSnapshot !== null) ? 0 : 1;
}

/* Salvando un preset mentre suona, nel preset va la scena e non l'attimo di
   musica: si rimanda al server la base, si salva, e si riparte. */
async function musicaPrimaDiSalvare() {
  if (!musica.attivo) return;
  musica.sospeso = true;
  for (const t of pendingValues.values()) clearTimeout(t);
  pendingValues.clear();
  await Promise.all(state.fixtures.map((f) => {
    const b = musica.base.get(f.id);
    if (!b || b.length !== f.values.length) return null;
    return api('PUT', `/api/fixtures/${f.id}/values`, { values: b }).catch(console.error);
  }));
}

function musicaDopoIlSalvataggio() {
  musica.sospeso = false;
}

/* --------------------------------------------------------------- tasti */
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (document.querySelector('.modal:not(.hidden)')) return;
  if (e.code === 'KeyM') musicaMostra();
});

/* ---------------------------------------------------------------- avvio */
musicaCaricaOpzioni();
musicaCostruisciPannello();
musicaPulsanti();
