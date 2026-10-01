// Menentukan nomor versi rilis (semver MAJOR.MINOR.PATCH).
// - package.json "version" = versi dasar. Fitur besar → naikkan MINOR di package.json (mis. 1.2.0 → 1.3.0).
// - Bila versi dasar sudah pernah dirilis (atau lebih rendah dari rilis terakhir), PATCH dinaikkan otomatis
//   dari tag tertinggi, jadi perbaikan kecil cukup commit biasa (1.2.0 → 1.2.1 → 1.2.2 …).
// Output: baris APP_VERSION=x.y.z (ditulis ke $GITHUB_ENV / $GITHUB_OUTPUT bila ada).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const parse = (v) => { const m = String(v).replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)$/); return m ? [+m[1], +m[2], +m[3]] : null; };
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

let tags = [];
try {
  const out = execSync('git ls-remote --tags origin "v*"', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  tags = out.split('\n').map((l) => (l.split('refs/tags/')[1] || '').replace(/\^\{\}$/, '')).map(parse).filter(Boolean);
} catch { /* tanpa remote: pakai tag lokal */ }
if (!tags.length) { try { tags = execSync('git tag -l "v*"', { cwd: ROOT }).toString().split('\n').map(parse).filter(Boolean); } catch { /* abaikan */ } }

const base = parse(pkg.version);
if (!base) { console.error('package.json version harus berbentuk x.y.z'); process.exit(1); }
const max = tags.sort(cmp).pop();
const ver = !max || cmp(base, max) > 0 ? base : [max[0], max[1], max[2] + 1];
const v = ver.join('.');
console.log('APP_VERSION=' + v + (max ? '  (rilis terakhir v' + max.join('.') + ', dasar ' + pkg.version + ')' : ''));
for (const f of [process.env.GITHUB_ENV, process.env.GITHUB_OUTPUT]) if (f) fs.appendFileSync(f, (f === process.env.GITHUB_ENV ? 'APP_VERSION=' : 'version=') + v + '\n');
