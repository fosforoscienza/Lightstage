# LightStage

Software essenziale per programmare fari DMX (pensato per fari **UkFog UV+RGB a
8 canali**) tramite un cavo **USB→DMX**. Un'alternativa minimale a SweetLight /
Daslight: solo quello che serve.

![Interfaccia](docs/screenshot.png)

## Cosa fa

- **Fari**: aggiungi un faro con nome e indirizzo DMX; per ogni faro hai
  **8 fader** (0–255), uno per canale. Il pulsante *"Crea 8 fari"* prepara in
  un clic la configurazione tipica con indirizzi 1, 9, 17, … 57.
- **Preset**: **10 slot** con nome. Clic su uno slot vuoto per salvare le luci
  attuali, clic su uno pieno per caricarlo, 💾 per sovrascrivere/rinominare,
  ✕ per svuotarlo. Durante l'evento puoi lanciarli anche da tastiera:
  **tasti 1–9 e 0** caricano i preset 1–10, **B** attiva/disattiva il blackout.
- **Anteprima palco**: vista dall'alto del palco. Trascina i fari per
  posizionarli, ruotali con la maniglia bianca (o con la rotellina del mouse)
  per orientare il fascio. Il colore e l'intensità del fascio seguono i fader
  (RGB + UV reso come viola).
- **Uscita DMX**: il segnale viene inviato in continuo (~30 fps) sul cavo
  USB-DMX. C'è anche un pulsante **Blackout** (spegne tutto senza perdere i
  valori dei fader).
- **Salvataggio automatico**: fari, posizioni, preset e configurazione canali
  vengono salvati da soli nel file `show.json`.

## Requisiti

- Python 3.9 o superiore
- Un cavo USB→DMX basato su chip **FTDI** (protocollo *Open DMX*: è il tipo più
  comune, ad es. Enttec Open DMX USB e la maggior parte dei cavi economici).

## Installazione e avvio

```bash
pip install -r requirements.txt
python lightstage.py
```

Il browser si apre da solo su <http://127.0.0.1:8123>. Senza cavo collegato
l'app funziona comunque: fader, preset e anteprima restano attivi (utile per
preparare lo spettacolo a casa).

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

Se il tuo modello usa un ordine diverso, premi **Canali** in alto e correggi
nomi e ruoli: il ruolo (Rosso, Verde, Blu, UV, Dimmer) serve all'anteprima per
calcolare il colore del fascio.

## Limitazioni

- Un solo universo DMX (512 canali), più che sufficiente per 8 fari.
- Supporta il protocollo *Open DMX* (seriale FTDI). Le interfacce **uDMX** e
  **Enttec DMX USB Pro** usano protocolli diversi e per ora non sono
  supportate.
- Se due fari hanno indirizzi sovrapposti l'app lo segnala in rosso e sul
  canale condiviso vince il valore più alto (merge HTP).
