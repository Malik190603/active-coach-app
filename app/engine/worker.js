/*
 * Active Coach Engine Worker
 * - Menjalankan Code.gs (backend lama) di perangkat, di thread terpisah supaya UI tetap mulus.
 * - Data = "spreadsheet" di memori, di-cache di IndexedDB (buka instan & tetap jalan offline),
 *   dan disinkronkan ke Supabase (tabel ac_chunks / ac_meta / ac_files) secara otomatis.
 * - Permintaan internet dari Code.gs (Strava, Open-Meteo) lewat Edge Function "proxy".
 */
'use strict';
importScripts('gas-shim.js');

var E = self.ACX_ENGINE;
var CFG = null, SES = null, codeLoaded = false, hashes = {}, meta = { propsHash: '', filesHash: {} };
var queue = Promise.resolve(), flushTimer = null, flushing = false, flushAgain = false, retryMs = 4000;
var CHUNK_ROWS = 150, BATCH_BYTES = 900000;

function post(msg) { self.postMessage(msg); }
function log() { try { console.log.apply(console, ['[engine]'].concat([].slice.call(arguments))); } catch (e) {} }

/* ------------------------------ serialisasi ------------------------------ */
function enc(k, v) { var o = this[k]; if (o instanceof Date) return { $d: o.getTime() }; return v; }
function dec(k, v) { if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.$d === 'number' && Object.keys(v).length === 1) return new Date(v.$d); return v; }
function hash(str) {
  var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (var i = 0; i < str.length; i++) { var ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36) + ':' + str.length;
}
function chunksOf(rows) {
  var out = [];
  for (var i = 0; i < rows.length; i += CHUNK_ROWS) { var json = JSON.stringify(rows.slice(i, i + CHUNK_ROWS), enc); out.push({ json: json, hash: hash(json) }); }
  return out;
}

/* ------------------------------ IndexedDB cache ------------------------------ */
function idb() {
  return new Promise(function (ok, no) {
    var r = indexedDB.open('active-coach', 1);
    r.onupgradeneeded = function () { r.result.createObjectStore('ws'); };
    r.onsuccess = function () { ok(r.result); };
    r.onerror = function () { no(r.error); };
  });
}
function cacheGet(key) { return idb().then(function (db) { return new Promise(function (ok) { var t = db.transaction('ws').objectStore('ws').get(key); t.onsuccess = function () { ok(t.result || null); }; t.onerror = function () { ok(null); }; }); }).catch(function () { return null; }); }
function cachePut(key, val) { return idb().then(function (db) { return new Promise(function (ok) { var tx = db.transaction('ws', 'readwrite'); tx.objectStore('ws').put(val, key); tx.oncomplete = function () { ok(true); }; tx.onerror = function () { ok(false); }; }); }).catch(function () { return false; }); }
function cacheDel(key) { return idb().then(function (db) { return new Promise(function (ok) { var tx = db.transaction('ws', 'readwrite'); tx.objectStore('ws').delete(key); tx.oncomplete = function () { ok(true); }; tx.onerror = function () { ok(false); }; }); }).catch(function () { return false; }); }
function cacheKey() { return 'ws:' + (SES && SES.user ? SES.user.id : 'anon'); }
function saveCache() {
  return cachePut(cacheKey(), { v: 2, db: JSON.stringify(E.db, enc), hashes: hashes, meta: meta, savedAt: Date.now() });
}

/* ------------------------------ Supabase: sesi & REST ------------------------------ */
function authHeaders(json) {
  var h = { apikey: CFG.anonKey, Authorization: 'Bearer ' + SES.access_token };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}
