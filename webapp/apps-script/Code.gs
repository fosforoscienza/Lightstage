// LightStage — salvataggio show online su foglio Google
// Incolla questo codice in Apps Script (Estensioni → Apps Script del tuo
// foglio) e distribuiscilo come App web: vedi ISTRUZIONI.md qui accanto.

var SHEET_NAME = 'shows';

// Caricamento: GET ?code=<nome o codice>   Elenco: GET ?list=1
function doGet(e) {
  if (e.parameter && e.parameter.list !== undefined) {
    var tutte = getSheet_().getDataRange().getValues();
    var shows = [];
    for (var j = 1; j < tutte.length; j++) {
      shows.push({
        code: String(tutte[j][0]),
        date: tutte[j][1] ? new Date(tutte[j][1]).toISOString() : null,
      });
    }
    return json_({ ok: true, shows: shows });
  }
  var code = normalizza_((e.parameter && e.parameter.code) || '');
  if (!code) return json_({ ok: false, error: 'codice mancante' });
  var righe = getSheet_().getDataRange().getValues();
  for (var i = righe.length - 1; i >= 1; i--) {
    if (normalizza_(String(righe[i][0])) === code) {
      return json_({ ok: true, data: JSON.parse(righe[i][2]) });
    }
  }
  return json_({ ok: false, error: 'nome o codice non trovato' });
}

// Salvataggio: POST con corpo {"data": {...}, "name": "nome facoltativo"}.
// Senza nome viene generato un codice nuovo. Se il nome esiste già il
// salvataggio viene BLOCCATO ({exists: true}): si sovrascrive solo
// ripetendo la richiesta con "overwrite": true.
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (!body || typeof body.data !== 'object') {
      return json_({ ok: false, error: 'dati mancanti' });
    }
    var testo = JSON.stringify(body.data);
    if (testo.length > 45000) {
      return json_({ ok: false, error: 'show troppo grande' });
    }
    var sheet = getSheet_();
    var righe = sheet.getDataRange().getValues();
    var nome = pulisciNome_(body.name || '');
    if (nome) {
      var chiave = normalizza_(nome);
      for (var i = 1; i < righe.length; i++) {
        if (normalizza_(String(righe[i][0])) === chiave) {
          if (body.overwrite === true) {
            sheet.getRange(i + 1, 2, 1, 2).setValues([[new Date(), testo]]);
            return json_({ ok: true, code: String(righe[i][0]), updated: true });
          }
          return json_({ ok: false, exists: true,
            error: 'nome già usato da un altro salvataggio' });
        }
      }
      sheet.appendRow([nome, new Date(), testo]);
      return json_({ ok: true, code: nome });
    }
    var code = nuovoCodice_();
    for (var tentativi = 0; tentativi < 5 && esiste_(righe, code); tentativi++) {
      code = nuovoCodice_();
    }
    sheet.appendRow([code, new Date(), testo]);
    return json_({ ok: true, code: code });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function esiste_(righe, code) {
  var chiave = normalizza_(code);
  for (var i = 1; i < righe.length; i++) {
    if (normalizza_(String(righe[i][0])) === chiave) return true;
  }
  return false;
}

function pulisciNome_(nome) {
  return String(nome).replace(/\s+/g, ' ').trim().slice(0, 40);
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['codice', 'data', 'show']);
  }
  return sheet;
}

// Codice tipo "K7TQ-M2XP": niente 0/O/1/I per evitare confusione
function nuovoCodice_() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var code = '';
  for (var i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code.slice(0, 4) + '-' + code.slice(4);
}

function normalizza_(code) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
