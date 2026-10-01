// Menyusun catatan rilis dari pesan commit terakhir.
// Format pesan commit (opsional):
//   Judul singkat
//
//   Untuk pengguna:
//   - fitur yang terlihat pengguna
//
//   Untuk developer:
//   - catatan teknis (hanya terlihat oleh admin di aplikasi)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
const msg = execSync('git log -1 --pretty=format:%B').toString().replace(/[ \t]*\[(no-)?maintenance\][ \t]*/gi, ' ').replace(/ +$/gm, '');
const lines = msg.split('\n').filter((l) => !/^(Co-Authored-By|Claude-Session):/i.test(l.trim()));
let title = (lines.shift() || '').trim(), mode = 'user';
const user = [], dev = [];
for (const raw of lines) {
  const l = raw.trimEnd();
  if (/^untuk pengguna\s*:?$/i.test(l.trim())) { mode = 'user'; continue; }
  if (/^untuk developer\s*:?$/i.test(l.trim())) { mode = 'dev'; continue; }
  (mode === 'dev' ? dev : user).push(l);
}
const clean = (a) => a.join('\n').replace(/\n{3,}/g, '\n\n').trim();
let out = '## Yang baru\n' + (title ? title + '\n\n' : '') + clean(user);
if (clean(dev)) out += '\n\n## Catatan developer\n' + clean(dev);
out += '\n\nUnduh file .apk di bawah dari HP lalu pasang menimpa versi lama.\n';
fs.writeFileSync('release-notes.md', out);
console.log(out);
