# LightStage

Software essenziale per programmare fari DMX (pensato per fari **UkFog UV+RGB a
8 canali**) tramite un cavo **USB→DMX**. Un'alternativa minimale a SweetLight /
Daslight: solo quello che serve.

![Interfaccia](docs/screenshot.png)

## Cosa fa

- **Fari**: aggiungi un faro con nome, indirizzo DMX e **8 o 16 canali**: per
  ognuno hai un fader (0–255). Ogni faro ha i **suoi** nomi e ruoli dei canali
  (pulsante ⚙ sulla scheda), quindi puoi mescolare par, teste mobili e altro
  nello stesso show; aggiungendo un faro puoi copiare i canali da uno già
  configurato. Il pulsante *"Crea 8 fari"* prepara in un clic la
  configurazione tipica UkFog con indirizzi 1, 9, 17, … 57.
- **Selettore colore**: in ogni scheda c'è un quadratino colorato: scegli un
  colore e i fader Rosso/Verde/Blu si impostano da soli (e se il dimmer è a
  zero viene alzato, così il colore si vede subito). Muovendo i fader a mano,
  il selettore si aggiorna di conseguenza.
- **Preset**: **100 slot** con nome. Clic su uno slot vuoto per salvare le luci
  attuali, clic su uno pieno per caricarlo, 💾 per sovrascrivere/rinominare,
  ✕ per svuotarlo. Il selettore **Fade** applica una dissolvenza nel passaggio
  da un preset all'altro.
- **Preset grid**: il pulsante in basso a destra (o il tasto **G**) apre la
  schermata con tutti i 100 preset in griglia da 5 colonne, ognuno con
  l'anteprima del palco e il suo nome, per ritrovare al volo la scena giusta.
- **Scorciatoie da tastiera** (legenda sempre visibile nel piè di pagina):
  **1–9 e 0** lanciano i preset, **B** blackout, **F** fade to black,
  **N** nuovo faro, **Cmd/Ctrl+C** connetti il cavo, **Cmd/Ctrl+S** salva lo
  show (nella versione web salva il setup online, altrimenti scarica il file),
  **Cmd/Ctrl+O** apre la finestra Online (solo versione web).
- **Anteprima palco**: vista dall'alto del palco. Trascina i fari per
  posizionarli, ruotali con la maniglia bianca (o con la rotellina del mouse)
  per orientare il fascio. Il colore e l'intensità del fascio seguono i fader
  (RGB + UV reso come viola).
- **Teste mobili nell'anteprima**: la direzione in cui orienti un faro sulla
  mappa diventa il suo **zero**; da lì il canale **pan** fa ruotare il fascio
  (fino a 540°, come su un wash) e il canale **focus** ne apre l'angolo da
  **10° a 60°**. Ri-orientando il faro sulla mappa lo zero si riposiziona sul
  valore di pan in quel momento.
- **Uscita DMX**: il segnale viene inviato in continuo (~30 fps) sul cavo
  USB-DMX. C'è un pulsante **Blackout** (spegne tutto all'istante senza
  perdere i valori dei fader, tasto **B**) e un pulsante **FTB** — *fade to
  black*, tasto **F** — che funziona da interruttore: al primo clic spegne
  gradualmente i canali di luce (0,5 / 1 / 1,5 secondi a scelta) e resta
  **rosso lampeggiante**; al secondo clic riaccende le luci com'erano, in
  dissolvenza. Pan/Tilt/Focus delle teste mobili non si muovono mai.
- **Salvataggio automatico**: fari, posizioni, preset e configurazione canali
  vengono salvati da soli nel file `show.json`.

## Requisiti

- Python 3.9 o superiore
- Un cavo USB→DMX basato su chip **FTDI** (protocollo *Open DMX*: è il tipo più
  comune, ad es. Enttec Open DMX USB e la maggior parte dei cavi economici).

## Avvio con doppio clic (senza terminale)

Nella cartella del progetto trovi tre lanciatori — usa quello del tuo sistema:

| Sistema | File da avviare |
|---------|-----------------|
| Windows | `Avvia LightStage.bat` |
| macOS   | `Avvia LightStage.command` *(al primo avvio: clic destro → Apri)* |
| Linux   | `avvia-lightstage.sh` |

Alla prima esecuzione installano da soli le dipendenze (serve solo Python 3
già installato), poi avviano il programma e aprono il browser. Per chiudere
LightStage basta chiudere la finestra del lanciatore.

