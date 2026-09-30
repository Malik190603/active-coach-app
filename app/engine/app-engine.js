/*
 * Fungsi tambahan khusus aplikasi (dipanggil lewat google.script.run seperti fungsi Code.gs lainnya).
 */
'use strict';

/* Konfigurasi Strava dari server (client secret TIDAK pernah disimpan di HP — proxy yang menyisipkannya). */
function appEnsureConfig(cfg) {
  cfg = cfg || {};
  var p = PropertiesService.getScriptProperties();
  if (cfg.stravaClientId) p.setProperty('STRAVA_CLIENT_ID', String(cfg.stravaClientId));
  if (p.getProperty('STRAVA_CLIENT_SECRET') !== '__SERVER__') p.setProperty('STRAVA_CLIENT_SECRET', '__SERVER__');
  if (!p.getProperty('STRAVA_VERIFY_TOKEN')) p.setProperty('STRAVA_VERIFY_TOKEN', 'app');
  if (cfg.redirectUri) { p.setProperty('STRAVA_REDIRECT_URI', String(cfg.redirectUri)); ACX_ENGINE.redirectUri = String(cfg.redirectUri); }
  return { ok: true, configured: !!p.getProperty('STRAVA_CLIENT_ID') };
}

/* Setelah login Supabase: pilih/siapkan profil atlet di workspace ini. */
function appSession(displayName, pickId) {
  ensureRuntimeDatabase();
  var p = PropertiesService.getScriptProperties();
  var list = listAthletes();
  if (pickId && list.some(function (a) { return a.athleteId === String(pickId); })) p.setProperty('APP_ATHLETE_ID', String(pickId));
  var chosen = p.getProperty('APP_ATHLETE_ID');
  var a = chosen ? list.filter(function (x) { return x.athleteId === chosen; })[0] : null;
  if (!a && list.length === 1) a = list[0];
  if (!a && list.length > 1) return { ok: false, needPick: true, athletes: list };
  if (!a) { createAthlete(displayName || 'Athlete', ''); list = listAthletes(); a = list[list.length - 1]; }
  p.setProperty('APP_ATHLETE_ID', a.athleteId);
  var row = athleteRowIndexById(a.athleteId), full = athleteById(a.athleteId) || {};
  var fresh = String(a.nama) === 'Athlete' && !full.stravaAccessToken && !full.stravaRefreshToken;
  if (fresh && displayName && row) { athletesSheet().getRange(row, 2).setValue(displayName); a.nama = displayName; }
  return { ok: true, athleteId: a.athleteId, nama: a.nama, fotoProfil: a.fotoProfil || '' };
}

/* Menyelesaikan OAuth Strava dari deep link activecoach://strava?code=... */
function appFinishOAuth(code, state, error) {
  if (error) return { ok: false, error: 'Strava menolak: ' + error };
  var out = finishStravaOAuth({ code: code, state: state });
  var html = out && out.getContent ? out.getContent() : String(out || '');
  var st = getStravaStatus(state);
  return { ok: !!st.connected, message: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) };
}

/* Menjalankan trigger berkala (pengganti trigger jam-an Apps Script) saat aplikasi dibuka. */
function appRunDueTriggers() {
  var p = PropertiesService.getScriptProperties(), now = Date.now(), ran = [];
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    var t = tr._t, key = '__ACX_LAST_' + t.id, last = Number(p.getProperty(key) || 0);
    if (now - last < t.everyMs) return;
    if (typeof self[t.fn] !== 'function') return;
    p.setProperty(key, String(now));
    try { self[t.fn](); ran.push(t.fn); } catch (e) { try { logError('Trigger ' + t.fn, e, ''); } catch (x) {} }
    if (t.once) ScriptApp.deleteTrigger(tr);
  });
  return { ran: ran };
}

function appWorkspaceInfo() {
  var s = ACX_ENGINE.db.sheets, out = {};
  Object.keys(s).forEach(function (k) { out[k] = Math.max(0, s[k].length - 1); });
  return { sheets: out, files: Object.keys(ACX_ENGINE.db.files).length };
}

/* Setelah "Masuk dengan Strava": simpan token, nama & foto dari Strava ke profil atlet aktif. */
function appSetProfileKey_(athleteId, key, value) {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(SHEETS.profile), rows = readRows(ss, SHEETS.profile), row = 0;
  rows.forEach(function (r, i) { if (r[0] === key && String(r[2] || '') === String(athleteId)) row = i + 2; });
  if (!row) row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, 3).setValues([[key, String(value == null ? '' : value), String(athleteId)]]);
}
function appApplyStravaLogin(strava) {
  strava = strava || {};
  var p = PropertiesService.getScriptProperties(), id = p.getProperty('APP_ATHLETE_ID');
  if (!id) throw new Error('Profil atlet belum siap.');
  var ath = strava.athlete || {}, name = [ath.firstname, ath.lastname].filter(Boolean).join(' ').trim();
  if (strava.access_token) saveAthleteStravaToken(id, { access_token: strava.access_token, refresh_token: strava.refresh_token, expires_at: strava.expires_at, athlete: ath });
  var prof = profileMap(SpreadsheetApp.getActiveSpreadsheet(), id);
  if (name && (!prof.nama || prof.nama === 'Cyclist' || prof.nama === 'Athlete')) appSetProfileKey_(id, 'nama', name);
  var avatar = String(ath.profile || ath.profile_medium || '');
  if (/^https:\/\//.test(avatar) && !/avatar\/athlete\/large/.test(avatar) && !prof.profilePhoto) appSetProfileKey_(id, 'profilePhoto', avatar);
  var logs = readAthleteLogs(SpreadsheetApp.getActiveSpreadsheet(), id);
  return { ok: true, athleteId: id, nama: (athleteById(id) || {}).nama || name, needsFirstSync: !logs.length, scopeOk: /activity:read_all/.test(String(strava.scope || 'activity:read_all')) };
}

/* Pilih profil atlet yang tertaut ke akun Strava ini (kalau data berisi beberapa atlet). */
function appSelectStravaAthlete(stravaId) {
  ensureRuntimeDatabase();
  stravaId = String(stravaId || '');
  if (!stravaId) return { ok: false };
  var rows = athleteRows();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][4] || '') === stravaId) { PropertiesService.getScriptProperties().setProperty('APP_ATHLETE_ID', String(rows[i][0])); return { ok: true, athleteId: String(rows[i][0]) }; }
  }
  return { ok: false };
}

/* Token Strava milik profil aktif (dipakai saat memulihkan cadangan agar login Strava tetap tersambung). */
function appCurrentStrava() {
  var id = PropertiesService.getScriptProperties().getProperty('APP_ATHLETE_ID'), a = id ? athleteById(id) : null;
  if (!a || !a.stravaRefreshToken) return null;
  var rows = athleteRows(), sid = '';
  for (var i = 0; i < rows.length; i++) if (String(rows[i][0]) === String(id)) sid = String(rows[i][4] || '');
  return { access_token: a.stravaAccessToken || '', refresh_token: a.stravaRefreshToken, expires_at: Number(a.stravaExpiresAt || 0), athlete: { id: sid } };
}
