/*
 * Active Coach Engine — lapisan kompatibel Google Apps Script.
 * Menjalankan Code.gs apa adanya di dalam Web Worker: SpreadsheetApp, PropertiesService,
 * UrlFetchApp (sinkron lewat proxy Supabase), DriveApp, Utilities, dsb. meniru perilaku Apps Script.
 * Data disimpan di memori (ENGINE.db) lalu disinkronkan ke Supabase oleh worker.js.
 */
(function (G) {
  'use strict';

  var ENGINE = G.ACX_ENGINE = {
    db: { sheets: {}, props: {}, files: {} },
    dirty: new Set(),
    propsDirty: false,
    filesDirty: new Set(),
    tz: 'Asia/Makassar',
    email: '',
    redirectUri: '',
    http: null,
    cache: new Map(),
    logs: []
  };

  function reviveDate(v) { return v instanceof Date ? new Date(v.getTime()) : v; }
  function cell(v) { return v === undefined || v === null ? '' : v; }

  /* ------------------------------ Tanggal ------------------------------ */
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], DOWL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var fmtCache = {};
  function partsIn(date, tz) {
    var key = tz || 'UTC', f = fmtCache[key];
    if (!f) {
      try { f = new Intl.DateTimeFormat('en-US', { timeZone: key, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }); }
      catch (e) { f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }); }
      fmtCache[key] = f;
    }
    var o = {};
    f.formatToParts(date).forEach(function (p) { o[p.type] = p.value; });
    var hour = Number(o.hour) % 24;
    return { y: Number(o.year), M: Number(o.month), d: Number(o.day), H: hour, m: Number(o.minute), s: Number(o.second), dow: DOW.indexOf(o.weekday), ms: date.getMilliseconds() };
  }
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function tzOffsetStr(date, tz) {
    var p = partsIn(date, tz), asUtc = Date.UTC(p.y, p.M - 1, p.d, p.H, p.m, p.s), off = Math.round((asUtc - (date.getTime() - date.getMilliseconds())) / 60000);
    var sign = off >= 0 ? '+' : '-'; off = Math.abs(off);
    return sign + pad(Math.floor(off / 60), 2) + pad(off % 60, 2);
  }
  function formatDate(date, tz, format) {
    if (!(date && typeof date.getTime === 'function') || isNaN(date.getTime())) throw new Error('Invalid argument: date');
    var p = partsIn(date, tz), out = '', i = 0, f = String(format || '');
    while (i < f.length) {
      var ch = f[i];
      if (ch === "'") { var j = f.indexOf("'", i + 1); if (j < 0) j = f.length; out += j === i + 1 ? "'" : f.slice(i + 1, j); i = j + 1; continue; }
      if (!/[A-Za-z]/.test(ch)) { out += ch; i++; continue; }
      var n = 1; while (f[i + n] === ch) n++;
      var tok = ch, v;
      switch (tok) {
        case 'y': v = n === 2 ? pad(p.y % 100, 2) : pad(p.y, n); break;
        case 'M': v = n >= 4 ? MONL[p.M - 1] : n === 3 ? MON[p.M - 1] : pad(p.M, n); break;
        case 'd': v = pad(p.d, n); break;
        case 'H': v = pad(p.H, n); break;
        case 'k': v = pad(p.H === 0 ? 24 : p.H, n); break;
        case 'h': v = pad(p.H % 12 === 0 ? 12 : p.H % 12, n); break;
        case 'K': v = pad(p.H % 12, n); break;
        case 'm': v = pad(p.m, n); break;
        case 's': v = pad(p.s, n); break;
        case 'S': v = pad(p.ms, 3).slice(0, n); break;
        case 'E': v = n >= 4 ? DOWL[p.dow] : DOW[p.dow]; break;
        case 'u': v = String(p.dow === 0 ? 7 : p.dow); break;
        case 'a': v = p.H < 12 ? 'AM' : 'PM'; break;
        case 'Z': v = tzOffsetStr(date, tz); break;
        case 'X': v = tzOffsetStr(date, tz).replace(/(\d{2})(\d{2})$/, n >= 3 ? '$1:$2' : '$1$2'); break;
        case 'z': v = tz || 'UTC'; break;
        default: v = new Array(n + 1).join(tok);
      }
      out += v; i += n;
    }
    return out;
  }

  /* ------------------------------ Bytes / base64 / digest ------------------------------ */
  function utf8Bytes(str) { return Array.from(new TextEncoder().encode(String(str))); }
  function bytesToStr(bytes) { return new TextDecoder().decode(Uint8Array.from(bytes, function (b) { return b & 255; })); }
  function b64enc(bytes) {
    var bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, Array.prototype.map.call(bytes.slice(i, i + CH), function (b) { return b & 255; }));
    return btoa(bin);
  }
  function b64dec(str) {
    var bin = atob(String(str).replace(/\s+/g, '')), out = new Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function toBytes(data) { if (data == null) return []; if (typeof data === 'string') return utf8Bytes(data); if (data.getBytes) return data.getBytes(); return Array.from(data, function (b) { return b & 255; }); }
  function sha256(bytes) {
    var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var m = bytes.map(function (b) { return b & 255; }), l = m.length * 8;
    m.push(0x80); while (m.length % 64 !== 56) m.push(0);
    for (var s = 56; s >= 0; s -= 8) m.push(s >= 32 ? 0 : (l >>> s) & 255);
    var w = new Array(64);
    for (var i = 0; i < m.length; i += 64) {
      for (var t = 0; t < 16; t++) w[t] = (m[i + t * 4] << 24) | (m[i + t * 4 + 1] << 16) | (m[i + t * 4 + 2] << 8) | m[i + t * 4 + 3];
      for (t = 16; t < 64; t++) {
        var x = w[t - 15], y = w[t - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3), s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7)), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K[t] + w[t]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10)), mj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = [];
    H.forEach(function (v) { out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); });
    return out.map(function (b) { return b > 127 ? b - 256 : b; });
  }

  /* ------------------------------ Blob ------------------------------ */
  function Blob_(bytes, type, name) { this._b = bytes || []; this._t = type || 'application/octet-stream'; this._n = name || ''; }
  Blob_.prototype.getBytes = function () { return this._b.slice(); };
  Blob_.prototype.getDataAsString = function () { return bytesToStr(this._b); };
  Blob_.prototype.getContentType = function () { return this._t; };
  Blob_.prototype.setContentType = function (t) { this._t = t; return this; };
  Blob_.prototype.getName = function () { return this._n; };
  Blob_.prototype.setName = function (n) { this._n = n; return this; };
  Blob_.prototype.copyBlob = function () { return new Blob_(this._b.slice(), this._t, this._n); };
  Blob_.prototype.setDataFromString = function (s) { this._b = utf8Bytes(s); return this; };
  Blob_.prototype.setBytes = function (b) { this._b = toBytes(b); return this; };
  Blob_.prototype.getAs = function (mime) {
    // HTML -> PDF dirender di perangkat (bridge.js) karena Apps Script tidak ada di sini.
    if (mime === 'application/pdf' && /html/.test(this._t)) return new Blob_(utf8Bytes('ACXHTML:' + this.getDataAsString()), 'application/pdf', this._n.replace(/\.html?$/, '.pdf'));
    return new Blob_(this._b.slice(), mime, this._n);
  };
  Blob_.prototype.isGoogleType = function () { return false; };

  /* ------------------------------ Spreadsheet ------------------------------ */
  var COLS = function (letters) { var n = 0; for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64); return n; };
  function parseA1(a1, sheet) {
    var s = String(a1).toUpperCase().replace(/\$/g, '').replace(/^.*!/, ''), m;
    if ((m = s.match(/^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/))) {
      var c1 = COLS(m[1]), r1 = m[2] ? Number(m[2]) : 1, c2 = m[3] ? COLS(m[3]) : c1, r2 = m[4] ? Number(m[4]) : (m[2] && !m[3] ? r1 : Math.max(sheet.getMaxRows(), 1));
      return [Math.min(r1, r2), Math.min(c1, c2), Math.abs(r2 - r1) + 1, Math.abs(c2 - c1) + 1];
    }
    if ((m = s.match(/^(\d+):(\d+)$/))) return [Number(m[1]), 1, Number(m[2]) - Number(m[1]) + 1, Math.max(sheet.getMaxColumns(), 1)];
    throw new Error('Range tidak dikenal: ' + a1);
  }
  var sheetObjs = {};
  function Sheet(name) { this._name = name; }
  Sheet.prototype._d = function () { var d = ENGINE.db.sheets[this._name]; if (!d) { d = ENGINE.db.sheets[this._name] = []; } return d; };
  Sheet.prototype._touch = function () { ENGINE.dirty.add(this._name); };
  Sheet.prototype._ensure = function (rows, cols) {
    var d = this._d();
    while (d.length < rows) d.push([]);
    for (var i = 0; i < rows; i++) { var r = d[i]; while (r.length < cols) r.push(''); }
  };
  Sheet.prototype.getName = function () { return this._name; };
  Sheet.prototype.getSheetName = Sheet.prototype.getName;
  Sheet.prototype.getSheetId = function () { return Math.abs(this._name.split('').reduce(function (h, c) { return (h * 31 + c.charCodeAt(0)) | 0; }, 7)); };
  Sheet.prototype.setName = function (n) { var d = this._d(); delete ENGINE.db.sheets[this._name]; ENGINE.dirty.add(this._name); this._name = n; ENGINE.db.sheets[n] = d; this._touch(); return this; };
  Sheet.prototype.getLastRow = function () {
    var d = this._d(), n = d.length;
    while (n > 0) { var r = d[n - 1], empty = true; for (var j = 0; j < r.length; j++) { var v = r[j]; if (v !== '' && v !== null && v !== undefined) { empty = false; break; } } if (!empty) break; n--; }
    return n;
  };
  Sheet.prototype.getLastColumn = function () {
    var d = this._d(), max = 0;
    for (var i = 0; i < d.length; i++) { var r = d[i]; for (var j = r.length - 1; j >= max; j--) { var v = r[j]; if (v !== '' && v !== null && v !== undefined) { max = j + 1; break; } } }
    return max;
  };
  Sheet.prototype.getMaxRows = function () { return Math.max(1000, this._d().length); };
  Sheet.prototype.getMaxColumns = function () { var d = this._d(), w = 26; for (var i = 0; i < d.length; i++) if (d[i].length > w) w = d[i].length; return w; };
  Sheet.prototype.getRange = function (r, c, nr, nc) {
    if (typeof r === 'string') { var a = parseA1(r, this); return new Range(this, a[0], a[1], a[2], a[3]); }
    if (!(r >= 1) || !(c >= 1)) throw new Error('Koordinat range tidak valid: ' + r + ',' + c);
    nr = nr === undefined ? 1 : nr; nc = nc === undefined ? 1 : nc;
    if (!(nr >= 1) || !(nc >= 1)) throw new Error('Jumlah baris/kolom range harus minimal 1.');
    return new Range(this, r, c, nr, nc);
  };
  Sheet.prototype.getDataRange = function () { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); };
  Sheet.prototype.appendRow = function (row) {
    var d = this._d(), n = this.getLastRow(), copy = (row || []).map(function (v) { return reviveDate(cell(v)); });
    d.splice(n, 0, copy); this._touch(); return this;
  };
  Sheet.prototype.deleteRow = function (r) { this._d().splice(r - 1, 1); this._touch(); return this; };
  Sheet.prototype.deleteRows = function (r, n) { this._d().splice(r - 1, n); this._touch(); return this; };
  Sheet.prototype.insertRowBefore = function (r) { this._d().splice(r - 1, 0, []); this._touch(); return this; };
  Sheet.prototype.insertRowAfter = function (r) { this._d().splice(r, 0, []); this._touch(); return this; };
  Sheet.prototype.insertRowsAfter = function (r, n) { var d = this._d(); for (var i = 0; i < n; i++) d.splice(r, 0, []); this._touch(); return this; };
  Sheet.prototype.insertRowsBefore = function (r, n) { var d = this._d(); for (var i = 0; i < n; i++) d.splice(r - 1, 0, []); this._touch(); return this; };
  Sheet.prototype.deleteColumn = function (c) { this._d().forEach(function (row) { row.splice(c - 1, 1); }); this._touch(); return this; };
  Sheet.prototype.deleteColumns = function (c, n) { this._d().forEach(function (row) { row.splice(c - 1, n); }); this._touch(); return this; };
  Sheet.prototype.clearContents = function () { var d = this._d(); d.length = 0; this._touch(); return this; };
  Sheet.prototype.clear = Sheet.prototype.clearContents;
  ['insertColumnsAfter', 'insertColumnsBefore', 'insertColumnAfter', 'insertColumnBefore', 'setFrozenRows', 'setFrozenColumns', 'autoResizeColumns', 'autoResizeColumn', 'setColumnWidth', 'setColumnWidths', 'hideSheet', 'showSheet', 'activate', 'hideColumns', 'showColumns', 'setTabColor', 'clearFormats', 'setRowHeight'].forEach(function (k) { Sheet.prototype[k] = function () { return this; }; });
  Sheet.prototype.getFrozenRows = function () { return 1; };
  Sheet.prototype.getParent = function () { return SS; };

  function Range(sheet, r, c, nr, nc) { this._s = sheet; this._r = r; this._c = c; this._nr = nr; this._nc = nc; }
  Range.prototype.getValues = function () {
    var d = this._s._d(), out = new Array(this._nr);
    for (var i = 0; i < this._nr; i++) {
      var src = d[this._r - 1 + i], row = new Array(this._nc);
      for (var j = 0; j < this._nc; j++) { var v = src ? src[this._c - 1 + j] : ''; row[j] = reviveDate(cell(v)); }
      out[i] = row;
    }
    return out;
  };
  Range.prototype.getDisplayValues = function () {
    return this.getValues().map(function (row) { return row.map(function (v) { return v instanceof Date ? formatDate(v, ENGINE.tz, 'yyyy-MM-dd') : String(v); }); });
  };
  Range.prototype.setValues = function (vals) {
    if (!vals || vals.length !== this._nr) throw new Error('Jumlah baris data (' + (vals ? vals.length : 0) + ') tidak cocok dengan range (' + this._nr + ').');
    this._s._ensure(this._r + this._nr - 1, this._c + this._nc - 1);
    var d = this._s._d();
    for (var i = 0; i < this._nr; i++) {
      if (!vals[i] || vals[i].length !== this._nc) throw new Error('Jumlah kolom data (' + (vals[i] ? vals[i].length : 0) + ') tidak cocok dengan range (' + this._nc + ').');
      for (var j = 0; j < this._nc; j++) {
        var v = vals[i][j];
        if (typeof v === 'string' && v.length > 50000) throw new Error('Isi sel terlalu panjang (maks 50000 karakter).');
        d[this._r - 1 + i][this._c - 1 + j] = reviveDate(cell(v));
      }
    }
    this._s._touch();
    return this;
  };
  Range.prototype.setValue = function (v) { var row = []; for (var j = 0; j < this._nc; j++) row.push(v); var all = []; for (var i = 0; i < this._nr; i++) all.push(row.slice()); return this.setValues(all); };
  Range.prototype.getValue = function () { return this.getValues()[0][0]; };
  Range.prototype.getDisplayValue = function () { return this.getDisplayValues()[0][0]; };
  Range.prototype.clearContent = function () { var d = this._s._d(); for (var i = 0; i < this._nr; i++) { var row = d[this._r - 1 + i]; if (!row) continue; for (var j = 0; j < this._nc; j++) if (this._c - 1 + j < row.length) row[this._c - 1 + j] = ''; } this._s._touch(); return this; };
  Range.prototype.clear = Range.prototype.clearContent;
  Range.prototype.getNumRows = function () { return this._nr; };
  Range.prototype.getNumColumns = function () { return this._nc; };
  Range.prototype.getRow = function () { return this._r; };
  Range.prototype.getColumn = function () { return this._c; };
  Range.prototype.getLastRow = function () { return this._r + this._nr - 1; };
  Range.prototype.getLastColumn = function () { return this._c + this._nc - 1; };
  Range.prototype.getSheet = function () { return this._s; };
  Range.prototype.getA1Notation = function () { function L(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; } return L(this._c) + this._r + ':' + L(this._c + this._nc - 1) + (this._r + this._nr - 1); };
  ['setNumberFormat', 'setNumberFormats', 'setFontWeight', 'setFontWeights', 'setBackground', 'setBackgrounds', 'setFontColor', 'setFontColors', 'setHorizontalAlignment', 'setVerticalAlignment', 'setWrap', 'setFontSize', 'setFontFamily', 'setBorder', 'setNote', 'protect', 'activate', 'setDataValidation', 'merge', 'breakApart'].forEach(function (k) { Range.prototype[k] = function () { return this; }; });

  var SS = {
    getSheetByName: function (name) { if (!Object.prototype.hasOwnProperty.call(ENGINE.db.sheets, name)) return null; return sheetObjs[name] || (sheetObjs[name] = new Sheet(name)); },
    insertSheet: function (name) { name = name || ('Sheet' + (Object.keys(ENGINE.db.sheets).length + 1)); if (ENGINE.db.sheets[name]) throw new Error('Sheet "' + name + '" sudah ada.'); ENGINE.db.sheets[name] = []; ENGINE.dirty.add(name); return this.getSheetByName(name); },
    getSheets: function () { var self = this; return Object.keys(ENGINE.db.sheets).map(function (n) { return self.getSheetByName(n); }); },
    deleteSheet: function (sh) { delete ENGINE.db.sheets[sh.getName()]; delete sheetObjs[sh.getName()]; ENGINE.dirty.add(sh.getName()); },
    getName: function () { return 'Active Coach'; },
    getId: function () { return 'active-coach-supabase'; },
    getUrl: function () { return ''; },
    getSpreadsheetTimeZone: function () { return ENGINE.tz; },
    toast: function () {},
    getRange: function (a1) { var m = String(a1).match(/^'?(.+?)'?!(.+)$/); if (!m) throw new Error('Sertakan nama sheet: ' + a1); return this.getSheetByName(m[1]).getRange(m[2]); }
  };
  ENGINE.resetSheetObjects = function () { sheetObjs = {}; };

  G.SpreadsheetApp = { getActiveSpreadsheet: function () { return SS; }, getActive: function () { return SS; }, openById: function () { return SS; }, flush: function () {}, getUi: function () { return { alert: function () {}, createMenu: function () { return { addItem: function () { return this; }, addToUi: function () {} }; } }; } };

  /* ------------------------------ Properties / Cache / Lock ------------------------------ */
  var Props = {
    getProperty: function (k) { var v = ENGINE.db.props[k]; return v === undefined ? null : v; },
    setProperty: function (k, v) { ENGINE.db.props[k] = String(v); ENGINE.propsDirty = true; return this; },
    deleteProperty: function (k) { delete ENGINE.db.props[k]; ENGINE.propsDirty = true; return this; },
    getProperties: function () { return Object.assign({}, ENGINE.db.props); },
    setProperties: function (obj, deleteOthers) { if (deleteOthers) ENGINE.db.props = {}; Object.keys(obj || {}).forEach(function (k) { ENGINE.db.props[k] = String(obj[k]); }); ENGINE.propsDirty = true; return this; },
    getKeys: function () { return Object.keys(ENGINE.db.props); },
    deleteAllProperties: function () { ENGINE.db.props = {}; ENGINE.propsDirty = true; return this; }
  };
  G.PropertiesService = { getScriptProperties: function () { return Props; }, getUserProperties: function () { return Props; }, getDocumentProperties: function () { return Props; } };
  var Cache = {
    get: function (k) { var e = ENGINE.cache.get(k); if (!e) return null; if (e.exp < Date.now()) { ENGINE.cache.delete(k); return null; } return e.v; },
    put: function (k, v, ttl) { ENGINE.cache.set(k, { v: String(v), exp: Date.now() + Math.min(21600, ttl || 600) * 1000 }); },
    remove: function (k) { ENGINE.cache.delete(k); },
    getAll: function (keys) { var o = {}; keys.forEach(function (k) { var v = Cache.get(k); if (v !== null) o[k] = v; }); return o; },
    putAll: function (obj, ttl) { Object.keys(obj).forEach(function (k) { Cache.put(k, obj[k], ttl); }); },
    removeAll: function (keys) { keys.forEach(function (k) { ENGINE.cache.delete(k); }); }
  };
  G.CacheService = { getScriptCache: function () { return Cache; }, getUserCache: function () { return Cache; }, getDocumentCache: function () { return Cache; } };
  var Lock = { waitLock: function () {}, tryLock: function () { return true; }, releaseLock: function () {}, hasLock: function () { return true; } };
  G.LockService = { getScriptLock: function () { return Lock; }, getUserLock: function () { return Lock; }, getDocumentLock: function () { return Lock; } };

  /* ------------------------------ UrlFetchApp ------------------------------ */
  function formEncode(obj) { return Object.keys(obj).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k] == null ? '' : obj[k]); }).join('&'); }
  function HTTPResponse(res) { this._r = res; }
  HTTPResponse.prototype.getResponseCode = function () { return this._r.status; };
  HTTPResponse.prototype.getContentText = function () { return this._r.body || ''; };
  HTTPResponse.prototype.getHeaders = function () { return this._r.headers || {}; };
  HTTPResponse.prototype.getAllHeaders = HTTPResponse.prototype.getHeaders;
  HTTPResponse.prototype.getBlob = function () { return new Blob_(utf8Bytes(this._r.body || ''), (this._r.headers || {})['content-type'] || 'text/plain'); };
  HTTPResponse.prototype.getAs = function (m) { return this.getBlob().getAs(m); };
  function fetchOne(url, opts) {
    opts = opts || {};
    if (!ENGINE.http) throw new Error('Koneksi internet belum siap.');
    var method = String(opts.method || 'get').toUpperCase(), headers = Object.assign({}, opts.headers || {}), body = null;
    if (opts.payload != null && method !== 'GET') {
      if (typeof opts.payload === 'string') { body = opts.payload; headers['Content-Type'] = opts.contentType || headers['Content-Type'] || 'application/x-www-form-urlencoded'; }
      else if (opts.payload && opts.payload.getBytes) { body = opts.payload.getDataAsString(); headers['Content-Type'] = opts.contentType || opts.payload.getContentType(); }
      else { body = formEncode(opts.payload); headers['Content-Type'] = opts.contentType || 'application/x-www-form-urlencoded'; }
    } else if (opts.contentType) headers['Content-Type'] = opts.contentType;
    var res = ENGINE.http({ url: url, method: method, headers: headers, body: body });
    if (!opts.muteHttpExceptions && (res.status < 200 || res.status >= 400)) throw new Error('Request failed for ' + url.replace(/\?.*$/, '') + ' returned code ' + res.status + '. Truncated server response: ' + String(res.body || '').slice(0, 300));
    return new HTTPResponse(res);
  }
  G.UrlFetchApp = {
    fetch: fetchOne,
    fetchAll: function (reqs) { return reqs.map(function (r) { return typeof r === 'string' ? fetchOne(r) : fetchOne(r.url, r); }); },
    getRequest: function (url, opts) { return { url: url, method: (opts && opts.method) || 'get' }; }
  };

  /* ------------------------------ Utilities ------------------------------ */
  G.Utilities = {
    formatDate: formatDate,
    base64Encode: function (d) { return b64enc(toBytes(d)); },
    base64EncodeWebSafe: function (d) { return b64enc(toBytes(d)).replace(/\+/g, '-').replace(/\//g, '_'); },
    base64Decode: function (s) { return b64dec(s).map(function (b) { return b > 127 ? b - 256 : b; }); },
    base64DecodeWebSafe: function (s) { return G.Utilities.base64Decode(String(s).replace(/-/g, '+').replace(/_/g, '/')); },
    newBlob: function (data, type, name) { return new Blob_(toBytes(data), type, name); },
    sleep: function (ms) { var end = Date.now() + Math.min(Number(ms) || 0, 30000); while (Date.now() < end) { /* tunggu */ } },
    getUuid: function () { return (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); },
    computeDigest: function (alg, value) { if (String(alg).indexOf('256') < 0) throw new Error('Hanya SHA_256 yang didukung.'); return sha256(toBytes(value)); },
    DigestAlgorithm: { SHA_256: 'SHA_256', SHA_1: 'SHA_1', MD5: 'MD5' },
    Charset: { UTF_8: 'UTF-8', US_ASCII: 'US-ASCII' },
    formatString: function (fmt) { var args = [].slice.call(arguments, 1), i = 0; return String(fmt).replace(/%[sdif]/g, function () { return String(args[i++]); }); },
    jsonParse: JSON.parse, jsonStringify: JSON.stringify,
    parseCsv: function (s) { return String(s).split(/\r?\n/).filter(Boolean).map(function (l) { return l.split(','); }); }
  };
  G.MimeType = { HTML: 'text/html', PDF: 'application/pdf', PLAIN_TEXT: 'text/plain', JPEG: 'image/jpeg', PNG: 'image/png', GIF: 'image/gif', CSV: 'text/csv', JSON: 'application/json', ZIP: 'application/zip', GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet', FOLDER: 'application/vnd.google-apps.folder' };

  /* ------------------------------ Charts (dirender di perangkat saat membuat PDF) ------------------------------ */
  function chartBuilder(kind) {
    var spec = { kind: kind, colors: null, options: {}, width: 600, height: 300, legend: null, table: null };
    var b = {
      setDataTable: function (t) { spec.table = t && t._t ? t._t : t; return b; },
      setDimensions: function (w, h) { spec.width = w; spec.height = h; return b; },
      setColors: function (c) { spec.colors = c; return b; },
      setOption: function (k, v) { spec.options[k] = v; return b; },
      setLegendPosition: function (p) { spec.legend = p; return b; },
      setTitle: function (t) { spec.options.title = t; return b; },
      setXAxisTitle: function (t) { spec.options.xTitle = t; return b; },
      setYAxisTitle: function (t) { spec.options.yTitle = t; return b; },
      setStacked: function () { spec.options.stacked = true; return b; },
      setCurveStyle: function (c) { spec.options.curveType = c; return b; },
      setPointStyle: function () { return b; },
      setBackgroundColor: function (c) { spec.options.backgroundColor = c; return b; },
      build: function () { return { getAs: function () { return new Blob_(utf8Bytes('ACXCHART:' + JSON.stringify(spec)), 'image/png', 'chart.png'); }, getBlob: function () { return this.getAs('image/png'); } }; }
    };
    return b;
  }
  G.Charts = {
    newDataTable: function () { var t = { cols: [], rows: [] }, api = { addColumn: function (type, label) { t.cols.push({ type: type, label: label }); return api; }, addRow: function (r) { t.rows.push(r); return api; }, build: function () { return { _t: t }; } }; return api; },
    newColumnChart: function () { return chartBuilder('column'); },
    newBarChart: function () { return chartBuilder('bar'); },
    newLineChart: function () { return chartBuilder('line'); },
    newAreaChart: function () { return chartBuilder('area'); },
    newPieChart: function () { return chartBuilder('pie'); },
    ColumnType: { STRING: 'string', NUMBER: 'number', DATE: 'date' },
    Position: { BOTTOM: 'bottom', TOP: 'top', RIGHT: 'right', LEFT: 'left', NONE: 'none' },
    CurveStyle: { SMOOTH: 'function', NORMAL: 'none' }
  };

  /* ------------------------------ DriveApp (disimpan di Supabase tabel ac_files) ------------------------------ */
  function newId(prefix) { var s = prefix || 'f', abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'; for (var i = 0; i < 26; i++) s += abc[Math.floor(Math.random() * abc.length)]; return s; }
  function Iter(list) { var i = 0; return { hasNext: function () { return i < list.length; }, next: function () { if (i >= list.length) throw new Error('Tidak ada item lagi.'); return list[i++]; } }; }
  function fileObj(id) {
    var rec = ENGINE.db.files[id];
    if (!rec) throw new Error('File dengan ID ' + id + ' tidak ditemukan.');
    if (rec.kind === 'folder') return folderObj(id);
    return {
      getId: function () { return id; },
      getName: function () { return rec.name; },
      setName: function (n) { rec.name = n; ENGINE.filesDirty.add(id); return this; },
      getMimeType: function () { return rec.mime; },
      getSize: function () { return Math.round((rec.data || '').length * 0.75); },
      getBlob: function () { return new Blob_(b64dec(rec.data || ''), rec.mime, rec.name); },
      getAs: function (m) { return this.getBlob().getAs(m); },
      setDescription: function (d) { rec.description = d; ENGINE.filesDirty.add(id); return this; },
      getDescription: function () { return rec.description || ''; },
      setTrashed: function (t) { rec.trashed = !!t; ENGINE.filesDirty.add(id); return this; },
      isTrashed: function () { return !!rec.trashed; },
      getParents: function () { return Iter(rec.parent && ENGINE.db.files[rec.parent] ? [folderObj(rec.parent)] : []); },
      getUrl: function () { return ''; },
      getDateCreated: function () { return new Date(rec.created || Date.now()); },
      setSharing: function () { return this; }
    };
  }
  function folderObj(id) {
    var rec = ENGINE.db.files[id];
    return {
      getId: function () { return id; },
      getName: function () { return rec.name; },
      createFile: function (blobOrName, content, mime) {
        var blob = typeof blobOrName === 'string' ? new Blob_(toBytes(content || ''), mime || 'text/plain', blobOrName) : blobOrName;
        var fid = newId('f');
        ENGINE.db.files[fid] = { kind: 'file', name: blob.getName() || fid, mime: blob.getContentType(), data: b64enc(blob.getBytes()), parent: id, trashed: false, created: Date.now() };
        ENGINE.filesDirty.add(fid);
        return fileObj(fid);
      },
      getFiles: function () { return Iter(Object.keys(ENGINE.db.files).filter(function (k) { var f = ENGINE.db.files[k]; return f.kind === 'file' && f.parent === id && !f.trashed; }).map(fileObj)); },
      getFilesByName: function (n) { return Iter(Object.keys(ENGINE.db.files).filter(function (k) { var f = ENGINE.db.files[k]; return f.kind === 'file' && f.parent === id && f.name === n && !f.trashed; }).map(fileObj)); },
      getUrl: function () { return ''; },
      setTrashed: function (t) { rec.trashed = !!t; ENGINE.filesDirty.add(id); return this; },
      setSharing: function () { return this; }
    };
  }
  G.DriveApp = {
    getFoldersByName: function (name) { return Iter(Object.keys(ENGINE.db.files).filter(function (k) { var f = ENGINE.db.files[k]; return f.kind === 'folder' && f.name === name && !f.trashed; }).map(folderObj)); },
    createFolder: function (name) { var id = newId('d'); ENGINE.db.files[id] = { kind: 'folder', name: name, mime: MimeType.FOLDER, data: '', trashed: false, created: Date.now() }; ENGINE.filesDirty.add(id); return folderObj(id); },
    getFolderById: function (id) { return folderObj(id); },
    getFileById: function (id) { return fileObj(id); },
    getRootFolder: function () { var r = G.DriveApp.getFoldersByName('__root__'); return r.hasNext() ? r.next() : G.DriveApp.createFolder('__root__'); },
    createFile: function (blobOrName, content, mime) { return G.DriveApp.getRootFolder().createFile(blobOrName, content, mime); },
    getFilesByName: function (n) { return G.DriveApp.getRootFolder().getFilesByName(n); },
    Access: { ANYONE_WITH_LINK: 1, PRIVATE: 0 }, Permission: { VIEW: 1, EDIT: 2 }
  };

  /* ------------------------------ Session / ScriptApp / Html / Content / Logger ------------------------------ */
  G.Session = {
    getScriptTimeZone: function () { return ENGINE.tz; },
    getActiveUser: function () { return { getEmail: function () { return ENGINE.email; } }; },
    getEffectiveUser: function () { return { getEmail: function () { return ENGINE.email; } }; },
    getTemporaryActiveUserKey: function () { return ENGINE.email; }
  };
  var TKEY = '__ACX_TRIGGERS';
  function readTriggers() { try { return JSON.parse(ENGINE.db.props[TKEY] || '[]'); } catch (e) { return []; } }
  function writeTriggers(list) { ENGINE.db.props[TKEY] = JSON.stringify(list); ENGINE.propsDirty = true; }
  function triggerObj(t) { return { getHandlerFunction: function () { return t.fn; }, getUniqueId: function () { return t.id; }, getEventType: function () { return 'CLOCK'; }, _t: t }; }
  G.ScriptApp = {
    getService: function () { return { getUrl: function () { return ENGINE.redirectUri; }, isEnabled: function () { return true; } }; },
    getProjectTriggers: function () { return readTriggers().map(triggerObj); },
    getUserTriggers: function () { return readTriggers().map(triggerObj); },
    newTrigger: function (fn) {
      var t = { id: newId('t'), fn: fn, everyMs: 3600000 };
      var tb = {
        everyHours: function (n) { t.everyMs = n * 3600000; return tb; }, everyMinutes: function (n) { t.everyMs = n * 60000; return tb; },
        everyDays: function (n) { t.everyMs = n * 86400000; return tb; }, everyWeeks: function (n) { t.everyMs = n * 604800000; return tb; },
        atHour: function () { return tb; }, nearMinute: function () { return tb; }, onWeekDay: function () { return tb; }, inTimezone: function () { return tb; }, after: function (ms) { t.everyMs = ms; t.once = true; return tb; },
        create: function () { var l = readTriggers(); l.push(t); writeTriggers(l); return triggerObj(t); }
      };
      return { timeBased: function () { return tb; } };
    },
    deleteTrigger: function (tr) { var id = tr && tr._t ? tr._t.id : tr; writeTriggers(readTriggers().filter(function (t) { return t.id !== id; })); },
    WeekDay: { MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6, SUNDAY: 7 },
    AuthMode: { FULL: 'FULL' }
  };
  function HtmlOutput(html) { this._h = String(html || ''); }
  ['setTitle', 'addMetaTag', 'setXFrameOptionsMode', 'setSandboxMode', 'setWidth', 'setHeight', 'setFaviconUrl'].forEach(function (k) { HtmlOutput.prototype[k] = function () { return this; }; });
  HtmlOutput.prototype.getContent = function () { return this._h; };
  HtmlOutput.prototype.append = function (s) { this._h += s; return this; };
  HtmlOutput.prototype.setContent = function (s) { this._h = s; return this; };
  G.HtmlService = {
    createHtmlOutput: function (h) { return new HtmlOutput(h); },
    createTemplateFromFile: function () { return { evaluate: function () { return new HtmlOutput(''); } }; },
    createTemplate: function (h) { return { evaluate: function () { return new HtmlOutput(h); } }; },
    createHtmlOutputFromFile: function () { return new HtmlOutput(''); },
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' }, SandboxMode: { IFRAME: 'IFRAME' }
  };
  G.ContentService = { createTextOutput: function (t) { return { _t: t, setMimeType: function () { return this; }, getContent: function () { return this._t; } }; }, MimeType: { JSON: 'JSON', TEXT: 'TEXT' } };
  G.Logger = { log: function () { var s = [].slice.call(arguments).join(' '); ENGINE.logs.push(s); if (ENGINE.logs.length > 200) ENGINE.logs.shift(); return G.Logger; }, getLog: function () { return ENGINE.logs.join('\n'); }, clear: function () { ENGINE.logs = []; } };
  G.MailApp = { sendEmail: function () { throw new Error('Kirim email tidak tersedia di aplikasi.'); }, getRemainingDailyQuota: function () { return 0; } };
  G.GmailApp = G.MailApp;
})(self);