function sessionFrom(r) { return { access_token: r.access_token, refresh_token: r.refresh_token, expires_at: r.expires_at || Math.floor(Date.now() / 1000) + (r.expires_in || 3600), user: r.user || (SES && SES.user) }; }
function needsRefresh() { return !SES || !SES.expires_at || SES.expires_at * 1000 - Date.now() < 90000; }
async function refreshAsync() {
  if (!needsRefresh()) return;
  var res = await fetch(CFG.url + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: CFG.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: SES.refresh_token }) });
  if (!res.ok) { post({ type: 'authExpired' }); throw new Error('Sesi login kedaluwarsa, silakan masuk lagi.'); }
  SES = sessionFrom(await res.json()); post({ type: 'session', session: SES });
}
function refreshSync() {
  if (!needsRefresh()) return;
  var x = new XMLHttpRequest();
  x.open('POST', CFG.url + '/auth/v1/token?grant_type=refresh_token', false);
  x.setRequestHeader('apikey', CFG.anonKey); x.setRequestHeader('Content-Type', 'application/json');
  x.send(JSON.stringify({ refresh_token: SES.refresh_token }));
  if (x.status < 200 || x.status >= 300) { post({ type: 'authExpired' }); throw new Error('Sesi login kedaluwarsa, silakan masuk lagi.'); }
  SES = sessionFrom(JSON.parse(x.responseText)); post({ type: 'session', session: SES });
}
async function rest(method, path, body, extraHeaders) {
  await refreshAsync();
  var h = authHeaders(body != null);
  Object.assign(h, extraHeaders || {});
  var res = await fetch(CFG.url + '/rest/v1/' + path, { method: method, headers: h, body: body == null ? undefined : body });
  if (!res.ok) { var t = await res.text(); throw new Error('Supabase ' + res.status + ': ' + t.slice(0, 200)); }
  var txt = await res.text();
  return txt ? JSON.parse(txt, dec) : null;
}

/* ------------------------------ HTTP sinkron untuk UrlFetchApp ------------------------------ */
E.http = function (req) {
  refreshSync();
  var x = new XMLHttpRequest();
  x.open('POST', CFG.url + '/functions/v1/proxy', false);
  x.setRequestHeader('apikey', CFG.anonKey);
  x.setRequestHeader('Authorization', 'Bearer ' + SES.access_token);
  x.setRequestHeader('Content-Type', 'application/json');
  try { x.send(JSON.stringify({ url: req.url, method: req.method, headers: req.headers, body: req.body })); }
  catch (e) { throw new Error('Tidak ada koneksi internet (' + (e && e.message || e) + ').'); }
  if (x.status === 0) throw new Error('Tidak ada koneksi internet.');
  var out;
  try { out = JSON.parse(x.responseText); } catch (e) { throw new Error('Proxy error ' + x.status + ': ' + String(x.responseText).slice(0, 200)); }
  if (out.error && out.status == null) throw new Error('Proxy: ' + out.error);
  return { status: out.status, body: out.body, headers: out.headers || {} };
};

