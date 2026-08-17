/**
 * Read-only JSON endpoint for ClientReports.
 *
 * Add this to the SAME Apps Script project that already receives your landing-page
 * leads, then Deploy -> Manage deployments -> edit -> Version: New version.
 * The existing lead-capture doPost is untouched; this only adds a doGet.
 *
 * NOTE: this project must have zero global variables (they collide across .gs files).
 */
function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    if (params.mode !== 'report') {
      return ContentService.createTextOutput(
        JSON.stringify({ error: 'Unknown mode' })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    var sheet = params.tab
      ? SpreadsheetApp.getActiveSpreadsheet().getSheetByName(params.tab)
      : SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

    if (!sheet) {
      return ContentService.createTextOutput(
        JSON.stringify({ error: 'Tab not found: ' + params.tab })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    var values = sheet.getDataRange().getValues();
    if (values.length < 2) {
      return ContentService.createTextOutput(
        JSON.stringify({ columns: [], rows: [] })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    var columns = values[0].map(function (c) { return String(c); });
    var tz = Session.getScriptTimeZone();
    var since = params.since || '0000-01-01';
    var until = params.until || '9999-12-31';

    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var obj = {};
      for (var j = 0; j < columns.length; j++) {
        var cell = values[i][j];
        obj[columns[j]] =
          cell instanceof Date
            ? Utilities.formatDate(cell, tz, "yyyy-MM-dd'T'HH:mm:ss")
            : String(cell);
      }
      var stamp = String(obj[columns[0]] || '').slice(0, 10);
      if (stamp >= since && stamp <= until) rows.push(obj);
    }

    return ContentService.createTextOutput(
      JSON.stringify({ columns: columns, rows: rows })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ error: String(err) })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}
