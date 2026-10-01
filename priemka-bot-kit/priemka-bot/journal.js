/**
 * Журнал действий — на Яндекс.Диске, а не на машине бота.
 *
 * Почему там: машина бота может смениться, а вместе с ней уехала бы вся история.
 * Диск переживает любой переезд, доступен админам через обычный веб-интерфейс
 * и лежит рядом с самими записями.
 *
 * Почему CSV, а не txt: открывается двойным кликом в Excel, фильтруется и сортируется.
 * Разделитель «;» — русская локаль Excel понимает именно его, с запятой всё съедет в один столбец.
 * BOM в начале файла — без него Excel читает UTF-8 как cp1251 и кириллица превращается в кракозябры.
 *
 * Пишем ТОЛЬКО конечные действия (решение Эмиля 07.09.2026): загрузка, замена, перемещение,
 * выдача и отзыв доступа. Просмотры и поиски не пишем — они ничего не меняют.
 */

import * as disk from './yandex-disk.js';
import { ROOT } from './config.js';
import { writeXlsx } from './xlsx.js';

const FOLDER = [ROOT, '_Журнал'];
const HEADER = ['Дата', 'Время', 'Кто (номер)', 'Кто (имя)', 'Действие', 'SCR', 'Где', 'Результат'];
const BOM = '\uFEFF';

/** Экранирование по правилам CSV: кавычки удваиваются, поле с «;» или переводом строки берётся в кавычки. */
function cell(v) {
  const s = String(v ?? '').replace(/\r?\n/g, ' ').trim();
  return /[;"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function monthFile(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.csv`;
}

// Очередь записи: два человека могут действовать одновременно, а Диск не умеет дописывать
// в файл — приходится читать, склеивать и класть обратно. Без очереди одна запись затрёт другую.
let chain = Promise.resolve();

/**
 * @param {object} e
 * @param {number} e.userId  кто действовал
 * @param {string} e.name    имя, как знаем
 * @param {string} e.action  что сделал, по-русски
 * @param {string} [e.scr]   номер записи
 * @param {string} [e.where] путь или адресат
 * @param {string} [e.result] чем кончилось
 */
/** Дождаться, пока все поставленные в очередь строки журнала записаны (для автотестов). */
export const flushed = () => chain;

export function log(e) {
  chain = chain.then(() => write(e)).catch((err) => {
    // Журнал не должен ронять работу бота: не смогли записать — жалуемся в консоль и живём дальше.
    console.error('   журнал не записан:', err.message);
  });
  return chain;
}

async function write(e, attempt = 0) {
  const now = new Date();
  const path = disk.joinPath(...FOLDER, monthFile(now));

  const row = [
    now.toLocaleDateString('ru-RU'),
    now.toLocaleTimeString('ru-RU'),
    e.userId ?? '',
    e.name ?? '',
    e.action ?? '',
    e.scr ? `SCR#${e.scr}` : '',
    e.where ?? '',
    e.result ?? 'успешно',
  ].map(cell).join(';');

  // Файл месяца создаём при ПЕРВОЙ записи, а не по расписанию: иначе первого числа
  // бот упрётся в отсутствующий файл.
  const prev = await readFile(path);

  // BOM приходится ставить заново на каждой записи: Response.text() по спецификации
  // срезает его при чтении, поэтому в prev его уже нет, и без этой строки Excel
  // прочитает файл как cp1251 и покажет кракозябры вместо кириллицы.
  const head = prev ? '' : HEADER.map(cell).join(';') + '\r\n';
  const body = BOM + (prev ? prev.replace(/^\uFEFF/, '').replace(/\s*$/, '') + '\r\n' : head) + row + '\r\n';

  await disk.ensureFolder(disk.joinPath(...FOLDER));
  await disk.uploadBuffer(Buffer.from(body, 'utf8'), path, { overwrite: true });

  /* Условной записи (ETag / If-Match) Диск НЕ поддерживает — замерено 07.09.2026:
   * заголовка ETag в ответе нет, а If-Match молча игнорируется, файл перезаписывается.
   * Поэтому защититься от гонки нельзя, можно только заметить её и переписать строку.
   * Реальный случай ровно один: два экземпляра бота работают одновременно
   * (например, при перезапуске старый ещё не умер). Внутри процесса спасает очередь. */
  if (attempt < 2) {
    let check = null;
    try { check = await readFile(path); } catch {}
    if (check !== null && !check.includes(row)) {
      console.error('   журнал: запись затёрлась параллельной, повторяю');
      return write(e, attempt + 1);
    }
  }
}

// Чтение — disk.readText: пустая строка только при «файла нет», любой другой сбой — исключение.
const readFile = (path) => disk.readText(path);

/** Выгрузка людей списком — Excel-таблица с фильтрами; на Диске не хранится. */
export function exportPeople(access, roles, nameOf = (id) => String(id)) {
  const now = new Date();
  const rows = access.map((a) => [
    a.name || '',
    a.id,
    (roles[a.role] || {}).title || a.role || '',
    a.addedBy ? nameOf(a.addedBy) : '',
    a.addedAt || '',
  ]);
  const buffer = writeXlsx([{ name: 'Доступ', header: ['Имя', 'Номер', 'Роль', 'Кем добавлен', 'Когда добавлен'], rows }]);
  return { buffer, name: `Доступ на ${now.toLocaleDateString('ru-RU').replace(/\./g, '-')}.xlsx` };
}

/* Чтение журнала обратно в строки — для утренней сводки и «последних действий». */

/** Разбор CSV ровно в том виде, в каком его пишет cell(): «;», кавычки удваиваются. */
export function parseCsv(text) {
  const out = [];
  let row = [], field = '', quoted = false;
  const src = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ';') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) out.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((f) => f !== '')) out.push(row); }
  return out;
}

/** Строки журнала за месяц «2026-09» — объектами { Дата, Время, …, Результат }. Нет файла — []. */
export async function readMonth(ym) {
  const text = await readFile(monthPath(ym));
  const [head, ...rows] = parseCsv(text);
  if (!head) return [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/** Журнал месяца — Excel-таблицей: жирная шапка, фильтры, закреплённая первая строка. */
export async function monthXlsx(ym) {
  const text = await readFile(monthPath(ym));
  const [head, ...rows] = parseCsv(text);
  if (!head) throw new Error(`журнал за ${ym} пуст`);
  return writeXlsx([{ name: `Журнал ${ym}`, header: head, rows }]);
}

/** Путь к журналу месяца «2026-09» — бот выдаёт его администратору файлом. */
export const monthPath = (ym) => disk.joinPath(...FOLDER, `${ym}.csv`);

/** Какие месяцы уже есть в журнале — для выбора при выгрузке. */
export async function months() {
  try {
    const { files } = await disk.listFolder(disk.joinPath(...FOLDER));
    return files
      .filter((f) => /^\d{4}-\d{2}\.csv$/.test(f.name))
      .map((f) => ({ name: f.name, path: f.path, size: f.size, ym: f.name.slice(0, 7) }))
      .sort((a, b) => b.ym.localeCompare(a.ym));   // свежие сверху
  } catch { return []; }
}

/** Человеческое имя месяца: «2026-09» → «сентябрь 2026». */
const MONTH_NAMES = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
export function monthTitle(ym) {
  const [y, m] = ym.split('-');
  return `${MONTH_NAMES[Number(m) - 1] || m} ${y}`;
}