/* ------------------------------ Muat workspace ------------------------------ */
function applyServerChunks(list) {
  var bySheet = {};
  list.forEach(function (r) { (bySheet[r.sheet] = bySheet[r.sheet] || []).push(r); });
  return bySheet;
}
async function fetchServerIndex() { return (await rest('GET', 'ac_chunks?select=sheet,chunk,hash&order=sheet.asc,chunk.asc')) || []; }
async function downloadChanged(index) {
  var serverSheets = {}, changed = {};
  index.forEach(function (r) { (serverSheets[r.sheet] = serverSheets[r.sheet] || {})[r.chunk] = r.hash; });
  Object.keys(serverSheets).forEach(function (s) { var cur = hashes[s] || {}, srv = serverSheets[s]; Object.keys(srv).forEach(function (c) { if (cur[c] !== srv[c]) (changed[s] = changed[s] || []).push(Number(c)); }); if (Object.keys(cur).length !== Object.keys(srv).length) changed[s] = changed[s] || []; });
  Object.keys(hashes).forEach(function (s) { if (!serverSheets[s]) changed[s] = null; });
  var names = Object.keys(changed);
  for (var i = 0; i < names.length; i++) {
    var s = names[i];
    if (changed[s] === null) { delete E.db.sheets[s]; delete hashes[s]; continue; }
    var need = changed[s], got = {};
    for (var j = 0; j < need.length; j += 40) {
      var part = need.slice(j, j + 40);
      var rows = await rest('GET', 'ac_chunks?select=chunk,hash,data&sheet=eq.' + encodeURIComponent(s) + '&chunk=in.(' + part.join(',') + ')');
      rows.forEach(function (r) { got[r.chunk] = r; });
    }
    var srv = serverSheets[s], count = Object.keys(srv).length, old = E.db.sheets[s] || [], merged = [], h = {};
    for (var c = 0; c < count; c++) {
      var piece = got[c] ? got[c].data : old.slice(c * CHUNK_ROWS, (c + 1) * CHUNK_ROWS);
      merged = merged.concat(piece);
      h[c] = srv[c];
    }
    E.db.sheets[s] = merged; hashes[s] = h;
  }
  return names.length;
}
async function loadMeta() {
  var m = await rest('GET', 'ac_meta?select=key,value');
  (m || []).forEach(function (r) { if (r.key === 'props') { E.db.props = r.value || {}; meta.propsHash = hash(JSON.stringify(E.db.props)); } });
  var files = await rest('GET', 'ac_files?select=id,kind,name,mime,parent,trashed,description,created,data');
  (files || []).forEach(function (f) { E.db.files[f.id] = { kind: f.kind, name: f.name, mime: f.mime, parent: f.parent || '', trashed: !!f.trashed, description: f.description || '', created: f.created || 0, data: f.data || '' }; meta.filesHash[f.id] = hash(JSON.stringify(E.db.files[f.id])); });
}
async function loadWorkspace() {
  var cached = await cacheGet(cacheKey()), fromCache = false;
  if (cached && cached.db) {
    E.db = JSON.parse(cached.db, dec); hashes = cached.hashes || {}; meta = cached.meta || { propsHash: '', filesHash: {} }; fromCache = true;
    E.db.sheets = E.db.sheets || {}; E.db.props = E.db.props || {}; E.db.files = E.db.files || {};
  } else {
    E.db = { sheets: {}, props: {}, files: {} }; hashes = {}; meta = { propsHash: '', filesHash: {} };
    var idx = await fetchServerIndex();
    await downloadChanged(idx);
    await loadMeta();
    await saveCache();
  }
  E.resetSheetObjects();
  return fromCache;
}
async function remoteCheck() {
  if (E.dirty.size || E.propsDirty || E.filesDirty.size) return 0;
  var idx = await fetchServerIndex(), n = await downloadChanged(idx);
  var m = await rest('GET', 'ac_meta?select=key,value&key=eq.props');
  if (m && m[0]) { var ph = hash(JSON.stringify(m[0].value || {})); if (ph !== meta.propsHash) { E.db.props = m[0].value || {}; meta.propsHash = ph; n++; } }
  if (n) { E.resetSheetObjects(); await saveCache(); }
  return n;
}

