/**
 * Active Coach · Ekspor data Google Sheets untuk dipindahkan ke aplikasi Android.
 *
 * Cara pakai (sekali saja):
 * 1. Buka project Apps Script Active Coach yang lama → tambah file script baru bernama "Migrasi",
 *    tempel seluruh isi file ini, lalu simpan.
 * 2. Pilih fungsi  eksporUntukAplikasi  di toolbar → klik Run → izinkan akses bila diminta.
 * 3. Buka menu Execution log: ada tautan file "active-coach-export-....json" di Google Drive.
 * 4. Unduh file itu ke HP, lalu di aplikasi: Profil → "Impor dari Google Sheets" → pilih file tersebut.
 *
 * Yang ikut diekspor: semua sheet (aktivitas, plan, garasi, analisis Pro, dsb.), Script Properties
 * (kecuali kredensial Strava aplikasi), dan foto sepeda dari folder ActiveCoach_BikePhotos.
 * Token Strava atlet ikut terbawa, jadi setelah impor Strava tetap tersambung.
 */
function eksporUntukAplikasi() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = {
    format: 'active-coach-export',
    version: 1,
    source: 'apps-script',
    exportedAt: new Date().toISOString(),
    timezone: Session.getScriptTimeZone(),
    sheets: {},
    props: {},
    files: {}
  };

  ss.getSheets().forEach(function (sh) {
    var lr = sh.getLastRow(), lc = sh.getLastColumn();
    var values = lr && lc ? sh.getRange(1, 1, lr, lc).getValues() : [];
    out.sheets[sh.getName()] = values.map(function (row) {
      return row.map(function (v) { return v instanceof Date ? { $d: v.getTime() } : v; });
    });
  });

  var skip = { STRAVA_CLIENT_ID: 1, STRAVA_CLIENT_SECRET: 1, STRAVA_REDIRECT_URI: 1, STRAVA_REDIRECT_URL: 1, STRAVA_VERIFY_TOKEN: 1, STRAVA_WEBHOOK_URL: 1 };
  var props = PropertiesService.getScriptProperties().getProperties();
  Object.keys(props).forEach(function (k) { if (!skip[k]) out.props[k] = props[k]; });

  var folders = DriveApp.getFoldersByName('ActiveCoach_BikePhotos');
  if (folders.hasNext()) {
    var folder = folders.next(), fid = folder.getId();
    out.files[fid] = { kind: 'folder', name: folder.getName(), mime: 'application/vnd.google-apps.folder', data: '' };
    var it = folder.getFiles();
    while (it.hasNext()) {
      var f = it.next();
      if (f.isTrashed()) continue;
      out.files[f.getId()] = {
        kind: 'file', name: f.getName(), mime: f.getMimeType(), parent: fid,
        description: f.getDescription() || '', created: f.getDateCreated().getTime(),
        data: Utilities.base64Encode(f.getBlob().getBytes())
      };
    }
  }

  var name = 'active-coach-export-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm') + '.json';
  var file = DriveApp.createFile(Utilities.newBlob(JSON.stringify(out), 'application/json', name));
  var n = out.sheets[typeof SHEETS !== 'undefined' && SHEETS.logs ? SHEETS.logs : 'LogAktivitas'];
  Logger.log('Selesai! ' + Object.keys(out.sheets).length + ' sheet, ' + Math.max(0, (n ? n.length : 1) - 1) + ' aktivitas, ' + Object.keys(out.files).length + ' file foto.');
  Logger.log('Unduh file ini ke HP lalu impor di aplikasi: ' + file.getUrl());
  return file.getUrl();
}
