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
  ✕ per svuotarlo.
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
