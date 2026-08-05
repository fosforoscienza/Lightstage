# Salvare gli show online con un foglio Google

Configurazione da fare **una volta sola** (~5 minuti). Alla fine avrai un
"indirizzo segreto" da incollare in LightStage: da quel momento potrai
salvare gli show online e ricaricarli da qualsiasi computer con un codice
tipo `K7TQ-M2XP`.

## 1. Crea il foglio

1. Vai su [sheets.google.com](https://sheets.google.com) e crea un foglio
   nuovo, chiamalo ad esempio *LightStage shows*.

## 2. Aggiungi lo script

2. Nel foglio: menu **Estensioni → Apps Script**.
3. Cancella il codice di esempio e incolla **tutto** il contenuto del file
   [`Code.gs`](Code.gs) che trovi in questa cartella.
4. Salva (icona del dischetto).

## 3. Pubblica lo script come App web

5. In alto a destra: **Distribuisci → Nuova distribuzione**.
6. Icona ingranaggio → tipo **App web**.
7. Imposta:
   - *Esegui come*: **Me**
   - *Chi può accedere*: **Chiunque**
8. **Distribuisci**, autorizza con il tuo account Google (Google avviserà che
   lo script non è verificato: *Avanzate → Vai a … (non sicuro)* — è il tuo
   script, va bene), poi **copia l'URL dell'app web** (finisce con `/exec`).

## 4. Collega LightStage

9. Apri la versione web di LightStage, premi **☁ Online** e incolla l'URL
   nel campo *URL script*. Viene ricordato su quel browser.

## Uso quotidiano

- **Salva online**: carica lo show attuale (fari, canali, preset, posizioni)
  sul foglio. Puoi dargli un **nome a tua scelta** (es. *concerto sagra
  2026*); se lasci il campo vuoto viene generato un codice tipo `K7TQ-M2XP`.
- **Nome già usato?** Il salvataggio si **blocca e ti avvisa**: sovrascrive
  il salvataggio esistente solo se confermi, altrimenti scegli un altro nome.
- **Carica da nome o codice**: scrivi il nome (o il codice) e lo show viene
  ripristinato — da qualunque computer, basta che nel campo URL ci sia lo
  stesso script. Maiuscole, minuscole e spazi non contano.
- **📋 Elenco salvataggi**: mostra tutti i salvataggi sul foglio con la data;
  clicchi su uno e il campo di caricamento si compila da solo.

Note:

- Ogni salvataggio senza nome crea un **codice nuovo**; tutti i salvataggi
  sono righe della scheda "shows" del foglio, dove puoi cancellare quelle
  che non servono più.
- Chi conosce un nome o un codice può caricare quello show: non scriverci
  dentro nulla di riservato.
- L'URL dello script va incollato una volta per ogni browser/computer che usi
  (oppure tienilo annotato insieme ai codici).

## Aggiornare lo script a una versione nuova

Se hai già configurato tutto e LightStage introduce funzioni nuove dello
script (come i nomi personalizzati):

1. Apri il foglio → **Estensioni → Apps Script**, cancella il codice e
   incolla il nuovo contenuto di `Code.gs`.
2. **Distribuisci → Gestisci distribuzioni** → matita ✏️ → *Versione:*
   **Nuova versione** → **Distribuisci**.

L'URL resta lo stesso: non devi cambiare nulla in LightStage. Attenzione:
salvare solo il codice **senza** creare la nuova versione della
distribuzione non aggiorna l'app web.
