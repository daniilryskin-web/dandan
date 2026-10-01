/**
 * Единый вид сообщений бота.
 *
 * Раньше каждое сообщение собиралось по месту, и одно и то же выглядело по-разному:
 * номер записи то первой строкой, то в конце, то вовсе без него. Теперь карточка записи,
 * заголовки шагов, кнопки и страницы собираются здесь — и выглядят одинаково везде.
 * Новые экраны берут готовые детали, а менять оформление — в одном месте.
 */

import { ROOT } from './config.js';

/* ---------- кнопки ---------- */

export const btn = (text, payload) => ({ type: 'callback', text, payload });
// Кнопки MAX идут строками: массив массивов. Каждая своя строка — так длинные
// названия папок не режутся пополам на узком экране телефона.
export const rows = (items) => items.map((b) => [b]);
export const HOME = () => btn('⬅️ В начало', 'cmd:menu');

/** Черта между «что и где» и вопросом к человеку: без неё всё сливается в простыню. */
export const RULE = '––––––––––––––––––––';

/* ---------- мелочи ---------- */

export const mb = (bytes) => `${(Number(bytes || 0) / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
export const cut = (text, n) => (String(text).length > n ? String(text).slice(0, n - 1) + '…' : String(text));
export function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('ru-RU') : '';
}

/* ---------- где лежит запись ---------- */

const FILE_EXT = /\.(mp4|mov|mkv|webm|avi|m4v|mpg|mpeg|new|csv|xlsx|json)$/i;

/* Человеку не нужен путь на Диске: ему нужно понимать, к какому контракту и периоду
 * относится запись. Корневую папку не показываем — она всегда одна и та же.
 * Префикс «Код-направления » режем: в отчёте это лишний шум. */
export function parts(pathOrSegments) {
  const seg = Array.isArray(pathOrSegments)
    ? pathOrSegments.slice()
    : String(pathOrSegments).replace(/^disk:/i, '').split('/').filter(Boolean);
  if (seg[0] === ROOT) seg.shift();
  /* Последний сегмент — имя файла, только если это похоже на запись или известный формат.
   * Раньше файлом считалось всё «с точкой на конце», и папка «ОП 01.2026» пропадала из отчёта. */
  const last = seg[seg.length - 1] || '';
  if (!Array.isArray(pathOrSegments) && (/^SCR#/i.test(last) || FILE_EXT.test(last))) seg.pop();
  const [gk, op, napr, sys] = seg;
  return {
    gk: gk || null,
    op: op || null,
    napr: napr ? napr.replace(/^Код[-\s]?направлени[яй]\s*/i, '') : null,
    sys: sys || null,
  };
}

const placeLines = (p) => [
  p.gk && `ГК: ${p.gk}`, p.op && `ОП: ${p.op}`, p.napr && `Направление: ${p.napr}`, p.sys && `Система: ${p.sys}`,
].filter(Boolean);

/** Многострочный отчёт: только заполненные поля. */
export function report(src, { scr = null, size = null } = {}) {
  const lines = [];
  if (scr) lines.push(`Номер: SCR#${scr}`);
  lines.push(...placeLines(parts(src)));
  if (size != null) lines.push(`Размер: ${mb(size)}`);
  return lines.join('\n');
}

/** Однострочный вариант — для подписей, кнопок и журнала. */
export const reportInline = (src) => placeLines(parts(src)).join(' · ');

/** Короткая цепочка выбранных папок: «ГК-1 → ОП-3 → 01 → Система А». */
export function crumbs(segments) {
  const p = parts(segments);
  return [p.gk, p.op, p.napr, p.sys].filter(Boolean).join(' → ');
}

/* ---------- карточки ---------- */

/**
 * Карточка записи — одинаковая везде: после загрузки, при поиске, в обзоре, в архиве.
 *   ✅ Видеозапись загружена
 *
 *   Номер: SCR#6512028
 *   ГК: … / ОП: … / Направление: … / Система: …
 *   Размер: 120,5 МБ · загружена 12.09.2026
 *   💬 комментарий
 *   ––––
 *   примечания
 */
export function card({ title = '', scr = null, path = null, size = null, created = null, comment = null, notes = [] }) {
  const out = [];
  if (title) out.push(title, '');
  if (scr) out.push(`Номер: SCR#${scr}`);
  if (path) out.push(...placeLines(parts(path)));
  const meta = [size != null && mb(size), created && `загружена ${fmtDate(created)}`].filter(Boolean).join(' · ');
  if (meta) out.push(`Размер: ${meta}`);
  if (comment?.text) out.push(`💬 ${comment.text}`);
  const tail = notes.filter(Boolean);
  if (tail.length) out.push(RULE, ...tail);
  return out.join('\n').replace(/\n+$/, '');
}

/** Сообщение о сбое: что не получилось и что делать. */
export const trouble = (what, why) => `⚠️ ${what}\n\n${why}`;

/* ---------- шаги ---------- */

/** «📤 Загрузка · шаг 2 из 6» — человек видит, где он и сколько осталось. */
export function stepTitle(label, step, total) {
  if (!step) return label;
  return total ? `${label} · шаг ${step} из ${total}` : `${label} · шаг ${step}`;
}

/* ---------- страницы ---------- */

export const PAGE_SIZE = 10;

/**
 * Кусок списка для текущей страницы и строка переключения.
 * Отчётные периоды копятся каждый месяц, и экран с двадцатью кнопками на телефоне —
 * долгая прокрутка; кроме того, у MAX есть предел кнопок в одном сообщении.
 */
export function paginate(items, page = 0, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const slice = items.slice(p * size, (p + 1) * size);
  const nav = pages > 1
    ? [[btn(p > 0 ? '◀ Назад' : '·', p > 0 ? 'pg:prev' : 'pg:noop'),
        btn(`${p + 1} / ${pages}`, 'pg:noop'),
        btn(p < pages - 1 ? 'Дальше ▶' : '·', p < pages - 1 ? 'pg:next' : 'pg:noop')]]
    : [];
  return { slice, page: p, pages, nav };
}