/* ------------------------------ Flush ke Supabase ------------------------------ */
function scheduleFlush(ms) { clearTimeout(flushTimer); flushTimer = setTimeout(function () { flush().catch(function () {}); }, ms == null ? 900 : ms); }
async function flush() {
  if (!SES || !CFG) return;
  if (flushing) { flushAgain = true; return; }
  flushing = true;
  var dirtyNames = Array.from(E.dirty), propsDirty = E.propsDirty, fileIds = Array.from(E.filesDirty);
  E.dirty.clear(); E.propsDirty = false; E.filesDirty.clear();
  try {
    if (!dirtyNames.length && !propsDirty && !fileIds.length) return;
    post({ type: 'sync', state: 'saving' });
    var uid = SES.user.id, items = [], deletes = [], newHashes = {};
    dirtyNames.forEach(function (name) {
      var rows = E.db.sheets[name];
      if (!rows) { deletes.push([name, 0]); newHashes[name] = null; return; }
      var cs = chunksOf(rows), cur = hashes[name] || {}, nh = {};
      cs.forEach(function (c, i) { nh[i] = c.hash; if (cur[i] !== c.hash) items.push({ sheet: name, chunk: i, hash: c.hash, json: c.json }); });
      if (Object.keys(cur).length > cs.length) deletes.push([name, cs.length]);
      newHashes[name] = nh;
    });
    var batch = [], size = 0;
    async function send() {
      if (!batch.length) return;
      var body = '[' + batch.map(function (it) { return '{"user_id":"' + uid + '","sheet":' + JSON.stringify(it.sheet) + ',"chunk":' + it.chunk + ',"hash":"' + it.hash + '","data":' + it.json + '}'; }).join(',') + ']';
      await rest('POST', 'ac_chunks?on_conflict=user_id,sheet,chunk', body, { Prefer: 'resolution=merge-duplicates,return=minimal' });
      batch = []; size = 0;
    }
    for (var i = 0; i < items.length; i++) { batch.push(items[i]); size += items[i].json.length; if (size > BATCH_BYTES) await send(); }
    await send();
    for (var d = 0; d < deletes.length; d++) await rest('DELETE', 'ac_chunks?sheet=eq.' + encodeURIComponent(deletes[d][0]) + '&chunk=gte.' + deletes[d][1], null, { Prefer: 'return=minimal' });
    Object.keys(newHashes).forEach(function (n) { if (newHashes[n] === null) delete hashes[n]; else hashes[n] = newHashes[n]; });
    if (propsDirty) {
      var pj = JSON.stringify(E.db.props), ph = hash(pj);
      if (ph !== meta.propsHash) { await rest('POST', 'ac_meta?on_conflict=user_id,key', JSON.stringify([{ user_id: uid, key: 'props', value: E.db.props }]), { Prefer: 'resolution=merge-duplicates,return=minimal' }); meta.propsHash = ph; }
    }
    for (var f = 0; f < fileIds.length; f++) {
      var id = fileIds[f], rec = E.db.files[id];
      if (!rec) continue;
      var fh = hash(JSON.stringify(rec));
      if (fh === meta.filesHash[id]) continue;
      await rest('POST', 'ac_files?on_conflict=user_id,id', JSON.stringify([{ user_id: uid, id: id, kind: rec.kind, name: rec.name, mime: rec.mime, parent: rec.parent || null, trashed: !!rec.trashed, description: rec.description || '', created: rec.created || 0, data: rec.trashed ? '' : rec.data }]), { Prefer: 'resolution=merge-duplicates,return=minimal' });
      meta.filesHash[id] = fh;
      if (rec.trashed) rec.data = '';
    }
    await saveCache();
    retryMs = 4000;
    post({ type: 'sync', state: 'saved', at: Date.now() });
  } catch (e) {
    dirtyNames.forEach(function (n) { E.dirty.add(n); }); if (propsDirty) E.propsDirty = true; fileIds.forEach(function (id) { E.filesDirty.add(id); });
    await saveCache();
    post({ type: 'sync', state: 'offline', error: String(e && e.message || e) });
    retryMs = Math.min(retryMs * 2, 120000); scheduleFlush(retryMs);
  } finally {
    flushing = false;
    if (flushAgain) { flushAgain = false; scheduleFlush(300); }
  }
}

