// Imports Pokémon images from a locally unpacked archive (for example the Kaggle
// "The Complete Pokemon Images Data Set") into public/sprites/, which is ignored by git.
//
// Usage: npm run import-sprites -- <path-to-unpacked-archive>
//
// Images are matched to species by folder or file name ("Bulbasaur/…", "bulbasaur.png",
// "001-bulbasaur.jpg") or by Pokédex number ("1.png", "001.png"). Names come from
// data-src/pokemon-gen9.csv, so all 1025 species are recognised.
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src || !existsSync(src)) {
  console.error('Укажите путь к распакованному архиву: npm run import-sprites -- <папка>');
  process.exit(1);
}

const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/♀/g, 'f').replace(/♂/g, 'm').replace(/[^a-z0-9]/g, '');

// name -> id for every species (data-src/pokemon-gen9.csv: all 1025, first row per number is the default form).
const csv = readFileSync(join(root, 'data-src/pokemon-gen9.csv'), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
const byName = new Map();
let maxId = 0;
for (const line of csv.slice(1)) {
  const [no, name] = line.split(',');
  const id = Number(no);
  maxId = Math.max(maxId, id);
  if (![...byName.values()].includes(id)) byName.set(norm(name), id);
}
// Common spelling variants in image archives.
const aliases = { nidoranfemale: 29, nidoranmale: 32, nidoran: 29, mrmime: 122, farfetchd: 83, flabebe: 669 };
for (const [k, v] of Object.entries(aliases)) if (!byName.has(k)) byName.set(k, v);

const EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const BAD = /(shiny|back|mega|gmax|gigantamax|alola|galar|hisui|female|cosplay|fanart|drawing|icon|card)/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.has(extname(name).toLowerCase())) out.push(p);
  }
  return out;
}

function pngInfo(file) {
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(33);
  readSync(fd, buf, 0, 33, 0);
  closeSync(fd);
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), alpha: buf[25] === 6 || buf[25] === 4 };
}

function matchId(file) {
  const base = basename(file, extname(file));
  const folder = basename(dirname(file));
  const nb = norm(base);
  if (byName.has(nb)) return { id: byName.get(nb), exact: true };
  // Folder-per-species archives ("Bulbasaur/00000001.png"): the folder decides.
  const nf = norm(folder);
  if (byName.has(nf)) return { id: byName.get(nf), exact: false };
  // Short Pokédex numbers only: "1", "025", "0025", "001-bulbasaur".
  const num = base.match(/^(\d{1,4})(?:[^\d]|$)/);
  if (num && Number(num[1]) >= 1 && Number(num[1]) <= maxId) return { id: Number(num[1]), exact: num[1].length === base.length };
  const word = base.split(/[^A-Za-z]+/).map(norm).find((w) => byName.has(w));
  if (word) return { id: byName.get(word), exact: false };
  return null;
}

const best = new Map();
let scanned = 0;
for (const file of walk(resolve(src))) {
  scanned++;
  const m = matchId(file);
  if (!m) continue;
  const ext = extname(file).toLowerCase();
  const info = ext === '.png' ? pngInfo(file) : null;
  let score = 0;
  if (m.exact) score += 4;
  if (ext === '.png') score += 2;
  if (info?.alpha) score += 4;
  if (info && Math.min(info.width, info.height) >= 96) score += 1;
  if (BAD.test(basename(file))) score -= 20;
  const prev = best.get(m.id);
  if (!prev || score > prev.score || (score === prev.score && file < prev.file)) best.set(m.id, { file, score, ext });
}

const out = join(root, 'public/sprites');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const manifest = {};
for (const [id, { file, ext }] of [...best.entries()].sort((a, b) => a[0] - b[0])) {
  const name = `${id}${ext === '.jpeg' ? '.jpg' : ext}`;
  copyFileSync(file, join(out, name));
  manifest[id] = name;
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 0));

const gameIds = [...readFileSync(join(root, 'src/data/species.ts'), 'utf8').matchAll(/\{ id: (\d+), name: '/g)].map((m) => Number(m[1]));
const missing = gameIds.filter((id) => !manifest[id]).sort((a, b) => a - b);
console.log(`Просмотрено файлов: ${scanned}. Сопоставлено видов: ${Object.keys(manifest).length}.`);
console.log(`Покемоны игры с картинкой: ${gameIds.length - missing.length} из ${gameIds.length}.`);
if (missing.length) console.log(`Без картинки (будет 3D-модель): ${missing.join(', ')}`);
console.log(`Картинки сохранены в ${out} (папка не попадает в git).`);