Puoi creare un collegamento sul desktop: tasto destro sul file →
*Invia a → Desktop* (Windows) o *Crea alias* (macOS).

## Avvio da terminale

```bash
pip install -r requirements.txt
python lightstage.py
```

Il browser si apre da solo su <http://127.0.0.1:8123>. Senza cavo collegato
l'app funziona comunque: fader, preset e anteprima restano attivi (utile per
preparare lo spettacolo a casa).

## Usarlo da telefono, tablet o altri computer

Il computer col cavo USB-DMX fa da "centralina": LightStage è un piccolo sito
web servito da lì a **tutta la rete locale**. Dagli altri dispositivi
(collegati alla **stessa rete Wi-Fi**) apri nel browser l'indirizzo che trovi:

- nel pulsante **📱 In rete** in alto nell'interfaccia, oppure
- nel terminale all'avvio (riga *"Da telefoni/PC sulla stessa rete"*),
  ad es. `http://192.168.1.42:8123`.

Tutti i dispositivi restano sincronizzati: se dal telefono lanci un preset,
lo vedi cambiare anche sul computer. Al primo avvio **Windows** chiede se
consentire a Python l'accesso alla rete: scegli *Consenti* (reti private).

Nota: il programma deve girare sul computer fisicamente collegato al cavo
DMX — un sito su internet non potrebbe raggiungere il cavo USB. Se ti serve
il controllo da **fuori** dalla rete locale (da casa verso la sala, ecc.),
il modo più semplice e sicuro è una VPN tipo [Tailscale](https://tailscale.com)
sui due dispositivi: l'indirizzo resta lo stesso e funziona ovunque.
Chiunque sia sulla stessa rete può controllare le luci: su reti pubbliche
tienilo a mente.

## Versione sito web (usarlo da qualsiasi computer)

Nella cartella `webapp/` c'è una **versione che gira interamente nel browser**,
senza installare niente: si apre il sito, si collega il cavo USB-DMX al
computer che si sta usando e si preme *Connetti cavo*. Usa l'API **Web
Serial**, quindi serve **Chrome o Edge** (Firefox e Safari non la supportano).

- Fari, preset e posizioni vengono salvati **nel browser di quel computer**
  (localStorage). Con **Esporta/Importa** puoi portare tutto su un altro
  computer come file `lightstage-show.json`.
- Con **☁ Online** puoi salvare lo show su un tuo **foglio Google** e
  ricaricarlo da qualsiasi computer con un codice tipo `K7TQ-M2XP`. Serve una
  configurazione una tantum di ~5 minuti:
  [istruzioni](webapp/apps-script/ISTRUZIONI.md).
- Per pubblicarla gratis con GitHub Pages: *Settings → Pages → Deploy from a
  branch*, scegli il branch e la cartella `/ (root)`. Il sito sarà su
  `https://<utente>.github.io/Lightstage/webapp/`.
- Durante lo spettacolo tieni la scheda del browser **in primo piano**: le
  schede in secondo piano vengono rallentate e il segnale DMX perde fluidità.

La versione Python (sopra) resta quella consigliata per l'uso fisso: funziona
con qualsiasi browser, salva su file e permette il controllo da più
dispositivi in contemporanea sulla rete locale.

## Collegare i fari (catena DMX)

Il DMX è un bus: **tutti i fari restano collegati contemporaneamente**, in
cascata, e ricevono tutti lo stesso segnale. Ogni faro legge solo i suoi 8
canali in base all'indirizzo impostato sul suo display:

```
Computer ── cavo USB-DMX ──▶ Faro 1 (ind. 1) ──▶ Faro 2 (ind. 9) ──▶ … ──▶ Faro 8 (ind. 57)
                              DMX IN → DMX OUT    DMX IN → DMX OUT
```

Ogni faro si collega al successivo con un cavo DMX/XLR da *DMX OUT* a
*DMX IN*. Sull'ultimo faro è buona pratica (non obbligatoria su tratte corte)
mettere un terminatore DMX da 120 Ω.

Con delle **trasmittenti/riceventi DMX wireless** lo schema è identico: la
trasmittente si collega all'uscita XLR del cavo USB-DMX (non al computer) e
le riceventi si mettono davanti ai fari, che possono comunque essere
concatenati tra loro dopo ogni ricevente.

## Collegare il cavo USB-DMX

1. Collega il cavo, avvia LightStage e scegli la porta dal menu in alto
   (di solito viene riconosciuta da sola: `COM3` su Windows,
   `/dev/ttyUSB0` su Linux, `/dev/tty.usbserial-…` su macOS).
2. Premi **Connetti**: il pallino diventa verde e il DMX esce dal cavo.

**Windows**: se la porta non compare, installa i driver FTDI VCP
(<https://ftdichip.com/drivers/vcp-drivers/>).

**Linux**: serve il permesso sulla porta seriale:

```bash
sudo usermod -a -G dialout $USER   # poi scollegati e riaccedi
```

### Problemi di connessione

- **"write timeout" / "la porta non accetta dati"**: hai selezionato una porta
  che non è il cavo DMX (una seriale interna tipo `COM1`/`/dev/ttyS0` o una
  porta Bluetooth). Nel menu scegli la voce contrassegnata con ● *(probabile
  cavo DMX)*: di solito si chiama "USB Serial Port (COMx)" su Windows,
  `/dev/ttyUSB0` su Linux, `/dev/cu.usbserial-…` su macOS. Se non compare
  nessuna porta USB, il cavo non viene riconosciuto: su Windows installa i
  driver FTDI VCP; se il cavo è di tipo **uDMX** non appare come porta
  seriale e al momento non è supportato.
- **"Permission denied" (Linux)**: aggiungi l'utente al gruppo `dialout`
  (comando più sotto) e riaccedi.
- **"Access is denied" / porta occupata**: un altro programma sta usando la
  porta: chiudilo e ripremi Connetti.

## Canali dei fari UkFog

L'indirizzo impostato sul faro (display/dip-switch) deve coincidere con quello
inserito nell'app. Layout predefinito dei canali (quello tipico dei par
UV+RGB a 8 canali):

| CH | Funzione | CH | Funzione |
|----|----------|----|----------|
| 1  | Dimmer   | 5  | UV       |
| 2  | Rosso    | 6  | Strobo   |
| 3  | Verde    | 7  | Macro    |
| 4  | Blu      | 8  | Velocità |

Se il tuo modello usa un ordine diverso — o hai fari di tipo differente —
premi il **⚙ sulla scheda del faro** e correggi nomi e ruoli dei suoi canali.
I ruoli disponibili sono: **Dimmer, Rosso, Verde, Blu, UV, Bianco, Strobo,
Pan, Tilt, Focus, Return, Altro**. Il ruolo serve all'anteprima per calcolare
il colore del fascio e al selettore colore per capire dove sono i canali RGB
(in qualunque posizione siano). *"Salva per tutti i fari"* applica il layout
a tutti i fari con lo stesso numero di canali. L'uscita DMX non dipende dai
ruoli: manda sempre il fader N sul canale indirizzo+N-1.

Quando aggiungi un faro scegli fra tre possibilità: canali **predefiniti
UkFog**, **come un faro esistente**, oppure **nuovo set di canali** da
comporre subito lì (per ogni canale scegli il ruolo e il nome si compila da
solo). Esempio, una testa mobile a 8 canali:

| CH | Nome  | Ruolo | CH | Nome   | Ruolo  |
|----|-------|-------|----|--------|--------|
| 1  | Pan   | Pan   | 5  | Verde  | Verde  |
| 2  | Tilt  | Tilt  | 6  | Blu    | Blu    |
| 3  | Focus | Focus | 7  | Bianco | Bianco |
| 4  | Rosso | Rosso | 8  | Return | Return |

## Versione

Il numero di versione è in basso a destra nell'interfaccia; lo storico delle
modifiche è in [CHANGELOG.md](CHANGELOG.md). Due cifre soltanto: il primo
numero cambia con le modifiche strutturali, il secondo con aggiunte e
ritocchi.

**Non vedi le ultime modifiche?** Controlla il numero in basso a destra: se
non è quello dell'ultima versione, il browser sta usando la copia vecchia —
ricarica con **Ctrl+F5** (Cmd+Shift+R su Mac). Se usi la versione Python,
ricordati di aggiornare la cartella con `git pull` e riavviare il programma.

Per rilasciare una versione nuova: cambia `APP_VERSION` in `static/app.js` e
il `?v=` nei due file `index.html` (serve a non far riusare al browser i file
della versione precedente).

## Limitazioni

- Un solo universo DMX (512 canali), più che sufficiente per 8 fari.
- Supporta il protocollo *Open DMX* (seriale FTDI). Le interfacce **uDMX** e
  **Enttec DMX USB Pro** usano protocolli diversi e per ora non sono
  supportate.
- Se due fari hanno indirizzi sovrapposti l'app lo segnala in rosso e sul
  canale condiviso vince il valore più alto (merge HTP).
