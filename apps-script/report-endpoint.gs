/**
 * Read-only JSON endpoint for ClientReports.
 *
 * Add this to the SAME Apps Script project that already receives your landing-page
 * leads, then Deploy -> Manage deployments -> edit -> Version: New version.
 * The existing lead-capture doPost is untouched; this only adds a doGet.
 *
 * NOTE: this project must have zero global variables (they collide across .gs files).
 *
 * Two modes:
 *   mode=report&tab=NAME          the sheet this script is bound to, by tab name
 *   mode=tab&ssId=ID&gid=NUMBER   ANY spreadsheet this account can open, by tab id
 *
 * The second is what the app uses for per-campaign CRM tabs: you paste a tab's URL
 * into the app, it pulls the id and gid out of the URL, and asks for exactly that
 * tab. gid is used rather than the tab name because renaming a tab in Sheets does
 * not change its gid — the link keeps working.
 */
function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    var book;
    var sheet;

    if (params.mode === 'tab') {
      if (!params.ssId) return dh360Json_({ error: 'Missing ssId' });
      try {
        book = SpreadsheetApp.openById(params.ssId);
      } catch (openErr) {
        return dh360Json_({
          error: 'Cannot open that spreadsheet. Share it with ' +
            Session.getEffectiveUser().getEmail() + ' (Viewer is enough).'
        });
      }
      var gid = String(params.gid == null ? '0' : params.gid);
      var all = book.getSheets();
      for (var s = 0; s < all.length; s++) {
        if (String(all[s].getSheetId()) === gid) { sheet = all[s]; break; }
      }
      if (!sheet) return dh360Json_({ error: 'No tab with gid ' + gid + ' in that spreadsheet.' });
    } else if (params.mode === 'report') {
      book = SpreadsheetApp.getActiveSpreadsheet();
      sheet = params.tab ? book.getSheetByName(params.tab) : book.getSheets()[0];
      if (!sheet) return dh360Json_({ error: 'Tab not found: ' + params.tab });
    } else {
      return dh360Json_({ error: 'Unknown mode' });
    }

    var values = sheet.getDataRange().getValues();
    if (values.length < 2) return dh360Json_({ columns: [], rows: [], tab: sheet.getName() });

    var columns = values[0].map(function (c) { return String(c); });

    // Which column carries the lead's date. Named explicitly, else the first header
    // that reads like a timestamp, else the first column — matching the old behaviour.
    var dateIdx = 0;
    if (params.dateColumn) {
      for (var d = 0; d < columns.length; d++) {
        if (columns[d].toLowerCase() === String(params.dateColumn).toLowerCase()) { dateIdx = d; break; }
      }
    } else {
      for (var h = 0; h < columns.length; h++) {
        var name = columns[h].toLowerCase();
        if (name.indexOf('time') > -1 || name.indexOf('date') > -1 || name.indexOf('stamp') > -1) {
          dateIdx = h;
          break;
        }
      }
    }

    var tz = Session.getScriptTimeZone();
    var since = params.since || '0000-01-01';
    var until = params.until || '9999-12-31';

    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var blank = true;
      var obj = {};
      for (var j = 0; j < columns.length; j++) {
        var cell = values[i][j];
        if (cell !== '' && cell !== null) blank = false;
        obj[columns[j]] =
          cell instanceof Date
            ? Utilities.formatDate(cell, tz, "yyyy-MM-dd'T'HH:mm:ss")
            : String(cell);
      }
      if (blank) continue;
      var stamp = String(obj[columns[dateIdx]] || '').slice(0, 10);
      // A row whose date cell is empty or unparseable is still a lead — keep it
      // rather than silently dropping it out of the client's totals.
      if (/^\d{4}-\d{2}-\d{2}$/.test(stamp) && !(stamp >= since && stamp <= until)) continue;
      rows.push(obj);
    }

    return dh360Json_({
      columns: columns,
      rows: rows,
      tab: sheet.getName(),
      dateColumn: columns[dateIdx]
    });
  } catch (err) {
    return dh360Json_({ error: String(err) });
  }
}

function dh360Json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
