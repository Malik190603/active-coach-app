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
