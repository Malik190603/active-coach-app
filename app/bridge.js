/*
 * Active Coach — jembatan aplikasi Android.
 * Menggantikan google.script.run: semua panggilan "server" dijalankan oleh engine (Web Worker)
 * yang memuat Code.gs asli, dengan data tersimpan di Supabase. Juga menangani login dengan Strava,
 * koneksi Strava lewat deep link, tombol kembali Android, getaran (haptics), unduhan/berbagi file,
 * dan impor/cadangan data.
 */
(function () {
  'use strict';
  var CAP = window.Capacitor || null;
  var NATIVE = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());
  var P = (CAP && CAP.Plugins) || {};
  var TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Makassar'; } catch (e) { return 'Asia/Makassar'; } })();
  var LS = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  function $(s) { return document.querySelector(s); }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); }
  function note(t) { try { if (typeof toast === 'function') toast(t); } catch (e) {} }
  function loader(t) { try { if (typeof showGlobalLoader === 'function') showGlobalLoader(t); } catch (e) {} }
  function unloader() { try { if (typeof hideGlobalLoader === 'function') hideGlobalLoader(); } catch (e) {} }
  var PRIVACY_URL = (window.ACX_CONFIG && window.ACX_CONFIG.privacyUrl) || 'https://github.com/Malik190603/active-coach-app/blob/main/PRIVACY.md';
  var domReady = new Promise(function (ok) { if (document.readyState !== 'loading') ok(); else document.addEventListener('DOMContentLoaded', ok); });

  /* ------------------------------ getaran halus (haptics) ------------------------------ */
  var lastHap = 0;
  function haptic(kind) {
    if (!NATIVE || !P.Haptics) return;
    var now = Date.now(); if (now - lastHap < 45) return; lastHap = now;
    try {
      if (kind === 'success' || kind === 'warning' || kind === 'error') P.Haptics.notification({ type: kind.toUpperCase() });
      else P.Haptics.impact({ style: kind === 'heavy' ? 'HEAVY' : kind === 'medium' ? 'MEDIUM' : 'LIGHT' });
    } catch (e) {}
  }
  window.acxHaptic = haptic;
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest && e.target.closest('#bottomNav [data-page],.acx-subtab,.seg-item,.chip,.pill,[data-heat-sport],.st-tpl,.st-tab,.st-swatch,.lg-strava,.acx-btn,.btn.primary');
    if (t) haptic(t.matches('.lg-strava,.acx-btn,.btn.primary') ? 'light' : 'select');
  }, true);

  /* ------------------------------ konfigurasi server ------------------------------ */
  function cfg() {
    var o = LS.get('acx_server') || {}, d = window.ACX_CONFIG || {};
    return { url: String(o.url || d.supabaseUrl || '').trim().replace(/\/+$/, ''), anonKey: String(o.anonKey || d.supabaseAnonKey || '').trim() };
  }
  function configured() { var c = cfg(); return /^https?:\/\//.test(c.url) && c.anonKey.length > 20; }

  /* ------------------------------ sesi ------------------------------ */
  function displayNameOf(s) { var u = (s && s.user) || {}, m = u.user_metadata || {}; return String(m.name || m.full_name || (u.email || 'Atlet').split('@')[0]).replace(/[._]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }).trim(); }
  function isStravaSession(s) { var u = (s && s.user) || {}; return (u.user_metadata && u.user_metadata.provider === 'strava') || /@athlete\.activecoach\.app$/i.test(String(u.email || '')); }
  function stravaIdOf(s) { var u = (s && s.user) || {}; return String((u.user_metadata && u.user_metadata.strava_id) || (String(u.email || '').match(/^strava-(\d+)@/) || [])[1] || ''); }
  async function authLogout(token) {
    var c = cfg();
    try { await fetch(c.url + '/auth/v1/logout', { method: 'POST', headers: { apikey: c.anonKey, Authorization: 'Bearer ' + token } }); } catch (e) {}
  }

  /* ------------------------------ engine worker ------------------------------ */
  var W = null, seq = 0, pending = new Map(), engineReady = false, currentSession = null, syncState = { state: 'idle' }, pendingLink = null;
  function worker() {
    if (!W) {
      W = new Worker('engine/worker.js');
      W.onmessage = onWorkerMessage;
      W.onerror = function (e) { console.error('Engine error', e && e.message); };
    }
    return W;
  }
  function stopWorker(reason) {
    engineReady = false;
    if (W) { W.terminate(); W = null; }
    pending.forEach(function (p) { p.no(new Error(reason || 'Dihentikan')); }); pending.clear();
  }
  function send(msg) { return new Promise(function (ok, no) { var id = ++seq; pending.set(id, { ok: ok, no: no }); worker().postMessage(Object.assign({ id: id }, msg)); }); }
  function onWorkerMessage(ev) {
    var m = ev.data || {};
    if ((m.type === 'result' || m.type === 'ready') && pending.has(m.id)) {
      var p = pending.get(m.id); pending.delete(m.id);
      if (m.type === 'ready') { if (m.error) p.no(new Error(m.error)); else p.ok(m); return; }
      if (m.ok) p.ok(m.value); else p.no(new Error(m.error || 'Terjadi kesalahan'));
      return;
    }
    if (m.type === 'session') { currentSession = m.session; if (!migrating) LS.set('acx_session', m.session); return; }
    if (m.type === 'sync') { var prev = syncState.state; syncState = m; paintSyncState(); if (m.state === 'offline' && prev !== 'offline') note('Offline — perubahan disimpan di HP dan disinkronkan nanti'); return; }
    if (m.type === 'remoteUpdate') { try { if (typeof softRefresh === 'function' && !$('#appShell').hidden) { softRefresh(); note('Data diperbarui dari perangkat lain'); } } catch (e) {} return; }
    if (m.type === 'authExpired') { if (migrating) return; note('Sesi login berakhir, silakan masuk lagi dengan Strava'); forceLoggedOut(); }
  }
  function callEngine(fn, args) { if (!engineReady) return Promise.reject(new Error('Belum masuk ke akun.')); return send({ type: 'call', fn: fn, args: args || [] }); }
  async function startEngine(session, quiet) {
    currentSession = session; if (!quiet) LS.set('acx_session', session);
    var t = quiet ? 0 : setTimeout(function () { loader('Mengunduh data dari server…'); }, 1500);
    try { await send({ type: 'init', cfg: cfg(), session: session, tz: TZ }); }
    finally { clearTimeout(t); }
    engineReady = true;
  }
  function pickAthlete(list) {
    return new Promise(function (ok) {
      var box = document.createElement('div');
      box.className = 'acx-pick';
      box.innerHTML = '<div class="acx-pick-box"><h3>Pilih profil atlet</h3><p>Datamu berisi beberapa atlet. Profil mana yang milikmu?</p><div class="acx-list">' + list.map(function (a) { return '<button type="button" class="acx-row" data-id="' + esc(a.athleteId) + '"><span class="acx-row-ic tone-coral icon"><svg><use href="#i-user"/></svg></span><span class="acx-row-text"><b>' + esc(a.nama) + '</b><small>' + esc(a.athleteId) + '</small></span><span class="acx-row-chev icon"><svg><use href="#i-chevron"/></svg></span></button>'; }).join('') + '</div></div>';
      document.body.appendChild(box);
      box.querySelectorAll('[data-id]').forEach(function (b) { b.onclick = function () { box.remove(); ok(b.dataset.id); }; });
    });
  }
  async function sessionFlow(pick) {
    var r = await callEngine('appSession', [displayNameOf(currentSession), pick || '']);
    if (r && r.needPick) { var id = await pickAthlete(r.athletes || []); r = await callEngine('appSession', [displayNameOf(currentSession), id]); }
    if (!r || !r.ok) throw new Error((r && r.error) || 'Profil atlet tidak ditemukan.');
    return r;
  }
  function forceLoggedOut() {
    LS.del('acx_session'); currentSession = null;
    stopWorker('Keluar');
    try { if (typeof __origLogout === 'function') __origLogout(); } catch (e) {}
    setLoginState('idle');
  }

  /* ------------------------------ Masuk dengan Strava ------------------------------ */
  var authBusy = false, migrating = false, browserOpenAt = 0;
  function setLoginState(state, opts) {
    opts = opts || {};
    var ls = $('#loginScreen'); if (!ls) return;
    ls.setAttribute('data-state', state);
    var btn = $('#stravaLoginBtn'), lbl = $('#stravaLoginLabel'), steps = $('#lgSteps'), cancel = $('#lgCancel');
    if (btn) btn.disabled = state === 'working';
    if (lbl) lbl.textContent = state === 'waiting' ? 'Menunggu izin Strava…' : state === 'working' ? (opts.label || 'Menyiapkan…') : state === 'error' ? 'Connect with Strava' : 'Connect with Strava';
    if (steps) {
      steps.hidden = state !== 'working';
      var order = ['auth', 'account', 'sync'], at = order.indexOf(opts.step || 'auth');
      steps.querySelectorAll('li').forEach(function (li) { var i = order.indexOf(li.dataset.step); li.className = i < at ? 'done' : i === at ? 'now' : ''; });
    }
    if (cancel) cancel.hidden = state !== 'waiting';
    if (state !== 'error') { try { clearAuthError(); } catch (e) {} }
  }
  function loginError(msg) {
    authBusy = false;
    setLoginState('error');
    try { showAuthError(msg); } catch (e) {}
    haptic('error');
  }
  function randomNonce() { var a = new Uint8Array(12); (window.crypto || window.msCrypto).getRandomValues(a); return Array.from(a, function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }
  /* Cek server sebelum membuka Strava, supaya masalah setup tampil jelas di aplikasi (bukan halaman JSON). */
  async function preflight() {
    var c = cfg(), base = c.url + '/functions/v1/', h = { apikey: c.anonKey };
    var r;
    try { r = await fetch(base + 'strava-callback?ping=1', { headers: h, redirect: 'manual', cache: 'no-store' }); }
    catch (e) { return navigator.onLine === false ? 'Tidak ada koneksi internet.' : ''; }
    if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) return 'Fungsi "strava-callback" di Supabase masih versi lama. Buka Supabase › Edge Functions › strava-callback › Code, ganti dengan versi terbaru, lalu Deploy.';
    if (r.status === 404) return 'Fungsi "strava-callback" tidak ditemukan di Supabase. Buka Edge Functions dan pastikan ada fungsi bernama persis "strava-callback" (huruf kecil, pakai tanda minus). Saat membuat lewat editor, ganti nama acaknya dulu sebelum Deploy.';
    if (r.status === 401) return 'Fungsi "strava-callback" masih meminta JWT. Matikan "Verify JWT" di pengaturan fungsi itu, lalu coba lagi.';
    var j = {}; try { j = await r.json(); } catch (e) {}
    if (r.ok && j && j.ok) {
      if (!j.strava) return 'Secret STRAVA_CLIENT_ID belum diisi di Supabase › Edge Functions › Secrets.';
      if (!j.service) return 'Service role key tidak tersedia untuk Edge Function. Coba deploy ulang fungsi "strava-callback".';
      if (j.table === false) return 'Tabel login belum dibuat. Buka Supabase › SQL Editor, tempel isi file supabase/migrations/20261001000000_strava_login.sql, lalu Run.';
      try { var p = await fetch(base + 'proxy?config=1', { headers: h, cache: 'no-store' }); if (p.status === 404) return 'Fungsi "proxy" tidak ditemukan di Supabase. Buat Edge Function bernama persis "proxy" (isi dari supabase/functions/proxy/index.ts) dan matikan "Verify JWT".'; } catch (e) {}
    }
    return '';
  }
  async function startStravaLogin() {
    if (!configured()) { toggleServerPanel(true); note('Atur server dulu (sekali saja)'); return; }
    if (authBusy) return;
    authBusy = true; setLoginState('waiting'); var lb = $('#stravaLoginLabel'); if (lb) lb.textContent = 'Memeriksa server…';
    var problem = await preflight(); authBusy = false;
    if (problem) { loginError(problem); return; }
    var nonce = randomNonce();
    LS.set('acx_auth_nonce', { n: nonce, t: Date.now() });
    var url = cfg().url + '/functions/v1/strava-callback?start=1&nonce=' + nonce;
    setLoginState('waiting');
    browserOpenAt = Date.now();
    if (NATIVE && P.Browser) P.Browser.open({ url: url, presentationStyle: 'popover', toolbarColor: '#fc4c02' }).catch(function (e) { loginError('Tidak bisa membuka Strava: ' + (e && e.message || e)); });
    else _open.call(window, url, '_blank');
  }
  function cancelStravaLogin() {
    try { if (P.Browser) P.Browser.close(); } catch (e) {}
    if (!authBusy) setLoginState('idle');
  }
  function parseLink(url) {
    var m = String(url || '').match(/^activecoach:\/\/([^/?#]+)/i);
    return { host: m ? m[1].toLowerCase() : '', q: new URL(String(url).replace(/^activecoach:\/\/[^/?#]*/i, 'https://app/')).searchParams };
  }
  function redeemHeaders(c) { var h = { apikey: c.anonKey, 'Content-Type': 'application/json' }; if (/^eyJ/.test(c.anonKey)) h.Authorization = 'Bearer ' + c.anonKey; return h; }
  async function redeem(code, nonce) {
    var c = cfg(), r;
    try { r = await fetch(c.url + '/functions/v1/strava-callback?redeem=1', { method: 'POST', headers: redeemHeaders(c), body: JSON.stringify({ code: code, nonce: nonce }) }); }
    catch (e) { throw new Error('Tidak bisa menghubungi server. Periksa koneksi internet lalu coba lagi.'); }
    var j = {}; try { j = await r.json(); } catch (e) {}
    if (r.status === 404) throw new Error('Fungsi "strava-callback" versi terbaru belum di-deploy di Supabase.');
    if (!r.ok) throw new Error(j.error || ('Server menolak (' + r.status + ')'));
    if (!j.session || !j.session.access_token) throw new Error('Server tidak mengirim sesi login.');
    return j;
  }
  async function finishStravaLogin(q) {
    await domReady;
    try { if (P.Browser) P.Browser.close(); } catch (e) {}
    var saved = LS.get('acx_auth_nonce') || {}, nonce = q.get('nonce') || '';
    if (q.get('error')) { LS.del('acx_auth_nonce'); loginError(q.get('error')); return; }
    if (!q.get('code')) { loginError('Balasan login tidak lengkap. Coba lagi.'); return; }
    if (saved.n && nonce && saved.n !== nonce) { loginError('Tautan login ini bukan dari HP ini. Ketuk Masuk dengan Strava lagi.'); return; }
    if (authBusy) return;
    authBusy = true;
    LS.del('acx_auth_nonce');
    var ls = $('#loginScreen'); if (ls && ls.hidden) { try { showLoginScreen(); } catch (e) {} }
    setLoginState('working', { step: 'auth', label: 'Memverifikasi…' });
    try {
      var payload = await redeem(q.get('code'), nonce);
      haptic('success');
      await completeLogin(payload);
    } catch (e) {
      stopWorker('Gagal');
      LS.del('acx_session');
      loginError(e.message || String(e));
    }
  }
  async function completeLogin(payload) {
    setLoginState('working', { step: 'account', label: 'Menyiapkan akun…' });
    // 1) Data dari akun email lama di HP ini → dipindahkan otomatis ke akun Strava
    var legacy = LS.get('acx_legacy_session'), legacyData = null;
    if (legacy && legacy.refresh_token) {
      setLoginState('working', { step: 'account', label: 'Mengambil data lama…' });
      migrating = true;
      try {
        await Promise.race([startEngine(legacy, true), new Promise(function (_, no) { setTimeout(function () { no(new Error('timeout')); }, 45000); })]);
        var info = await callEngine('appWorkspaceInfo', []);
        if (info && info.sheets && (info.sheets.LogAktivitas || info.sheets.Athletes)) legacyData = JSON.parse(await send({ type: 'export' }));
      } catch (e) { console.warn('Data lama tidak bisa diambil', e); }
      stopWorker('ganti akun'); migrating = false;
    }
    // 2) Buka akun Strava
    setLoginState('working', { step: 'account', label: 'Membuka akunmu…' });
    await startEngine(payload.session);
    var moved = 0;
    if (legacyData) {
      var cur = await callEngine('appWorkspaceInfo', []);
      if (!cur || !cur.sheets || !cur.sheets.LogAktivitas) {
        setLoginState('working', { step: 'account', label: 'Memindahkan data lama…' });
        var imp = await send({ type: 'import', data: legacyData });
        moved = (imp && imp.sheets && imp.sheets.LogAktivitas) || 0;
      }
      if (legacy && legacy.access_token) authLogout(legacy.access_token);
    }
    LS.del('acx_legacy_session');
    var ath = (payload.strava && payload.strava.athlete) || {};
    try { await callEngine('appSelectStravaAthlete', [String(ath.id || stravaIdOf(payload.session))]); } catch (e) {}
    var r = await sessionFlow();
    var applied = await callEngine('appApplyStravaLogin', [payload.strava || {}]);
    SESSION = { athleteId: r.athleteId, nama: (applied && applied.nama) || r.nama };
    setLoginState('working', { step: 'sync', label: 'Membuka dasbor…' });
    authBusy = false;
    await new Promise(function (ok) { setTimeout(ok, 350); });
    $('#loginScreen').hidden = true;
    setLoginState('idle');
    startApp();
    afterLogin();
    if (moved) note(moved + ' aktivitas dari akun lama sudah dipindahkan');
    else note('Halo, ' + String(SESSION.nama || 'Atlet').split(' ')[0] + '! 👋');
    if (applied && applied.scopeOk === false) setTimeout(function () { note('Izin "lihat semua aktivitas" tidak dicentang — aktivitas privat tidak ikut. Masuk ulang untuk mengubah.'); }, 2600);
    if (applied && applied.needsFirstSync && !moved && typeof obOpen === 'function') { quietFirstSync(); setTimeout(function () { try { obOpen({ syncing: true }); } catch (e) {} }, 1400); }
    else if (applied && (applied.needsFirstSync || moved)) setTimeout(firstSync, moved ? 2200 : 900);
  }
  async function quietFirstSync() {
    if (!engineReady) return;
    if (typeof LOAD_BUSY !== 'undefined' && LOAD_BUSY) { setTimeout(quietFirstSync, 700); return; }
    var root = document.documentElement; root.classList.add('is-syncing'); autoBusy = true;
    try {
      var r = await callEngine('syncStravaAll', [SESSION.athleteId]); markSynced();
      if (typeof softRefresh === 'function') await softRefresh();
      if (typeof loadStrava === 'function') loadStrava();
      note(((r && r.imported) || 0) + ' aktivitas diimpor dari Strava ✓'); haptic('success');
    } catch (e) { note('Impor Strava gagal: ' + e.message + ' — tarik layar ke bawah untuk mencoba lagi'); }
    root.classList.remove('is-syncing'); autoBusy = false;
  }
  function firstSync() {
    if (!engineReady || typeof syncStrava !== 'function') return;
    if (typeof LOAD_BUSY !== 'undefined' && LOAD_BUSY) { setTimeout(firstSync, 700); return; }
    syncStrava();
  }

  /* ------------------------------ google.script.run pengganti ------------------------------ */
  async function dispatch(fn, args) {
    if (fn === 'loginAthlete' || fn === 'createAthlete') return { ok: false, error: 'Gunakan tombol "Masuk dengan Strava".' };
    if (fn === 'generateReportPdf') return finishReport(await callEngine(fn, args));
    if (fn === 'submitFeedback') {
      var res = await callEngine(fn, args);
      if (res && res.ok) { try { await sendFeedbackCentral(args[0] || {}); res.central = true; } catch (e) { res.central = false; console.warn('Kotak masuk masukan belum siap:', e.message); } }
      try { if (typeof fbAfterSend === 'function') fbAfterSend(); } catch (e) {}
      return res;
    }
    return callEngine(fn, args);
  }
  function runner(ok, no) {
    return new Proxy({}, {
      get: function (_, k) {
        if (k === 'withSuccessHandler') return function (f) { return runner(f, no); };
        if (k === 'withFailureHandler') return function (f) { return runner(ok, f); };
        if (k === 'withUserObject') return function () { return runner(ok, no); };
        return function () {
          var args = [].slice.call(arguments);
          dispatch(String(k), args).then(function (v) { if (ok) ok(v); }, function (e) { if (no) no(e instanceof Error ? e : new Error(String(e))); else console.error(e); });
        };
      }
    });
  }
  window.google = { script: { run: runner(null, null), host: { close: function () {}, setHeight: function () {} }, url: { getLocation: function (cb) { cb({ parameter: {}, parameters: {}, hash: '' }); } } } };

  /* ------------------------------ laporan PDF (HTML -> PDF di HP) ------------------------------ */
  function b64ToUtf8(b64) { var bin = atob(b64), bytes = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return new TextDecoder().decode(bytes); }
  function loadScript(src) { return new Promise(function (ok, no) { if (document.querySelector('script[data-src="' + src + '"]')) return ok(); var s = document.createElement('script'); s.src = src; s.dataset.src = src; s.onload = ok; s.onerror = function () { no(new Error('Gagal memuat ' + src)); }; document.head.appendChild(s); }); }
  function renderChartSpec(spec) {
    var w = spec.width || 620, h = spec.height || 260, cv = document.createElement('canvas');
    cv.width = w * 2; cv.height = h * 2;
    var t = spec.table || { cols: [], rows: [] }, labels = t.rows.map(function (r) { return r[0]; }), colors = spec.colors || ['#fc4c02', '#3a1240', '#1a9c5b'];
    var datasets = t.cols.slice(1).map(function (c, i) { return { label: c.label, data: t.rows.map(function (r) { return r[i + 1]; }), backgroundColor: colors[i % colors.length], borderColor: colors[i % colors.length], borderWidth: spec.kind === 'line' ? 2.2 : 0, pointRadius: 0, tension: spec.options.curveType === 'function' ? 0.35 : 0, fill: false }; });
    var chart = new Chart(cv.getContext('2d'), { type: spec.kind === 'line' ? 'line' : 'bar', data: { labels: labels, datasets: datasets }, options: { responsive: false, animation: false, devicePixelRatio: 2, plugins: { legend: { display: spec.legend === 'bottom' || (datasets.length > 1 && spec.options.legend !== 'none'), position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } }, scales: { x: { ticks: { font: { size: 9 }, color: '#767680', maxRotation: 45, autoSkip: true } }, y: { ticks: { font: { size: 9 }, color: '#767680' }, title: { display: !!(spec.options.vAxis && spec.options.vAxis.title), text: spec.options.vAxis && spec.options.vAxis.title } } } } });
    var bg = document.createElement('canvas'); bg.width = cv.width; bg.height = cv.height;
    var g = bg.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, bg.width, bg.height); g.drawImage(cv, 0, 0);
    var url = bg.toDataURL('image/png'); chart.destroy(); return url;
  }
  async function finishReport(res) {
    if (!res || !res.base64) return res;
    var txt = b64ToUtf8(res.base64);
    if (txt.indexOf('ACXHTML:') !== 0) return res;
    var html = txt.slice(8).replace(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g, function (m, b) { try { var s = b64ToUtf8(b); if (s.indexOf('ACXCHART:') === 0) return renderChartSpec(JSON.parse(s.slice(9))); } catch (e) { console.warn(e); } return m; });
    await loadScript('vendor/html2pdf.bundle.min.js');
    var frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;visibility:hidden';
    document.body.appendChild(frame);
    await new Promise(function (ok) { frame.onload = ok; frame.srcdoc = html; });
    await new Promise(function (ok) { setTimeout(ok, 250); });
    try {
      var doc = frame.contentDocument, body = doc.body;
      var uri = await window.html2pdf().set({ margin: [8, 8, 10, 8], filename: res.filename, image: { type: 'jpeg', quality: 0.92 }, html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', windowWidth: 794 }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }, pagebreak: { mode: ['css', 'legacy'] } }).from(body).outputPdf('datauristring');
      return { base64: String(uri).split(',')[1], filename: res.filename, mimeType: 'application/pdf' };
    } finally { frame.remove(); }
  }

  /* ------------------------------ simpan & bagikan file (Android) ------------------------------ */
  function blobToB64(blob) { return new Promise(function (ok, no) { var r = new FileReader(); r.onload = function () { ok(String(r.result).split(',')[1]); }; r.onerror = no; r.readAsDataURL(blob); }); }
  async function saveAndShare(href, name, text) {
    try {
      var blob = href instanceof Blob ? href : await (await fetch(href)).blob();
      var b64 = await blobToB64(blob);
      var w = await P.Filesystem.writeFile({ path: name, data: b64, directory: 'CACHE' });
      await P.Share.share({ title: name, text: text || undefined, files: [w.uri], dialogTitle: 'Simpan atau bagikan' });
      return true;
    } catch (e) { if (!/cancel/i.test(String(e && e.message || e))) note('Gagal menyimpan file: ' + (e && e.message || e)); return false; }
  }
  /* Bagikan gambar (dipakai Overlay Studio): Android → lembar bagikan (Instagram, WhatsApp, Galeri…);
     browser → Web Share API bila ada, kalau tidak diunduh. */
  /* Simpan gambar/video ke Galeri (album "Active Coach"); di browser: unduh file */
  function blobToDataUrl(blob) { return new Promise(function (ok, no) { var r = new FileReader(); r.onload = function () { ok(String(r.result)); }; r.onerror = no; r.readAsDataURL(blob); }); }
  async function saveMedia(blob, name) {
    if (NATIVE && P.Media) {
      var isVideo = /^video\//.test(blob.type || '') || /\.(mp4|webm)$/i.test(name);
      var base = (await P.Media.getAlbumsPath()).path, album = base + '/Active Coach';
      try { await P.Media.createAlbum({ name: 'Active Coach' }); } catch (e) {}
      var dataUrl = await blobToDataUrl(blob);
      if (isVideo && !/^data:video\//.test(dataUrl)) dataUrl = dataUrl.replace(/^data:[^;]*;/, 'data:video/' + (/webm$/i.test(name) ? 'webm' : 'mp4') + ';');
      await P.Media[isVideo ? 'saveVideo' : 'savePhoto']({ path: dataUrl, albumIdentifier: album, fileName: name.replace(/\.[^.]+$/, '') });
      return true;
    }
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; _click.call(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    return true;
  }
  async function shareImage(blob, name, text) {
    if (NATIVE && P.Filesystem && P.Share) return saveAndShare(blob, name, text);
    try {
      var file = new File([blob], name, { type: blob.type || 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name, text: text || '' }); return true; }
    } catch (e) { if (/abort|cancel/i.test(String(e && e.name || e))) return false; }
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; _click.call(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    return true;
  }
  var _click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (NATIVE && P.Filesystem && P.Share && this.download && /^(blob:|data:)/.test(this.href)) { saveAndShare(this.href, this.download); return; }
    return _click.call(this);
  };
  var _open = window.open;
  window.open = function (url, target, feat) {
    if (NATIVE && P.Browser && /^https?:/i.test(String(url || ''))) { P.Browser.open({ url: String(url), presentationStyle: 'popover' }); return null; }
    return _open.call(window, url, target, feat);
  };

  /* ------------------------------ deep link ------------------------------ */
  async function handleDeepLink(url) {
    if (!/^activecoach:\/\//i.test(String(url || ''))) return;
    var L = parseLink(url);
    if (L.host === 'auth') return finishStravaLogin(L.q);
    if (L.host !== 'strava') return;
    try { if (P.Browser) P.Browser.close(); } catch (e) {}
    if (!engineReady) {
      if (authBusy || ($('#loginScreen') && $('#loginScreen').getAttribute('data-state') === 'waiting')) { loginError('Fungsi "strava-callback" di Supabase masih versi lama. Deploy ulang versi terbaru (lihat README), lalu coba lagi.'); return; }
      pendingLink = url; return;
    }
    var q = L.q;
    loader('Menghubungkan Strava & mengimpor aktivitas…');
    try {
      var r = await callEngine('appFinishOAuth', [q.get('code') || '', q.get('state') || '', q.get('error') || '']);
      unloader();
      haptic(r && r.ok ? 'success' : 'error');
      note(r && r.ok ? 'Strava tersambung — aktivitas sudah diimpor' : ('Strava gagal tersambung: ' + ((r && (r.error || r.message)) || '')));
      if (typeof load === 'function') await load();
      if (typeof loadStrava === 'function') await loadStrava();
    } catch (e) { unloader(); note('Gagal menghubungkan Strava: ' + e.message); }
  }

  /* ------------------------------ UI tambahan ------------------------------ */
  function serverPanelHtml() {
    var c = cfg();
    return '<div class="acx-server" id="acxServer"><b>Hubungkan ke server</b><small>Isi dari Supabase › Project Settings › API. Cukup sekali — tersimpan di HP ini.</small>' +
      '<input id="acxSrvUrl" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://xxxx.supabase.co" value="' + esc(c.url) + '">' +
      '<input id="acxSrvKey" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="anon / publishable key" value="' + esc(c.anonKey) + '">' +
      '<div class="acx-actions-row"><button type="button" class="acx-btn" id="acxSrvSave">Simpan &amp; tes</button></div></div>';
  }
  function toggleServerPanel(show) {
    var host = $('.lg-bottom'), ex = $('#acxServer');
    if (!host) return;
    if (ex && !show) { ex.remove(); return; }
    if (ex) return;
    host.insertAdjacentHTML('afterbegin', serverPanelHtml());
    $('#acxSrvSave').onclick = async function () {
      var url = $('#acxSrvUrl').value.trim().replace(/\/+$/, ''), key = $('#acxSrvKey').value.trim(), btn = this;
      if (!/^https?:\/\//.test(url) || key.length < 20) { note('URL harus diawali https:// dan key tidak boleh kosong'); return; }
      btn.disabled = true; btn.textContent = 'Mengetes…';
      try {
        var r = await fetch(url + '/auth/v1/settings', { headers: { apikey: key } });
        if (!r.ok) throw new Error('Server menjawab ' + r.status);
        LS.set('acx_server', { url: url, anonKey: key }); toggleServerPanel(false); note('Server tersambung. Ketuk Masuk dengan Strava.'); haptic('success');
      } catch (e) { note('Server tidak bisa dihubungi: ' + e.message); haptic('error'); }
      btn.disabled = false; btn.textContent = 'Simpan & tes';
    };
  }
  function initLoginUi() {
    var btn = $('#stravaLoginBtn'); if (btn) btn.onclick = startStravaLogin;
    var c = $('#lgCancel'); if (c) c.onclick = cancelStravaLogin;
    var foot = $('.lg-bottom .auth-foot');
    var legal = $('.lg-legal-t');
    if (legal && !$('#lgPrivacy')) { legal.insertAdjacentHTML('beforeend', ' <a href="#" id="lgPrivacy">Kebijakan privasi</a>'); $('#lgPrivacy').onclick = function (e) { e.preventDefault(); window.open(PRIVACY_URL, '_blank'); }; }
    if (foot && !$('#acxServerLink')) { foot.insertAdjacentHTML('beforebegin', '<button type="button" class="acx-server-link" id="acxServerLink">Pengaturan server</button>'); $('#acxServerLink').onclick = function () { toggleServerPanel(!$('#acxServer')); }; }
    // karusel fitur: geser manual atau otomatis tiap 5 detik
    var track = $('#lgSlides'), dots = [].slice.call(document.querySelectorAll('#lgDots button')), idx = 0, timer = null, touching = false;
    if (!track) return;
    function go(i, smooth) { idx = (i + dots.length) % dots.length; paint(); track.scrollTo({ left: idx * track.clientWidth, behavior: smooth === false ? 'auto' : 'smooth' }); }
    function paint() { dots.forEach(function (d, i) { d.classList.toggle('on', i === idx); }); }
    function auto() { clearInterval(timer); timer = setInterval(function () { var ls = $('#loginScreen'); if (!touching && ls && !ls.hidden && document.visibilityState === 'visible') go(idx + 1); }, 5200); }
    track.addEventListener('scroll', function () { var i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth)); if (i !== idx) { idx = i; paint(); } }, { passive: true });
    track.addEventListener('touchstart', function () { touching = true; }, { passive: true });
    track.addEventListener('touchend', function () { touching = false; auto(); }, { passive: true });
    dots.forEach(function (d, i) { d.onclick = function () { go(i); auto(); }; });
    window.addEventListener('resize', function () { go(idx, false); });
    auto();
  }
  function paintSyncState() {
    var el = $('#acxSyncState'); if (!el) return;
    var s = syncState, t = s.state === 'saving' ? 'Menyimpan ke server…' : s.state === 'offline' ? 'Offline — perubahan tersimpan di HP' : s.state === 'saved' ? ('Tersimpan di server · ' + new Date(s.at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })) : 'Tersinkron dengan server';
    el.textContent = t; el.className = 'acx-syncstate ' + (s.state || '');
  }
  function injectProfileRows() {
    var host = document.querySelector('[data-page-view="profile"] .acx-list');
    if (!host || $('#acxImportRow')) return;
    var c = cfg(), hostName = c.url.replace(/^https?:\/\//, '');
    host.insertAdjacentHTML('beforeend',
      '<div class="acx-row as-static"><span class="acx-row-ic tone-strava icon"><svg viewBox="0 0 24 24"><path fill="currentColor" stroke="none" d="M15.39 17.94 13.3 13.8h-3.07l5.16 10.2 5.15-10.2h-3.07M10.1 0 3.2 13.8h4.06l2.84-5.63 2.84 5.63h4.05z"/></svg></span><span class="acx-row-text"><b>Akun</b><small id="acxAccountName">Masuk dengan Strava</small></span></div>' +
      '<button type="button" class="acx-row" id="acxImportRow"><span class="acx-row-ic tone-green icon"><svg><use href="#i-download"/></svg></span><span class="acx-row-text"><b>Pulihkan dari cadangan</b><small>File .json dari Cadangkan data / Google Sheets lama</small></span><span class="acx-row-chev icon"><svg><use href="#i-chevron"/></svg></span></button>' +
      '<button type="button" class="acx-row" id="acxExportRow"><span class="acx-row-ic tone-indigo icon"><svg><use href="#i-share"/></svg></span><span class="acx-row-text"><b>Cadangkan data</b><small>Simpan salinan lengkap (.json)</small></span><span class="acx-row-chev icon"><svg><use href="#i-chevron"/></svg></span></button>' +
      '<button type="button" class="acx-row" id="acxNotifRow"><span class="acx-row-ic tone-amber icon"><svg><use href="#i-bell"/></svg></span><span class="acx-row-text"><b>Notifikasi</b><small>Pengingat latihan, rekap mingguan, servis</small></span><span class="acx-row-chev icon"><svg><use href="#i-chevron"/></svg></span></button>' +
      '<button type="button" class="acx-row" id="acxImportActRow"><span class="acx-row-ic tone-blue icon"><svg><use href="#i-route"/></svg></span><span class="acx-row-text"><b>Impor aktivitas (GPX/TCX/FIT)</b><small>Dari Garmin, Coros, Wahoo, dll. di luar Strava</small></span><span class="acx-row-chev icon"><svg><use href="#i-chevron"/></svg></span></button>' +
      '<input type="file" id="acxActFile" accept=".gpx,.tcx,.fit,application/gpx+xml,application/octet-stream" hidden>' +
      '<button type="button" class="acx-row" id="acxUpdateRow"><span class="acx-row-ic tone-green icon"><svg><use href="#i-sync"/></svg></span><span class="acx-row-text"><b>Periksa pembaruan</b><small>Versi terpasang ' + esc(window.AC_BUILD || '') + '</small></span><span class="acx-row-chev icon"><svg><use href="#i-chevron"/></svg></span></button>' +
      '<button type="button" class="acx-row" id="acxPrivacyRow"><span class="acx-row-ic tone-gray icon"><svg><use href="#i-shield"/></svg></span><span class="acx-row-text"><b>Privasi & data</b><small>Kebijakan privasi · Powered by Strava</small></span><span class="acx-row-chev icon"><svg><use href="#i-chevron"/></svg></span></button>' +
      '<button type="button" class="acx-row" id="acxDeleteRow"><span class="acx-row-ic tone-red icon"><svg><use href="#i-trash"/></svg></span><span class="acx-row-text"><b style="color:var(--acx-red)">Hapus akun & data</b><small>Hapus permanen dari server & cabut izin Strava</small></span><span class="acx-row-chev icon"><svg><use href="#i-chevron"/></svg></span></button>' +
      '<p class="acx-powered">Active Coach versi ' + esc(window.AC_BUILD || '') + '<br>Powered by Strava · Active Coach tidak berafiliasi dengan Strava.</p>' +
      '<input type="file" id="acxImportFile" accept=".json,application/json,text/plain" hidden>');
    $('#acxDeleteRow').onclick = deleteAccountFlow;
    $('#acxUpdateRow').onclick = function () { checkForUpdate(true); };
    $('#acxNotifRow').onclick = function () { if (typeof nfOpenSettings === 'function') nfOpenSettings(); };
    $('#acxImportActRow').onclick = function () { $('#acxActFile').value = ''; $('#acxActFile').click(); };
    $('#acxActFile').onchange = function (e) { var f = e.target.files && e.target.files[0]; if (f && typeof impImportFile === 'function') impImportFile(f); };
    $('#acxPrivacyRow').onclick = function () { window.open(PRIVACY_URL, '_blank'); };
    paintSyncState();
    $('#acxImportRow').onclick = function () { $('#acxImportFile').value = ''; $('#acxImportFile').click(); };
    $('#acxImportFile').onchange = async function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      var data;
      try { data = JSON.parse(await f.text()); } catch (x) { note('File tidak bisa dibaca sebagai JSON'); return; }
      if (!data || data.format !== 'active-coach-export') { note('Ini bukan file cadangan Active Coach'); return; }
      var n = Object.keys(data.sheets || {}).length;
      if (!confirm('Pulihkan akan MENGGANTI semua data di akun ini dengan isi file (' + n + ' tabel). Lanjutkan?')) return;
      try {
        loader('Memulihkan & mengunggah data…');
        var keep = null; try { keep = await callEngine('appCurrentStrava', []); } catch (x) {}
        var r = await send({ type: 'import', data: data });
        try { await callEngine('appSelectStravaAthlete', [stravaIdOf(currentSession)]); } catch (x) {}
        var s = await sessionFlow(), nama = s.nama;
        if (keep && keep.refresh_token) {
          var nm = displayNameOf(currentSession).split(' ');
          keep.athlete = { id: keep.athlete && keep.athlete.id || stravaIdOf(currentSession), firstname: nm[0] || '', lastname: nm.slice(1).join(' ') };
          keep.scope = 'activity:read_all';
          try { var ap = await callEngine('appApplyStravaLogin', [keep]); if (ap && ap.nama) nama = ap.nama; } catch (x) {}
        }
        SESSION = { athleteId: s.athleteId, nama: nama };
        unloader();
        var rows = r.sheets || {}, logs = rows.LogAktivitas || 0;
        note('Selesai: ' + logs + ' aktivitas, ' + (r.files || 0) + ' file dipulihkan'); haptic('success');
        try { DATA.bikeGarage = null; DATA.pro = null; DATA.profileExtras = null; } catch (x) {}
        await load(); await loadStrava();
      } catch (x) { unloader(); note('Gagal memulihkan: ' + x.message); haptic('error'); }
    };
    $('#acxExportRow').onclick = async function () {
      try {
        loader('Menyiapkan cadangan…');
        var json = await send({ type: 'export' });
        unloader();
        var name = 'active-coach-cadangan-' + new Date().toISOString().slice(0, 10) + '.json', blob = new Blob([json], { type: 'application/json' });
        if (NATIVE && P.Filesystem && P.Share) await saveAndShare(blob, name);
        else { var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; _click.call(a); }
      } catch (x) { unloader(); note('Gagal membuat cadangan: ' + x.message); }
    };
    var rl = $('#reloadBtn small'); if (rl) rl.textContent = 'Ambil ulang data terbaru dari server';
  }
  /* ---------- pembaruan aplikasi: cek rilis terbaru di GitHub ---------- */
  function verParts(v) { return String(v || '').replace(/^v/i, '').split('.').map(function (x) { return parseInt(x, 10) || 0; }); }
  function verNewer(a, b) { var x = verParts(a), y = verParts(b); for (var i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; }
  function currentVersion() { return (window.ACX_CONFIG && window.ACX_CONFIG.version) || window.AC_BUILD || '0'; }
  async function fetchLatestRelease() {
    var repo = (window.ACX_CONFIG && window.ACX_CONFIG.updateRepo) || 'Malik190603/active-coach-app';
    var r = await fetch('https://api.github.com/repos/' + repo + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
    if (!r.ok) throw new Error('GitHub ' + r.status);
    var j = await r.json(), apk = (j.assets || []).find(function (a) { return /\.apk$/i.test(a.name || ''); });
    return { version: String(j.tag_name || '').replace(/^v/i, ''), notes: String(j.body || ''), url: apk ? apk.browser_download_url : j.html_url, page: j.html_url, size: apk ? apk.size : 0, mandatory: /^\s*(##\s*Yang baru\s*)?\[WAJIB\]/m.test(j.body || '') };
  }
  function splitNotes(md) {
    var s = String(md || '').replace(/\r/g, ''), i = s.search(/^## Catatan developer/m);
    return { user: i >= 0 ? s.slice(0, i) : s, dev: i >= 0 ? s.slice(i).replace(/^## Catatan developer\s*/m, '') : '' };
  }
  function mdLines(md, max) {
    return esc(md).replace(/^## (.*)$/gm, '<b class="upd-h">$1</b>').replace(/^[-*] (.*)$/gm, '<span class="upd-li">$1</span>').split('\n').filter(function (l) { return l.trim() && !/Unduh file \.apk/i.test(l); }).slice(0, max || 16).join('<br>');
  }
  function isAdminUser() { try { return typeof FB_ADMIN !== 'undefined' && FB_ADMIN; } catch (e) { return false; } }
  function notesHtml(md) {
    var n = splitNotes(md), html = mdLines(n.user, 16) || 'Perbaikan & peningkatan terbaru.';
    if (n.dev.trim() && isAdminUser()) html += '<details class="upd-dev"><summary>Catatan developer (hanya terlihat olehmu)</summary><div>' + mdLines(n.dev, 30) + '</div></details>';
    return html;
  }
  /* "Yang baru" — tampil sekali setelah aplikasi diperbarui */
  async function showWhatsNew() {
    var cur = currentVersion(), seen = LS.get('acx_seen_version');
    if (!NATIVE || !cur || cur === '0') return;
    if (!seen) { LS.set('acx_seen_version', cur); return; }
    if (seen === cur || !verNewer(cur, seen)) return;
    LS.set('acx_seen_version', cur);
    try {
      var repo = (window.ACX_CONFIG && window.ACX_CONFIG.updateRepo) || 'Malik190603/active-coach-app';
      var r = await fetch('https://api.github.com/repos/' + repo + '/releases/tags/v' + cur, { cache: 'no-store' }); if (!r.ok) return;
      var j = await r.json(), box = document.createElement('div'); box.className = 'st-sheet upd-sheet'; box.id = 'wnSheet';
      box.innerHTML = '<div class="st-sheet-box"><div class="upd-hero"><span class="upd-ic wn"><svg viewBox="0 0 24 24"><path d="M12 3l2.2 5.6L20 9.3l-4.4 3.9 1.3 5.8L12 16l-4.9 3 1.3-5.8L4 9.3l5.8-.7z"/></svg></span><div><h3>Yang baru di versi ' + esc(cur) + '</h3><small>Aplikasi berhasil diperbarui</small></div></div><div class="upd-notes">' + notesHtml(j.body) + '</div><button type="button" class="acx-btn upd-go" id="wnOk">Mantap, lanjut!</button></div>';
      document.body.appendChild(box);
      var close = function () { box.classList.add('out'); setTimeout(function () { box.remove(); }, 220); };
      $('#wnOk').onclick = close; box.onclick = function (e) { if (e.target === box) close(); };
    } catch (e) {}
  }
  /* Pembaruan WAJIB: layar penuh, aplikasi tidak bisa dipakai sampai versi terbaru terpasang.
     APK diunduh di dalam aplikasi (dengan progres) lalu penginstal Android dibuka langsung. */
  var updRel = null, updFile = '', updBusy = false;
  function updSet(state, pct, msg) {
    var bar = $('#updBar'), st = $('#updStatus'), go = $('#updGo'), alt = $('#updAlt');
    if (bar) { bar.parentNode.hidden = state === 'idle'; bar.style.width = Math.max(3, Math.min(100, pct || 0)) + '%'; }
    if (st) st.innerHTML = msg || '';
    if (go) { go.disabled = state === 'downloading'; go.textContent = state === 'downloading' ? 'Mengunduh… ' + Math.round(pct || 0) + '%' : state === 'ready' ? 'Pasang versi ' + updRel.version : 'Perbarui sekarang'; }
    if (alt) alt.hidden = state !== 'error';
  }
  async function updDownload() {
    if (updBusy || !updRel) return;
    if (updFile) return updInstall();
    var FT = P.FileTransfer, FS = P.Filesystem;
    if (!NATIVE || !FT || !FS) { _open.call(window, updRel.url, '_blank'); return; }
    updBusy = true; updSet('downloading', 0, 'Mengunduh versi ' + esc(updRel.version) + '… jangan tutup aplikasi.');
    var handle = null;
    try {
      var name = 'ActiveCoach-' + updRel.version + '.apk';
      try { await FS.deleteFile({ path: name, directory: 'CACHE' }); } catch (e) {}
      var uri = (await FS.getUri({ path: name, directory: 'CACHE' })).uri, path = String(uri).replace(/^file:\/\//, '');
      var total = updRel.size || 0;
      handle = await FT.addListener('progress', function (p) { var t = p.lengthComputable && p.contentLength ? p.contentLength : total; if (t) updSet('downloading', p.bytes / t * 100, 'Mengunduh ' + (p.bytes / 1048576).toFixed(1) + ' / ' + (t / 1048576).toFixed(1) + ' MB'); });
      await FT.downloadFile({ url: updRel.url, path: path, progress: true, connectTimeout: 20000, readTimeout: 60000 });
      updFile = uri; updBusy = false;
      updSet('ready', 100, 'Unduhan selesai. Ketuk <b>Pasang</b>, lalu pilih <b>Update</b>.');
      haptic('success');
      await updInstall();
    } catch (e) {
      updBusy = false; updFile = '';
      updSet('error', 0, 'Unduhan gagal: ' + esc((e && e.message) || e) + '. Periksa internet lalu coba lagi.');
      haptic('error');
    } finally { try { if (handle) handle.remove(); } catch (e) {} }
  }
  async function updInstall() {
    if (!updFile) return;
    try { await P.FileOpener.open({ filePath: updFile, contentType: 'application/vnd.android.package-archive', openWithDefault: true }); updSet('ready', 100, 'Penginstal Android terbuka. Kalau diminta, izinkan <b>Instal aplikasi tidak dikenal</b> untuk Active Coach, lalu kembali dan ketuk <b>Pasang</b> lagi.'); }
    catch (e) { updSet('ready', 100, 'Tidak bisa membuka penginstal (' + esc((e && e.message) || e) + '). Coba lagi atau unduh lewat browser.'); var alt = $('#updAlt'); if (alt) alt.hidden = false; }
  }
  function showUpdateSheet(rel) {
    updRel = rel;
    var box = $('#updSheet');
    if (box && box.dataset.v === rel.version) return;
    if (box) box.remove();
    updFile = '';
    box = document.createElement('div'); box.className = 'upd-gate'; box.id = 'updSheet'; box.dataset.v = rel.version;
    box.innerHTML = '<div class="upd-card"><span class="upd-ic"><svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg></span>' +
      '<h3>Pembaruan wajib</h3><p class="upd-ver">Versi kamu <b>' + esc(currentVersion()) + '</b> sudah tidak berlaku. Pasang versi <b>' + esc(rel.version) + '</b>' + (rel.size ? ' (' + (rel.size / 1048576).toFixed(1) + ' MB)' : '') + ' untuk melanjutkan.</p>' +
      '<div class="upd-notes">' + (notesHtml(rel.notes) || 'Perbaikan & peningkatan terbaru.') + '</div>' +
      '<div class="upd-prog" hidden><i id="updBar"></i></div><p class="upd-status" id="updStatus">Datamu aman — tersimpan di akunmu dan tidak hilang saat update.</p>' +
      '<button type="button" class="acx-btn upd-go" id="updGo">Perbarui sekarang</button>' +
      '<button type="button" class="upd-later" id="updAlt" hidden>Unduh lewat browser</button></div>';
    document.body.appendChild(box);
    $('#updGo').onclick = function () { haptic('light'); updDownload(); };
    $('#updAlt').onclick = function () {
      // buka di aplikasi browser penuh (bukan tab di dalam aplikasi) agar konfirmasi unduhan APK terlihat
      if (NATIVE) { note('Kalau unduhan tertahan di 100%, buka notifikasi browser lalu ketuk "Tetap download".'); setTimeout(function () { window.location.href = rel.url; }, 400); }
      else _open.call(window, rel.url, '_blank');
    };
    updSet('idle', 0, 'Datamu aman — tersimpan di akunmu dan tidak hilang saat update.');
  }
  async function checkForUpdate(manual) {
    if (!manual && !NATIVE) return;
    var cached = LS.get('acx_upd_latest');
    try {
      var rel = await fetchLatestRelease(); LS.set('acx_upd_checked', Date.now()); LS.set('acx_upd_latest', rel);
      if (rel.version && verNewer(rel.version, currentVersion())) showUpdateSheet(rel);
      else { var ex = $('#updSheet'); if (ex) ex.remove(); if (manual) note('Kamu sudah memakai versi terbaru (' + currentVersion() + ')'); }
    } catch (e) {
      // offline / batas API: tetap kunci bila sebelumnya sudah diketahui ada versi lebih baru
      if (cached && cached.version && verNewer(cached.version, currentVersion())) showUpdateSheet(cached);
      else if (manual) note('Tidak bisa memeriksa pembaruan: ' + e.message);
    }
  }

  /* ---------- putuskan Strava (cabut izin) & hapus akun ---------- */
  async function freshSession() {
    var s = currentSession || LS.get('acx_session'); if (!s) return null;
    if (s.expires_at && s.expires_at * 1000 < Date.now() + 60000 && s.refresh_token) {
      var c = cfg();
      try { var r = await fetch(c.url + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: c.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token }) }); if (r.ok) { var j = await r.json(); s = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600), user: j.user || s.user }; currentSession = s; LS.set('acx_session', s); if (W) W.postMessage({ type: 'session', session: s }); } } catch (e) {}
    }
    return s;
  }
  async function callAuthFn(kind, accessToken, userToken) {
    var c = cfg(), h = redeemHeaders(c); if (userToken) h.Authorization = 'Bearer ' + userToken;
    var r = await fetch(c.url + '/functions/v1/strava-callback?' + kind + '=1', { method: 'POST', headers: h, body: JSON.stringify({ access_token: accessToken || '' }) });
    var j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(j.error || ('Server menolak (' + r.status + ')'));
    return j;
  }
  async function disconnectStravaFlow() {
    if (!confirm('Putuskan Strava? Izin Active Coach di akun Strava-mu akan dicabut dan sinkron berhenti. Data yang sudah ada tetap tersimpan.')) return;
    loader('Memutus Strava…');
    try { var tok = await callEngine('appStravaAccessToken', []); if (tok) await callAuthFn('deauth', tok).catch(function () {}); await callEngine('disconnectStrava', [SESSION.athleteId]); unloader(); note('Strava diputus & izin dicabut'); if (typeof loadStrava === 'function') loadStrava(); }
    catch (e) { unloader(); note('Gagal memutus Strava: ' + e.message); }
  }
  async function deleteAccountFlow() {
    if (!confirm('Hapus akun Active Coach beserta SEMUA data (aktivitas, plan, garasi, foto) dari server? Tindakan ini tidak bisa dibatalkan.')) return;
    if (!confirm('Yakin? Ketuk OK sekali lagi untuk menghapus permanen. Izin Strava juga akan dicabut.')) return;
    loader('Menghapus akun & data…');
    try {
      var tok = ''; try { tok = await callEngine('appStravaAccessToken', []); } catch (e) {}
      var s = await freshSession();
      await callAuthFn('delete', tok, s && s.access_token);
      try { await send({ type: 'wipeCache' }); } catch (e) {}
      Object.keys(localStorage).forEach(function (k) { if (/^acx_(session|legacy_session|auth_nonce|last_sync)|^acxStudio:/.test(k)) LS.del(k); });
      unloader(); forceLoggedOut(); note('Akun & semua data sudah dihapus');
    } catch (e) { unloader(); note('Gagal menghapus akun: ' + e.message); }
  }
  function paintAccount() {
    var el = $('#acxAccountName'); if (!el || !currentSession) return;
    var sid = stravaIdOf(currentSession);
    el.textContent = displayNameOf(currentSession) + (sid ? ' · Strava #' + sid : '');
  }
  var triggerTimer = null;
  function runTriggersSoon(ms) {
    clearTimeout(triggerTimer);
    triggerTimer = setTimeout(function () {
      if (!engineReady) return;
      callEngine('appRunDueTriggers', []).then(function (r) { if (r && r.ran && r.ran.length && typeof softRefresh === 'function') softRefresh(); }).catch(function () {});
      runTriggersSoon(30 * 60000);
    }, ms);
  }
  /* Sinkron Strava otomatis & senyap saat aplikasi dibuka/kembali aktif (maks. tiap 20 menit). */
  var autoBusy = false;
  function lastSyncKey() { return 'acx_last_sync_' + ((typeof SESSION !== 'undefined' && SESSION.athleteId) || ''); }
  function markSynced() { LS.set(lastSyncKey(), Date.now()); }
  async function autoSync(force) {
    if (autoBusy || !engineReady || typeof SESSION === 'undefined' || !SESSION.athleteId) return;
    if (!force && Date.now() - (LS.get(lastSyncKey()) || 0) < 20 * 60000) return;
    if (navigator.onLine === false) return;
    if (typeof LOAD_BUSY !== 'undefined' && LOAD_BUSY) { setTimeout(function () { autoSync(force); }, 3000); return; }
    autoBusy = true;
    var root = document.documentElement; root.classList.add('is-syncing');
    try {
      var st = await callEngine('getStravaStatus', [SESSION.athleteId]);
      if (st && st.connected) {
        var r = await callEngine('syncStravaAll', [SESSION.athleteId]);
        markSynced();
        var n = (r && r.imported) || 0;
        if (n > 0) { if (typeof softRefresh === 'function') await softRefresh(); note(n + ' aktivitas baru dari Strava ✓'); haptic('success'); }
      }
    } catch (e) { console.warn('Sinkron otomatis gagal', e && e.message); }
    root.classList.remove('is-syncing'); autoBusy = false;
  }
  /* ---------- webhook Strava: aktivitas baru langsung masuk, izin dicabut terdeteksi ---------- */
  async function userRest(method, path) {
    var s = await freshSession(); if (!s || !s.access_token) throw new Error('no session');
    var c = cfg(), r = await fetch(c.url + '/rest/v1/' + path, { method: method, headers: { apikey: c.anonKey, Authorization: 'Bearer ' + s.access_token } });
    if (!r.ok) throw new Error('REST ' + r.status);
    return method === 'GET' ? r.json() : null;
  }
  async function acxRest(method, path, body, prefer) {
    var s = await freshSession(); if (!s || !s.access_token) throw new Error('Belum masuk');
    var c = cfg(), h = { apikey: c.anonKey, Authorization: 'Bearer ' + s.access_token };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (prefer) h.Prefer = prefer;
    var r = await fetch(c.url + '/rest/v1/' + path, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    var t = await r.text(), j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
    if (!r.ok) { var err = new Error((j && (j.message || j.hint)) || ('Server ' + r.status)); err.status = r.status; err.code = j && j.code; throw err; }
    return j;
  }
  async function sendFeedbackCentral(data) {
    var s = currentSession || {}, dev = (navigator.userAgent.match(/Android [\d.]+[^;)]*;?\s*([^;)]*)/) || [])[0] || navigator.platform || '';
    await acxRest('POST', 'ac_feedback', [{ user_id: s.user && s.user.id, name: (typeof SESSION !== 'undefined' && SESSION.nama) || displayNameOf(s), kind: String(data.tipe || 'Saran fitur').slice(0, 40), message: String(data.pesan || '').trim().slice(0, 4000), app_version: String(window.AC_BUILD || ''), device: String(dev).slice(0, 80) }], 'return=minimal');
  }
  async function ensureWebhook() {
    var last = LS.get('acx_wh_ok') || 0; if (Date.now() - last < 24 * 3600000) return;
    try {
      var s = await freshSession(); if (!s || !s.access_token) return;
      var c = cfg(), h = redeemHeaders(c); h.Authorization = 'Bearer ' + s.access_token;
      var r = await fetch(c.url + '/functions/v1/strava-callback?subscribe=1', { method: 'POST', headers: h, body: '{}' });
      var j = {}; try { j = await r.json(); } catch (e) {}
      if (r.ok && j.linked) LS.set('acx_wh_ok', Date.now());
      if (j.webhook && !j.webhook.ok) console.warn('Webhook Strava:', j.webhook.error);
    } catch (e) {}
  }
  var inboxBusy = false;
  async function checkInbox() {
    if (inboxBusy || !engineReady || navigator.onLine === false || typeof SESSION === 'undefined' || !SESSION.athleteId) return;
    inboxBusy = true;
    try {
      var rows = await userRest('GET', 'ac_meta?select=key,value&key=in.(strava_inbox,strava_revoked)');
      var map = {}; (rows || []).forEach(function (r) { map[r.key] = r.value || {}; });
      if (map.strava_revoked) {
        try { await callEngine('disconnectStrava', [SESSION.athleteId]); } catch (e) {}
        await userRest('DELETE', 'ac_meta?key=eq.strava_revoked').catch(function () {});
        if (typeof loadStrava === 'function') loadStrava();
        note('Izin Strava dicabut dari strava.com — sinkron berhenti. Sambungkan lagi lewat ikon sinkron kapan saja.');
      } else if (map.strava_inbox && map.strava_inbox.at > (LS.get('acx_inbox_seen') || 0)) {
        LS.set('acx_inbox_seen', map.strava_inbox.at);
        await autoSync(true);
      }
    } catch (e) {}
    inboxBusy = false;
  }
  setInterval(function () { if (document.visibilityState === 'visible') checkInbox(); }, 90000);
  function afterLogin() {
    paintAccount();
    runTriggersSoon(8000);
    setTimeout(autoSync, 6000);
    setTimeout(function () { ensureWebhook(); checkInbox(); try { if (typeof fbCheckAdmin === 'function') fbCheckAdmin(); } catch (e) {} }, 4000);
    setTimeout(function () { try { if (typeof nfSchedule === 'function') nfSchedule(); } catch (e) {} }, 12000);
    if (pendingLink) { var l = pendingLink; pendingLink = null; setTimeout(function () { handleDeepLink(l); }, 1500); }
  }

  /* ------------------------------ override fungsi aplikasi ------------------------------ */
  window.initSession = async function () {
    var s = LS.get('acx_session');
    if (authBusy) { showLoginScreen(); setLoginState('working', { step: 'account' }); return; }
    if (s && s.refresh_token && !isStravaSession(s)) {
      // akun email lama → simpan untuk dipindahkan saat masuk dengan Strava
      LS.set('acx_legacy_session', s); LS.del('acx_session'); s = null;
    }
    if (!configured()) { showLoginScreen(); toggleServerPanel(true); return; }
    if (!s || !s.refresh_token) {
      showLoginScreen();
      if (LS.get('acx_legacy_session')) { var n = $('#lgNotice'); if (n) { n.hidden = false; n.innerHTML = '<b>Sekarang masuk pakai Strava.</b> Data dari akun lamamu di HP ini akan dipindahkan otomatis.'; } }
      return;
    }
    loader('Membuka Active Coach…');
    try {
      await startEngine(s);
      try { await callEngine('appSelectStravaAthlete', [stravaIdOf(s)]); } catch (x) {}
      var r = await sessionFlow();
      SESSION = { athleteId: r.athleteId, nama: r.nama };
      unloader();
      $('#loginScreen').hidden = true;
      startApp();
      afterLogin();
    } catch (e) {
      unloader();
      stopWorker('Gagal membuka');
      showLoginScreen();
      if (/kedaluwarsa|masuk lagi|refresh|invalid/i.test(e.message)) LS.del('acx_session');
      else try { showAuthError('Gagal membuka data: ' + e.message); } catch (x) {}
    }
  };
  var __origLogout = null;
  document.addEventListener('DOMContentLoaded', function () {
    initLoginUi(); injectProfileRows();
    checkForUpdate(false);
    setTimeout(showWhatsNew, 7000);
    try { if (typeof nfInit === 'function') nfInit(); } catch (e) {}
    if (typeof logoutAthlete === 'function') {
      __origLogout = logoutAthlete;
      window.logoutAthlete = async function () {
        try { if (engineReady) { loader('Menyimpan & keluar…'); await Promise.race([send({ type: 'flush' }), new Promise(function (ok) { setTimeout(ok, 8000); })]); } } catch (e) {}
        var s = currentSession || LS.get('acx_session');
        if (s && s.access_token) authLogout(s.access_token);
        unloader();
        forceLoggedOut();
      };
    }
    if (typeof syncStrava === 'function') {
      var ss = syncStrava;
      window.syncStrava = async function () { var r = await ss.apply(this, arguments); markSynced(); return r; };
    }
    if (typeof disconnectStrava === 'function') window.disconnectStrava = disconnectStravaFlow;
    if (typeof connectStrava === 'function') {
      window.connectStrava = function (s) { if (!s || !s.configured || !s.authUrl) return note('Server belum punya STRAVA_CLIENT_ID. Isi di Supabase › Edge Functions › Secrets.'); window.open(s.authUrl, '_blank'); };
    }
    if (typeof applyTheme === 'function') {
      var at = applyTheme;
      window.applyTheme = function (t) { at(t); try { if (P.SystemBars) P.SystemBars.setStyle({ style: t === 'dark' ? 'DARK' : 'LIGHT' }); } catch (e) {} try { document.dispatchEvent(new CustomEvent('acx:theme', { detail: t })); } catch (e) {} };
      try { window.applyTheme(document.documentElement.getAttribute('data-theme') || 'light'); } catch (e) {}
    }
    var rb = $('#reloadBtn');
    if (rb) rb.onclick = async function () { var p = $('#syncPopup'); if (p) p.hidden = true; note('Mengambil data terbaru dari server…'); try { await send({ type: 'remote' }); } catch (e) {} load(); };
    window.addEventListener('online', function () { if (engineReady) send({ type: 'flush' }).catch(function () {}); document.documentElement.classList.remove('is-offline'); });
    window.addEventListener('offline', function () { document.documentElement.classList.add('is-offline'); });
    if (navigator.onLine === false) document.documentElement.classList.add('is-offline');
  });

  /* ------------------------------ Android: tombol kembali, resume, deep link ------------------------------ */
  if (NATIVE && P.Browser && P.Browser.addListener) {
    P.Browser.addListener('browserFinished', function () {
      // pengguna menutup halaman Strava tanpa menyelesaikan login
      setTimeout(function () { var ls = $('#loginScreen'); if (!authBusy && ls && ls.getAttribute('data-state') === 'waiting') setLoginState('idle'); }, 1200);
    });
  }
  if (NATIVE && P.App) {
    P.App.addListener('appUrlOpen', function (e) { handleDeepLink(e && e.url); });
    P.App.addListener('backButton', function () {
      if ($('#updSheet')) { try { P.App.minimizeApp(); } catch (e) { P.App.exitApp(); } return; }
      if (typeof window.acxBackHandler === 'function' && window.acxBackHandler()) return;
      var pick = $('.acx-pick'); if (pick) return;
      var pal = $('#searchPopup'); if (pal && !pal.hidden) { closeSearch(); return; }
      var sheets = ['syncPopup', 'feedbackPopup', 'loginDisplayPopup'];
      for (var i = 0; i < sheets.length; i++) { var el = document.getElementById(sheets[i]); if (el && !el.hidden) { el.hidden = true; return; } }
      var md = $('#modal'); if (md && md.classList.contains('show')) { closeModal(); return; }
      var ls = $('#loginScreen'); if (ls && !ls.hidden) { if (ls.getAttribute('data-state') === 'waiting') { cancelStravaLogin(); return; } P.App.exitApp(); return; }
      var v = currentPageView();
      if (v === 'detail') { closeDetailPage(); return; }
      if (v === 'profile') { closeProfile(); return; }
      if (v === 'overlay-editor') { switchPage('sharing', { restoreScroll: true }); return; }
      if (v === 'garage' && typeof GARAGE_UI !== 'undefined' && GARAGE_UI.bikeId) { garageBackToPicker(); return; }
      if (v !== 'dashboard') { switchPage('dashboard', { restoreScroll: true }); return; }
      P.App.exitApp();
    });
    P.App.addListener('resume', function () {
      checkForUpdate(false);
      var ls = $('#loginScreen');
      if (ls && !ls.hidden && ls.getAttribute('data-state') === 'waiting' && !authBusy && Date.now() - browserOpenAt > 4000) setTimeout(function () { if (!authBusy && ls.getAttribute('data-state') === 'waiting') setLoginState('idle'); }, 2500);
      if (!engineReady) return;
      send({ type: 'remote' }).then(function (n) { if (n && typeof softRefresh === 'function') softRefresh(); }).catch(function () {});
      runTriggersSoon(3000);
      setTimeout(autoSync, 2500);
      setTimeout(checkInbox, 1200);
      setTimeout(function () { try { if (typeof fbCheckAdmin === 'function') fbCheckAdmin(); } catch (e) {} }, 2500);
      setTimeout(function () { try { if (typeof nfSchedule === 'function') nfSchedule({ skipGarage: true }); } catch (e) {} }, 6000);
    });
    P.App.addListener('pause', function () { if (engineReady) send({ type: 'flush' }).catch(function () {}); });
    P.App.getLaunchUrl && P.App.getLaunchUrl().then(function (r) { if (r && r.url) handleDeepLink(r.url); }).catch(function () {});
  }

  window.ACX = { saveMedia: saveMedia, rest: acxRest, checkForUpdate: checkForUpdate, checkInbox: checkInbox, ensureWebhook: ensureWebhook, autoSync: autoSync, callEngine: callEngine, send: send, handleDeepLink: handleDeepLink, cfg: cfg, finishReport: finishReport, shareImage: shareImage, haptic: haptic, startStravaLogin: startStravaLogin, native: NATIVE, get ready() { return engineReady; }, get session() { return currentSession; } };
})();
