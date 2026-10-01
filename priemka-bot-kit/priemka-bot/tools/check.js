/**
 * Проверки перед доработками. Ничего не меняет ни на Диске, ни в боте — только читает.
 * Запуск — из папки бота, в командной строке от имени администратора:
 *
 *   node --env-file=.env tools\check.js link 6512028
 *       Взять временную ссылку на скачивание записи SCR#6512028 и сразу проверить её.
 *       Ссылка печатается — откройте её на телефоне через мобильный интернет (не Wi-Fi):
 *       так проверяется, работает ли она с другого компьютера и без входа в Яндекс.
 *
 *   node --env-file=.env tools\check.js recheck
 *       Проверить все ссылки, взятые раньше, и показать, сколько им времени и живы ли они.
 *       Запускайте через 1, 3, 6 и 24 часа после «link».
 *
 *   node --env-file=.env tools\check.js tree
 *       Сколько подпапок на каждом уровне дерева: самая «широкая» папка каждого уровня.
 *
 * Сами ссылки сохраняются в tools\link-check.json — после проверок файл можно удалить.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import * as disk from '../yandex-disk.js';
import { ROOT } from '../config.js';

const SAVE = new URL('./link-check.json', import.meta.url);
const load = () => { try { return JSON.parse(readFileSync(SAVE, 'utf8')); } catch { return []; } };
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
};

/** Живая ли ссылка: просим один байт, а не весь файл. */
async function probe(href) {
  try {
    const r = await fetch(href, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(30_000) });
    await r.body?.cancel();
    return { ok: r.status === 200 || r.status === 206, status: r.status };
  } catch (e) {
    return { ok: false, status: e.cause?.code || e.name };
  }
}

async function link(scr) {
  if (!/^\d{7}$/.test(scr || '')) throw new Error('Укажите номер SCR — семь цифр: tools\\check.js link 6512028');
  console.log(`Ищу SCR#${scr}…`);
  const found = (await disk.findFiles(`SCR#${scr}`)).filter((f) => !f.path.includes('/BackUp/'));
  if (!found.length) throw new Error(`Записи SCR#${scr} на Диске нет`);
  const f = found[0];
  const r = await fetch(
    `https://cloud-api.yandex.net/v1/disk/resources/download?path=${encodeURIComponent(f.path)}`,
    { headers: { Authorization: `OAuth ${process.env.YANDEX_DISK_TOKEN}` } },
  );
  const j = await r.json();
  if (!j.href) throw new Error(`Диск не дал ссылку: HTTP ${r.status} ${JSON.stringify(j)}`);

  const u = new URL(j.href);
  console.log(`\nФайл: ${f.path} (${(f.size / 1024 / 1024).toFixed(1)} МБ)`);
  console.log(`Узел: ${u.hostname}`);
  console.log(`Параметры ссылки: ${[...u.searchParams.keys()].join(', ')}`);
  for (const [k, v] of u.searchParams) {
    // Если в ссылке зашит срок — он обычно похож на метку времени в секундах.
    if (/^\d{10}$/.test(v)) console.log(`  ${k}=${v} → ${new Date(Number(v) * 1000).toLocaleString('ru-RU')} (похоже на срок действия)`);
  }
  const p = await probe(j.href);
  console.log(`Проверка сразу: ${p.ok ? 'РАБОТАЕТ' : 'НЕ работает'} (${p.status})`);

  const all = load();
  all.push({ scr, path: f.path, href: j.href, at: Date.now() });
  writeFileSync(SAVE, JSON.stringify(all, null, 2));
  console.log('\nСсылка (откройте на телефоне через мобильный интернет и в браузере без входа в Яндекс):');
  console.log(j.href);
  console.log('\nДальше: tools\\check.js recheck через 1, 3, 6 и 24 часа.');
}

async function recheck() {
  const all = load();
  if (!all.length) { console.log('Сохранённых ссылок нет — сначала tools\\check.js link <номер>'); return; }
  for (const x of all) {
    const p = await probe(x.href);
    console.log(`SCR#${x.scr}, взята ${ago(x.at)} назад: ${p.ok ? 'РАБОТАЕТ' : 'НЕ работает'} (${p.status})`);
  }
}

async function tree() {
  const levels = [];   // уровень → { max, where, total, folders }
  const visit = async (path, depth) => {
    if (depth > 8) return;
    const { dirs } = await disk.listFolder(path);
    const shown = dirs.filter((d) => d.name !== 'BackUp' && !d.name.startsWith('_'));
    const L = (levels[depth] ||= { max: 0, where: '', total: 0, folders: 0 });
    L.folders++; L.total += shown.length;
    if (shown.length > L.max) { L.max = shown.length; L.where = path.replace(/^disk:/, ''); }
    for (const d of shown) await visit(d.path, depth + 1);
  };
  console.log(`Читаю дерево /${ROOT}…`);
  await visit(disk.joinPath(ROOT), 0);
  levels.forEach((L, i) => {
    if (!L.total) return;
    console.log(`Уровень ${i + 1}: больше всего подпапок — ${L.max} (в «${L.where}»), ` +
      `в среднем ${(L.total / L.folders).toFixed(1)}`);
  });
}

const [cmd, arg] = process.argv.slice(2);
const run = { link: () => link(arg), recheck, tree }[cmd];
if (!run) {
  console.log('Команды: link <номер SCR> | recheck | tree');
} else {
  run().catch((e) => { console.error('Ошибка:', e.message); process.exitCode = 1; });
}
