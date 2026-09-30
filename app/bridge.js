/*
 * Active Coach — jembatan aplikasi Android.
 * Menggantikan google.script.run: semua panggilan "server" dijalankan oleh engine (Web Worker)
 * yang memuat Code.gs asli, dengan data tersimpan di Supabase. Juga menangani login akun,
 * koneksi Strava lewat deep link, tombol kembali Android, unduhan/berbagi file, dan impor data.
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

  /* ------------------------------ konfigurasi server ------------------------------ */
  function cfg() {
    var o = LS.get('acx_server') || {}, d = window.ACX_CONFIG || {};
    return { url: String(o.url || d.supabaseUrl || '').trim().replace(/\/+$/, ''), anonKey: String(o.anonKey || d.supabaseAnonKey || '').trim() };
  }
  function configured() { var c = cfg(); return /^https?:\/\//.test(c.url) && c.anonKey.length > 20; }

  /* ------------------------------ akun (Supabase Auth) ------------------------------ */
  function authMessage(j, status) {
    var code = (j && (j.error_code || j.code || j.error)) || '', msg = (j && (j.msg || j.message || j.error_description)) || '';
    var map = {
      invalid_credentials: 'Email atau sandi salah.', invalid_grant: 'Email atau sandi salah.',
      email_not_confirmed: 'Email belum dikonfirmasi. Buka email dari Supabase lalu ketuk tautannya, kemudian masuk lagi.',
      user_already_exists: 'Email ini sudah terdaftar. Silakan masuk.', email_exists: 'Email ini sudah terdaftar. Silakan masuk.',
      weak_password: 'Sandi terlalu lemah (minimal 6 karakter).', validation_failed: 'Format email atau sandi tidak valid.',
      over_email_send_rate_limit: 'Terlalu banyak percobaan. Tunggu beberapa menit.', signup_disabled: 'Pendaftaran akun baru dimatikan di server.'
    };
    if (map[code]) return map[code];
    if (/Invalid login credentials/i.test(msg)) return 'Email atau sandi salah.';
    if (/already registered/i.test(msg)) return 'Email ini sudah terdaftar. Silakan masuk.';
    if (/Password should be/i.test(msg)) return 'Sandi minimal 6 karakter.';
    return msg || ('Server menolak (' + status + ').');
  }
  async function authReq(path, body, token) {
    var c = cfg(), h = { apikey: c.anonKey, 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    var r;
    try { r = await fetch(c.url + '/auth/v1/' + path, { method: 'POST', headers: h, body: JSON.stringify(body || {}) }); }
    catch (e) { throw new Error('Tidak bisa menghubungi server. Periksa koneksi internet.'); }
    var j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(authMessage(j, r.status));
    return j;
  }
  function toSession(j) { return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600), user: j.user }; }
  function displayNameOf(s) { var u = (s && s.user) || {}, m = u.user_metadata || {}; return String(m.name || m.full_name || (u.email || 'Atlet').split('@')[0]).replace(/[._]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }).trim(); }

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
  function send(msg) { return new Promise(function (ok, no) { var id = ++seq; pending.set(id, { ok: ok, no: no }); worker().postMessage(Object.assign({ id: id }, msg)); }); }
  function onWorkerMessage(ev) {
    var m = ev.data || {};
    if ((m.type === 'result' || m.type === 'ready') && pending.has(m.id)) {
      var p = pending.get(m.id); pending.delete(m.id);
      if (m.type === 'ready') { if (m.error) p.no(new Error(m.error)); else p.ok(m); return; }
      if (m.ok) p.ok(m.value); else p.no(new Error(m.error || 'Terjadi kesalahan'));
      return;
    }
    if (m.type === 'session') { currentSession = m.session; LS.set('acx_session', m.session); return; }
    if (m.type === 'sync') { var prev = syncState.state; syncState = m; paintSyncState(); if (m.state === 'offline' && prev !== 'offline') note('Offline — perubahan disimpan di HP dan disinkronkan nanti'); return; }
    if (m.type === 'remoteUpdate') { try { if (typeof softRefresh === 'function' && !$('#appShell').hidden) { softRefresh(); note('Data diperbarui dari perangkat lain'); } } catch (e) {} return; }
    if (m.type === 'authExpired') { note('Sesi login berakhir, silakan masuk lagi'); forceLoggedOut(); }
  }
  function callEngine(fn, args) { if (!engineReady) return Promise.reject(new Error('Belum masuk ke akun.')); return send({ type: 'call', fn: fn, args: args || [] }); }
  async function startEngine(session) {
    currentSession = session; LS.set('acx_session', session);
    var t = setTimeout(function () { try { if (typeof showGlobalLoader === 'function') showGlobalLoader('Mengunduh data dari server…'); } catch (e) {} }, 1200);
    try { await send({ type: 'init', cfg: cfg(), session: session, tz: TZ }); }
    finally { clearTimeout(t); }
    engineReady = true;
  }
  function pickAthlete(list) {
    return new Promise(function (ok) {
      var box = document.createElement('div');
      box.className = 'acx-pick';
      box.innerHTML = '<div class="acx-pick-box"><h3>Pilih profil atlet</h3><p>Data yang diimpor berisi beberapa atlet. Profil mana yang milikmu?</p><div class="acx-list">' + list.map(function (a) { return '<button type="button" class="acx-row" data-id="' + esc(a.athleteId) + '"><span class="acx-row-ic tone-coral icon"><svg><use href="#i-user"/></svg></span><span class="acx-row-text"><b>' + esc(a.nama) + '</b><small>' + esc(a.athleteId) + '</small></span><span class="acx-row-chev icon"><svg><use href="#i-chevron"/></svg></span></button>'; }).join('') + '</div></div>';
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
  async function appLogin(email, password) {
    if (!configured()) return { ok: false, error: 'Server belum diatur. Ketuk "Atur server" di bawah.' };
    try {
      var j = await authReq('token?grant_type=password', { email: String(email || '').trim(), password: String(password || '') });
      await startEngine(toSession(j));
      var r = await sessionFlow();
      afterLogin();
      return { ok: true, athleteId: r.athleteId, nama: r.nama, fotoProfil: r.fotoProfil };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }
  async function appRegister(email, password) {
    if (!configured()) throw new Error('Server belum diatur. Ketuk "Atur server" di bawah.');
    email = String(email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Masukkan alamat email yang valid.');
    if (String(password || '').length < 6) throw new Error('Sandi minimal 6 karakter.');
    var j = await authReq('signup', { email: email, password: password, data: { name: email.split('@')[0] } });
    if (!j.access_token && !(j.session && j.session.access_token)) throw new Error('Akun dibuat. Buka email konfirmasi dari server, ketuk tautannya, lalu masuk. (Atau matikan "Confirm email" di Supabase agar langsung bisa masuk.)');
    return [];
  }
  function forceLoggedOut() {
    LS.del('acx_session'); engineReady = false; currentSession = null;
    if (W) { W.terminate(); W = null; pending.forEach(function (p) { p.no(new Error('Keluar')); }); pending.clear(); }
    try { if (typeof __origLogout === 'function') __origLogout(); } catch (e) {}
  }

  /* ------------------------------ google.script.run pengganti ------------------------------ */
  async function dispatch(fn, args) {
    if (fn === 'loginAthlete') return appLogin(args[0], args[1]);
    if (fn === 'createAthlete') return appRegister(args[0], args[1]);
    if (fn === 'generateReportPdf') return finishReport(await callEngine(fn, args));
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
  async function saveAndShare(href, name) {
    try {
      var blob = href instanceof Blob ? href : await (await fetch(href)).blob();
      var b64 = await blobToB64(blob);
      var w = await P.Filesystem.writeFile({ path: name, data: b64, directory: 'CACHE' });
      await P.Share.share({ title: name, files: [w.uri], dialogTitle: 'Simpan atau bagikan' });
    } catch (e) { if (!/cancel/i.test(String(e && e.message || e))) note('Gagal menyimpan file: ' + (e && e.message || e)); }
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

  /* ------------------------------ deep link Strava ------------------------------ */
  async function handleDeepLink(url) {
    if (!/^activecoach:\/\/strava/i.test(String(url || ''))) return;
    try { if (P.Browser) P.Browser.close(); } catch (e) {}
    if (!engineReady) { pendingLink = url; return; }
    var q = new URL(String(url).replace(/^activecoach:\/\//i, 'https://app/')).searchParams;
    try { showGlobalLoader('Menghubungkan Strava & mengimpor aktivitas…'); } catch (e) {}
    try {
      var r = await callEngine('appFinishOAuth', [q.get('code') || '', q.get('state') || '', q.get('error') || '']);
      try { hideGlobalLoader(); } catch (e) {}
      note(r && r.ok ? 'Strava tersambung — aktivitas sudah diimpor' : ('Strava gagal tersambung: ' + ((r && (r.error || r.message)) || '')));
      if (typeof load === 'function') await load();
      if (typeof loadStrava === 'function') await loadStrava();
    } catch (e) { try { hideGlobalLoader(); } catch (x) {} note('Gagal menghubungkan Strava: ' + e.message); }
  }

  /* ------------------------------ UI tambahan ------------------------------ */
  function injectStyles() {
    var css = '.acx-pick{position:fixed;inset:0;z-index:300;background:rgba(10,10,20,.45);display:flex;align-items:center;justify-content:center;padding:18px}' +
      '.acx-pick-box{width:100%;max-width:440px;background:var(--acx-surface,#fff);border-radius:22px;padding:18px;box-shadow:0 20px 60px -20px rgba(0,0,0,.5)}.acx-pick-box h3{margin:0 0 4px;font-size:19px}.acx-pick-box p{margin:0 0 12px;color:var(--acx-text-2,#666);font-size:13.5px}' +
      '.acx-server{margin:0 0 14px;padding:14px;border-radius:16px;border:1px solid var(--acx-line,#ddd);background:var(--acx-surface-2,#f7f7fa);text-align:left}.acx-server b{display:block;font-size:14.5px;margin-bottom:2px}.acx-server small{display:block;color:var(--acx-text-2,#666);font-size:12px;margin-bottom:10px;line-height:1.4}' +
      '.acx-server input{width:100%;box-sizing:border-box;height:42px;margin:0 0 8px;padding:0 12px;border-radius:12px;border:1px solid var(--acx-line-2,#ccc);background:var(--acx-surface,#fff);color:var(--acx-text,#111);font:500 14px Inter,system-ui}' +
      '.acx-server .acx-actions-row{margin-top:4px}.acx-server-link{display:block;margin:10px auto 0;border:0;background:none;color:var(--acx-text-3,#999);font:600 12.5px Inter,system-ui;cursor:pointer}' +
      '.acx-syncstate.saving{color:var(--acx-blue)}.acx-syncstate.offline{color:var(--acx-orange)}';
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  }
  function serverPanelHtml() {
    var c = cfg();
    return '<div class="acx-server" id="acxServer"><b>Hubungkan ke server</b><small>Isi dari Supabase › Project Settings › API. Cukup sekali — tersimpan di HP ini.</small>' +
      '<input id="acxSrvUrl" type="url" inputmode="url" autocomplete="off" placeholder="https://xxxx.supabase.co" value="' + esc(c.url) + '">' +
      '<input id="acxSrvKey" type="text" autocomplete="off" placeholder="anon / publishable key" value="' + esc(c.anonKey) + '">' +
      '<div class="acx-actions-row"><button type="button" class="acx-btn" id="acxSrvSave">Simpan & tes</button></div></div>';
  }
  function toggleServerPanel(show) {
    var host = $('.auth-right'), ex = $('#acxServer');
    if (!host) return;
    if (ex && !show) { ex.remove(); return; }
    if (ex) return;
    host.insertAdjacentHTML('afterbegin', serverPanelHtml());
    $('#acxSrvSave').onclick = async function () {
      var url = $('#acxSrvUrl').value.trim().replace(/\/+$/, ''), key = $('#acxSrvKey').value.trim(), btn = this;
      if (!/^https:\/\//.test(url) || key.length < 20) { note('URL harus diawali https:// dan key tidak boleh kosong'); return; }
      btn.disabled = true; btn.textContent = 'Mengetes…';
      try {
        var r = await fetch(url + '/auth/v1/settings', { headers: { apikey: key } });
        if (!r.ok) throw new Error('Server menjawab ' + r.status);
        LS.set('acx_server', { url: url, anonKey: key }); toggleServerPanel(false); note('Server tersambung. Silakan masuk atau daftar.');
      } catch (e) { note('Server tidak bisa dihubungi: ' + e.message); }
      btn.disabled = false; btn.textContent = 'Simpan & tes';
    };
  }
  function tweakLogin() {
    var lf = $('#loginForm'), rf = $('#registerForm');
    [lf, rf].forEach(function (f, i) {
      if (!f) return;
      var n = f.querySelector('input[name=nama]'), p = f.querySelector('input[name=pin]');
      if (n) { n.type = 'email'; n.placeholder = 'Email'; n.autocomplete = 'email'; n.setAttribute('inputmode', 'email'); n.setAttribute('autocapitalize', 'off'); }
      if (p) { p.placeholder = i ? 'Buat sandi (min. 6 karakter)' : 'Sandi'; p.minLength = 6; }
    });
    var ic = document.querySelectorAll('.auth-field-icon use');
    ic.forEach(function (u) { if (u.getAttribute('href') === '#i-user') u.setAttribute('href', '#i-mail'); });
    var t = $('#authToggle');
    if (t && !$('#acxServerLink')) { t.insertAdjacentHTML('afterend', '<button type="button" class="acx-server-link" id="acxServerLink">Atur server</button>'); $('#acxServerLink').onclick = function () { toggleServerPanel(!$('#acxServer')); }; }
    if (typeof setAuthMode === 'function' && !setAuthMode.__acx) {
      var orig = setAuthMode;
      window.setAuthMode = function (mode) { orig(mode); var i = $('#authIntro'); if (i) i.textContent = mode === 'login' ? 'Masuk dengan email & sandi akun Active Coach-mu.' : 'Buat akun baru — datamu tersimpan aman di server pribadimu.'; };
      window.setAuthMode.__acx = true;
    }
    var intro = $('#authIntro'); if (intro && lf && !lf.hidden) intro.textContent = 'Masuk dengan email & sandi akun Active Coach-mu.';
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
      '<div class="acx-row as-static"><span class="acx-row-ic tone-teal icon"><svg><use href="#i-layers"/></svg></span><span class="acx-row-text"><b>Penyimpanan</b><small id="acxSyncState">Tersinkron dengan server</small><small>' + esc(hostName) + '</small></span></div>' +
      '<button type="button" class="acx-row" id="acxImportRow"><span class="acx-row-ic tone-green icon"><svg><use href="#i-download"/></svg></span><span class="acx-row-text"><b>Impor dari Google Sheets</b><small>Pakai file ekspor (.json) dari Apps Script lama</small></span><span class="acx-row-chev icon"><svg><use href="#i-chevron"/></svg></span></button>' +
      '<button type="button" class="acx-row" id="acxExportRow"><span class="acx-row-ic tone-indigo icon"><svg><use href="#i-share"/></svg></span><span class="acx-row-text"><b>Cadangkan data</b><small>Simpan salinan lengkap (.json)</small></span><span class="acx-row-chev icon"><svg><use href="#i-chevron"/></svg></span></button>' +
      '<input type="file" id="acxImportFile" accept=".json,application/json,text/plain" hidden>');
    paintSyncState();
    $('#acxImportRow').onclick = function () { $('#acxImportFile').value = ''; $('#acxImportFile').click(); };
    $('#acxImportFile').onchange = async function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      var data;
      try { data = JSON.parse(await f.text()); } catch (x) { note('File tidak bisa dibaca sebagai JSON'); return; }
      if (!data || data.format !== 'active-coach-export') { note('Ini bukan file ekspor Active Coach'); return; }
      var n = Object.keys(data.sheets || {}).length;
      if (!confirm('Impor akan MENGGANTI semua data di akun ini dengan isi file (' + n + ' sheet). Lanjutkan?')) return;
      try {
        showGlobalLoader('Mengimpor & mengunggah data…');
        var r = await send({ type: 'import', data: data });
        var s = await sessionFlow();
        SESSION = { athleteId: s.athleteId, nama: s.nama };
        hideGlobalLoader();
        var rows = r.sheets || {}, logs = rows.LogAktivitas || 0;
        note('Impor selesai: ' + logs + ' aktivitas, ' + (r.files || 0) + ' file');
        try { DATA.bikeGarage = null; DATA.pro = null; DATA.profileExtras = null; } catch (x) {}
        await load(); await loadStrava();
      } catch (x) { hideGlobalLoader(); note('Impor gagal: ' + x.message); }
    };
    $('#acxExportRow').onclick = async function () {
      try {
        showGlobalLoader('Menyiapkan cadangan…');
        var json = await send({ type: 'export' });
        hideGlobalLoader();
        var name = 'active-coach-cadangan-' + new Date().toISOString().slice(0, 10) + '.json', blob = new Blob([json], { type: 'application/json' });
        if (NATIVE && P.Filesystem && P.Share) await saveAndShare(blob, name);
        else { var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; _click.call(a); }
      } catch (x) { hideGlobalLoader(); note('Gagal membuat cadangan: ' + x.message); }
    };
    var rl = $('#reloadBtn small'); if (rl) rl.textContent = 'Ambil ulang data terbaru dari server';
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
  function afterLogin() {
    runTriggersSoon(8000);
    if (pendingLink) { var l = pendingLink; pendingLink = null; setTimeout(function () { handleDeepLink(l); }, 1500); }
  }

  /* ------------------------------ override fungsi aplikasi ------------------------------ */
  window.initSession = async function () {
    var s = LS.get('acx_session');
    if (!configured()) { showLoginScreen(); toggleServerPanel(true); return; }
    if (!s || !s.refresh_token) { showLoginScreen(); return; }
    showGlobalLoader('Membuka Active Coach…');
    try {
      await startEngine(s);
      var r = await sessionFlow();
      SESSION = { athleteId: r.athleteId, nama: r.nama };
      hideGlobalLoader();
      $('#loginScreen').hidden = true;
      startApp();
      afterLogin();
    } catch (e) {
      hideGlobalLoader();
      if (W) { W.terminate(); W = null; } engineReady = false;
      showLoginScreen();
      if (/kedaluwarsa|masuk lagi/i.test(e.message)) LS.del('acx_session');
      else try { showAuthError('Gagal membuka data: ' + e.message); } catch (x) {}
    }
  };
  var __origLogout = null;
  document.addEventListener('DOMContentLoaded', function () {
    injectStyles(); tweakLogin(); injectProfileRows();
    if (typeof logoutAthlete === 'function') {
      __origLogout = logoutAthlete;
      window.logoutAthlete = async function () {
        try { if (engineReady) { showGlobalLoader('Menyimpan & keluar…'); await Promise.race([send({ type: 'flush' }), new Promise(function (ok) { setTimeout(ok, 8000); })]); } } catch (e) {}
        var s = currentSession || LS.get('acx_session');
        try { if (s && s.access_token) authReq('logout', {}, s.access_token).catch(function () {}); } catch (e) {}
        try { hideGlobalLoader(); } catch (e) {}
        forceLoggedOut();
      };
    }
    if (typeof connectStrava === 'function') {
      window.connectStrava = function (s) { if (!s || !s.configured || !s.authUrl) return note('Server belum punya STRAVA_CLIENT_ID. Isi di Supabase › Edge Functions › Secrets.'); window.open(s.authUrl, '_blank'); };
    }
    if (typeof applyTheme === 'function') {
      var at = applyTheme;
      window.applyTheme = function (t) { at(t); try { if (P.SystemBars) P.SystemBars.setStyle({ style: t === 'dark' ? 'DARK' : 'LIGHT' }); } catch (e) {} };
      try { window.applyTheme(document.documentElement.getAttribute('data-theme') || 'light'); } catch (e) {}
    }
    var rb = $('#reloadBtn');
    if (rb) rb.onclick = async function () { var p = $('#syncPopup'); if (p) p.hidden = true; note('Mengambil data terbaru dari server…'); try { await send({ type: 'remote' }); } catch (e) {} load(); };
  });

  /* ------------------------------ Android: tombol kembali, resume, deep link ------------------------------ */
  if (NATIVE && P.App) {
    P.App.addListener('appUrlOpen', function (e) { handleDeepLink(e && e.url); });
    P.App.addListener('backButton', function () {
      var pal = $('#searchPopup'); if (pal && !pal.hidden) { closeSearch(); return; }
      var sheets = ['syncPopup', 'feedbackPopup', 'loginDisplayPopup'];
      for (var i = 0; i < sheets.length; i++) { var el = document.getElementById(sheets[i]); if (el && !el.hidden) { el.hidden = true; return; } }
      var md = $('#modal'); if (md && md.classList.contains('show')) { closeModal(); return; }
      var ls = $('#loginScreen'); if (ls && !ls.hidden) { P.App.exitApp(); return; }
      var v = currentPageView();
      if (v === 'detail') { closeDetailPage(); return; }
      if (v === 'profile') { closeProfile(); return; }
      if (v === 'overlay-editor') { switchPage('sharing', { restoreScroll: true }); return; }
      if (v === 'garage' && typeof GARAGE_UI !== 'undefined' && GARAGE_UI.bikeId) { garageBackToPicker(); return; }
      if (v !== 'dashboard') { switchPage('dashboard', { restoreScroll: true }); return; }
      P.App.exitApp();
    });
    P.App.addListener('resume', function () {
      if (!engineReady) return;
      send({ type: 'remote' }).then(function (n) { if (n && typeof softRefresh === 'function') softRefresh(); }).catch(function () {});
      runTriggersSoon(3000);
    });
    P.App.addListener('pause', function () { if (engineReady) send({ type: 'flush' }).catch(function () {}); });
    P.App.getLaunchUrl && P.App.getLaunchUrl().then(function (r) { if (r && r.url) handleDeepLink(r.url); }).catch(function () {});
  }

  window.ACX = { callEngine: callEngine, send: send, handleDeepLink: handleDeepLink, cfg: cfg, finishReport: finishReport, get ready() { return engineReady; } };
})();