/* ------------------------------ Impor / ekspor ------------------------------ */
function importWorkspace(data) {
  if (!data || data.format !== 'active-coach-export' || !data.sheets) throw new Error('File bukan ekspor Active Coach yang valid.');
  var keep = {}; ['STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'STRAVA_VERIFY_TOKEN', 'STRAVA_REDIRECT_URI'].forEach(function (k) { if (E.db.props[k] != null) keep[k] = E.db.props[k]; });
  var sheets = JSON.parse(JSON.stringify(data.sheets), dec);
  Object.keys(E.db.sheets).forEach(function (n) { if (!sheets[n]) E.dirty.add(n); });
  E.db.sheets = sheets;
  Object.keys(sheets).forEach(function (n) { E.dirty.add(n); });
  var props = Object.assign({}, data.props || {});
  ['STRAVA_CLIENT_SECRET', 'STRAVA_REDIRECT_URI', 'STRAVA_REDIRECT_URL', 'APP_ATHLETE_ID', '__ACX_TRIGGERS'].forEach(function (k) { delete props[k]; });
  E.db.props = Object.assign(props, keep); E.propsDirty = true;
  Object.keys(data.files || {}).forEach(function (id) { var f = data.files[id]; E.db.files[id] = { kind: f.kind || 'file', name: f.name || id, mime: f.mime || 'application/octet-stream', parent: f.parent || '', trashed: false, description: f.description || '', created: f.created || Date.now(), data: f.data || '' }; E.filesDirty.add(id); });
  E.resetSheetObjects();
  var counts = {}; Object.keys(sheets).forEach(function (n) { counts[n] = Math.max(0, sheets[n].length - 1); });
  return { ok: true, sheets: counts, files: Object.keys(data.files || {}).length };
}
function exportWorkspace() {
  var props = Object.assign({}, E.db.props); delete props.STRAVA_CLIENT_SECRET;
  return JSON.stringify({ format: 'active-coach-export', version: 1, source: 'app', exportedAt: new Date().toISOString(), timezone: E.tz, sheets: E.db.sheets, props: props, files: E.db.files }, enc);
}

/* ------------------------------ Memuat Code.gs ------------------------------ */
function ensureCode() {
  if (codeLoaded) return;
  importScripts('code.js', 'app-engine.js');
  codeLoaded = true;
}
function runCall(fn, args) {
  ensureCode();
  var f = self[fn];
  if (typeof f !== 'function' || fn.charAt(fn.length - 1) === '_' && fn.indexOf('app') !== 0) throw new Error('Fungsi server tidak dikenal: ' + fn);
  var cleanArgs = JSON.parse(JSON.stringify(args || []));
  var result = f.apply(self, cleanArgs);
  return result === undefined ? null : JSON.parse(JSON.stringify(result));
}

/* ------------------------------ Pesan dari aplikasi ------------------------------ */
function enqueue(task) { var p = queue.then(task); queue = p.catch(function () {}); return p; }
self.onmessage = function (ev) {
  var m = ev.data || {};
  if (m.type === 'init') {
    enqueue(async function () {
      try {
        CFG = m.cfg; SES = m.session; E.tz = m.tz || E.tz; E.email = (SES.user && SES.user.email) || '';
        var fromCache = await loadWorkspace();
        ensureCode();
        var cfg = null;
        try {
          await refreshAsync();
          var r = await fetch(CFG.url + '/functions/v1/proxy?config=1', { headers: authHeaders(false) });
          if (r.ok) cfg = await r.json();
        } catch (e) { log('config offline', e); }
        if (cfg) runCall('appEnsureConfig', [cfg]);
        else if (E.db.props.STRAVA_REDIRECT_URI) E.redirectUri = E.db.props.STRAVA_REDIRECT_URI;
        post({ type: 'ready', id: m.id, fromCache: fromCache, online: !!cfg });
        scheduleFlush(1500);
        if (fromCache) remoteCheck().then(function (n) { if (n) post({ type: 'remoteUpdate', count: n }); }).catch(function (e) { post({ type: 'sync', state: 'offline', error: String(e && e.message || e) }); });
      } catch (e) { post({ type: 'ready', id: m.id, error: String(e && e.message || e) }); }
    });
    return;
  }
  if (m.type === 'call') {
    enqueue(async function () {
      var t0 = Date.now();
      try {
        var res = runCall(m.fn, m.args);
        post({ type: 'result', id: m.id, ok: true, value: res, ms: Date.now() - t0 });
      } catch (e) {
        post({ type: 'result', id: m.id, ok: false, error: String(e && e.message || e) });
      }
      if (E.dirty.size || E.propsDirty || E.filesDirty.size) scheduleFlush();
    });
    return;
  }
  if (m.type === 'import') {
    enqueue(async function () {
      try { var r = importWorkspace(m.data); await flush(); post({ type: 'result', id: m.id, ok: true, value: r }); }
      catch (e) { post({ type: 'result', id: m.id, ok: false, error: String(e && e.message || e) }); }
    });
    return;
  }
  if (m.type === 'export') {
    enqueue(async function () { try { post({ type: 'result', id: m.id, ok: true, value: exportWorkspace() }); } catch (e) { post({ type: 'result', id: m.id, ok: false, error: String(e && e.message || e) }); } });
    return;
  }
  if (m.type === 'flush') {
    enqueue(async function () { clearTimeout(flushTimer); try { await flush(); post({ type: 'result', id: m.id, ok: true, value: { pending: E.dirty.size } }); } catch (e) { post({ type: 'result', id: m.id, ok: false, error: String(e && e.message || e) }); } });
    return;
  }
  if (m.type === 'remote') {
    enqueue(async function () { try { var n = await remoteCheck(); post({ type: 'result', id: m.id, ok: true, value: n }); } catch (e) { post({ type: 'result', id: m.id, ok: false, error: String(e && e.message || e) }); } });
    return;
  }
  if (m.type === 'session') { SES = m.session; return; }
  if (m.type === 'wipeCache') { enqueue(async function () { await cacheDel(cacheKey()); post({ type: 'result', id: m.id, ok: true, value: true }); }); return; }
};
