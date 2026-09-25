/**
 * Read-only JSON endpoint for ClientReports.
 *
 * Add this to the SAME Apps Script project that already receives your landing-page
 * leads, then Deploy -> Manage deployments -> edit -> Version: New version.
 * The existing lead-capture doPost is untouched; this only adds a doGet.
 *
 * NOTE: this project must have zero global variables (they collide across .gs files).
 *
 * DEPLOY SETTINGS: Execute as "Me", Who has access "Anyone". "Only myself" cannot
 * work — the app calls this URL as a plain server request with no Google session,
 * and would be answered with a sign-in page instead of data.
 *
 * "Anyone" means anyone holding the /exec URL, so the URL is a secret. Set DH360_KEY
 * below to a long random string and the app must send it as &key=...; without it the
 * endpoint returns nothing. Keep that key and the URL out of anything public.
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

    // Shared secret. Set this to a long random string, and put the same value in the
    // app's .env as SHEETS_KEY. Leave it empty only if you accept that anyone with
    // the URL can read your leads.
    var DH360_KEY = 'PUT-A-LONG-RANDOM-STRING-HERE';

    if (DH360_KEY && String(params.key || '') !== DH360_KEY) {
      return dh360Json_({ error: 'Unauthorised' });
    }

    var book;
    var sheet;

    // Lists every tab with its gid, so the app can offer them as a dropdown. Picking
    // from a list beats copying a URL: the gid is invisible in the Sheets UI, and the
    // address bar does not always follow the tab you clicked.
    if (params.mode === 'tabs') {
      if (!params.ssId) return dh360Json_({ error: 'Missing ssId' });
      var listBook;
      try {
        listBook = SpreadsheetApp.openById(params.ssId);
      } catch (listErr) {
        return dh360Json_({
          error: 'Cannot open that spreadsheet. Check the link, and that the Google '
            + 'account running this script can open it.'
        });
      }
      var tabs = listBook.getSheets().map(function (sh) {
        return { name: sh.getName(), gid: String(sh.getSheetId()) };
      });
      return dh360Json_({ tabs: tabs, spreadsheet: listBook.getName() });
    }

    if (params.mode === 'tab') {
      if (!params.ssId) return dh360Json_({ error: 'Missing ssId' });
      try {
        book = SpreadsheetApp.openById(params.ssId);
      } catch (openErr) {
        // Deliberately does not name the account: Session.getEffectiveUser() needs
        // the userinfo.email scope, which this deployment has no other reason to
        // request, and asking for it would force a re-authorisation.
        return dh360Json_({
          error: 'Cannot open that spreadsheet. Check the link, and that the Google '
            + 'account running this script can open it.'
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
    var tz = Session.getScriptTimeZone();

    if (params.mode === 'tab') {
      // Raw grid, headers and all. Which row holds the headers is not always row 1 —
      // an export appended below an older one puts a header row in the middle — so
      // that decision is made by the app, where it can change without redeploying.
      var out = [];
      for (var i = 0; i < values.length && i < 20000; i++) {
        var line = [];
        for (var j = 0; j < values[i].length; j++) {
          var cell = values[i][j];
          line.push(
            cell instanceof Date
              ? Utilities.formatDate(cell, tz, "yyyy-MM-dd'T'HH:mm:ss")
              : String(cell)
          );
        }
        out.push(line);
      }
      return dh360Json_({ values: out, tab: sheet.getName() });
    }

    // mode=report keeps its original shape: row 1 is the header, rows filtered by date.
    if (values.length < 2) return dh360Json_({ columns: [], rows: [] });

    var columns = values[0].map(function (c) { return String(c); });
    var since = params.since || '0000-01-01';
    var until = params.until || '9999-12-31';

    var rows = [];
    for (var r = 1; r < values.length; r++) {
      var obj = {};
      for (var c2 = 0; c2 < columns.length; c2++) {
        var v = values[r][c2];
        obj[columns[c2]] =
          v instanceof Date ? Utilities.formatDate(v, tz, "yyyy-MM-dd'T'HH:mm:ss") : String(v);
      }
      var stamp = String(obj[columns[0]] || '').slice(0, 10);
      if (stamp >= since && stamp <= until) rows.push(obj);
    }

    return dh360Json_({ columns: columns, rows: rows, tab: sheet.getName() });
  } catch (err) {
    return dh360Json_({ error: String(err) });
  }
}

function dh360Json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
