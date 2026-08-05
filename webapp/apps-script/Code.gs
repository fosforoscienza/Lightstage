// LightStage — salvataggio show online su foglio Google
// Incolla questo codice in Apps Script (Estensioni → Apps Script del tuo
// foglio) e distribuiscilo come App web: vedi ISTRUZIONI.md qui accanto.

var SHEET_NAME = 'shows';

// Caricamento: GET ?code=ABCD-1234
function doGet(e) {
  var code = normalizza_((e.parameter && e.parameter.code) || '');
  if (!code) return json_({ ok: false, error: 'codice mancante' });
  var righe = getSheet_().getDataRange().getValues();
  for (var i = righe.length - 1; i >= 1; i--) {
    if (normalizza_(String(righe[i][0])) === code) {
      return json_({ ok: true, data: JSON.parse(righe[i][2]) });
    }
  }
  return json_({ ok: false, error: 'codice non trovato' });
}

// Salvataggio: POST con corpo {"data": {...}}
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
    var code = nuovoCodice_();
    getSheet_().appendRow([code, new Date(), testo]);
    return json_({ ok: true, code: code });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
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
