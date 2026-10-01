/**
 * Бот «Показы работ по контрактам ИЭП»: видеозаписи из MAX на Яндекс.Диск и обратно.
 *
 * Запуск:  node --env-file=.env bot.js
 *
 * Четыре команды:
 *   1. Загрузить    — опросник по папкам Диска → номер SCR → приложить запись
 *   2. Найти        — номер SCR → бот присылает саму запись файлом
 *   3. Заменить     — номер SCR → новая запись; старая уезжает в BackUp
 *   4. Переместить  — номер SCR → опросник по папкам → перенос
 *
 * Почему опросник читает папки с Диска, а не знает их наизусть: структура ещё меняется,
 * и любое переименование на Диске не должно требовать правки кода. По той же причине
 * бот спускается вглубь, пока в папке есть подпапки, — число уровней нигде не зашито.
 */

import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as disk from './yandex-disk.js';
import { sendFileFromUrl, sendBuffer, SendError } from './max-upload.js';
import * as journal from './journal.js';
import * as meta from './meta.js';
import { writeXlsx, readXlsxCells } from './xlsx.js';
import {
  btn, rows, HOME, RULE, mb, cut, fmtDate, parts, report, reportInline, crumbs, card, trouble,
  stepTitle, paginate,
} from './ui.js';
import {
  ROOT, ADMINS, YANDEX_TOKEN_ISSUED, YANDEX_TOKEN_DAYS, LOW_SPACE_BYTES, BOT_DIR, dataFile,
} from './config.js';

const API = 'https://platform-api2.max.ru';
const BACKUP = 'BackUp';
const SCR_DIGITS = 7;                    // «SCR#6512028» — решение Эмиля, проверяем строго
const STATE_TTL_MS = 30 * 60_000;        // получас на диалог, потом всё забываем
const POLL_TIMEOUT_SEC = 30;

/* Кто управляет доступом — ADMINS из config.js: берётся из .env (ADMINS=…), а если там
 * пусто — основной администратор, записанный в config.js. Отдельно от access.json намеренно:
 * если положить админов в тот же файл, что и обычных пользователей, любой админ сможет
 * случайно разжаловать всех остальных, включая себя. */

/* Роли. Проверяем не «кто ты», а «что тебе можно» — так добавить четвёртую роль
 * будет правкой одной таблицы, а не поиском проверок по всему файлу. */
const ROLES = {
  admin:  { title: 'Администратор',        desc: 'всё, включая доступ, удаление и отчёты',
    can: ['find', 'upload', 'replace', 'move', 'browse', 'comment', 'versions', 'delete', 'admin'] },
  editor: { title: 'Руководитель проекта', desc: 'загрузка, замена, перенос, обзор, версии',
    can: ['find', 'upload', 'replace', 'move', 'browse', 'comment', 'versions'] },
  // Гостю — только поиск по номеру: обзор показал бы всю структуру контрактов.
  viewer: { title: 'Гость',                desc: 'только поиск записи по номеру',
    can: ['find'] },
};
const DEFAULT_ROLE = 'editor';

function roleOf(userId) {
  if (ADMINS.includes(userId)) return 'admin';           // список в коде — страховка от «разжаловали всех»
  const u = access.find((a) => a.id === userId);
  return (u && ROLES[u.role]) ? u.role : DEFAULT_ROLE;
}
function can(userId, what) {
  return ROLES[roleOf(userId)].can.includes(what);
}

/* А вот список допущенных живёт в ФАЙЛЕ: людей добавляют часто, и каждый раз править
 * код и перезапускать бота — плохой способ. Кого нет ни в файле, ни в ADMINS, бот не пускает:
 * пропавший или повреждённый файл не должен открывать доступ всем подряд. */
const ACCESS_FILE = dataFile('access.json');

function loadAccess() {
  let text;
  try { text = readFileSync(ACCESS_FILE, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') { console.error('access.json не найден: пускаю только администраторов из кода'); return []; }
    throw e;
  }
  try {
    const j = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (Array.isArray(j.allowed)) return j.allowed;
  } catch {}
  // Откладываем, а не затираем: первая же выдача доступа иначе перезаписала бы файл.
  try { renameSync(ACCESS_FILE, dataFile('access.json.broken')); } catch {}
  console.error('access.json повреждён и отложен в access.json.broken: пускаю только администраторов из кода');
  return [];
}
/* Через временный файл и переименование: оборванная запись не оставит полфайла. На Windows
 * антивирус иногда держит файл долю секунды, поэтому несколько попыток. */
function saveAccess(list) {
  const tmp = dataFile('access.json.tmp');
  for (let i = 0; ; i++) {
    try {
      writeFileSync(tmp, JSON.stringify({ allowed: list }, null, 2));
      renameSync(tmp, ACCESS_FILE);
      return true;
    } catch (e) {
      if (i === 4) { console.error('не смог сохранить access.json:', e.message); return false; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}
let access = loadAccess();

/* Состояние диалогов В ФАЙЛЕ, а не только в памяти.
 *
 * Зачем: перезапуск бота (а он случается при каждом обновлении) обнулял ВСЁ —
 * ссылку на текущий экран, шаг опросника, выбранные папки, ключи кнопок.
 * Снаружи это выглядело как пять разных багов подряд: «бот молчит», «меню шлёт новое
 * сообщение», «кнопка журнала не работает», «старые кнопки мертвы». Причина была одна.
 * Замерено и поймано 07.09.2026.
 *
 * Пишем после обработки каждого события — их единицы в минуту, файл крошечный. */
const STATE_FILE = dataFile('state.json');

function loadState() {
  try {
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const fresh = Date.now() - STATE_TTL_MS;
    const ss = new Map();
    for (const [k, v] of Object.entries(j.sessions || {})) {
      if ((v.touched || 0) > fresh) ss.set(Number(k), v);   // протухшие не поднимаем
    }
    return {
      sessions: ss,
      lastUser: new Map(Object.entries(j.lastUser || {}).map(([k, v]) => [Number(k), v])),
      choices: new Map(Object.entries(j.choices || {})),
      choiceSeq: j.choiceSeq || 0,
      // Новые поля — только добавляются: старая версия бота их просто не заметит.
      adminChats: new Map(Object.entries(j.adminChats || {}).map(([k, v]) => [Number(k), v])),
      alerts: new Map(Object.entries(j.alerts || {})),
      starts: Array.isArray(j.starts) ? j.starts : [],
      plannedRestart: !!j.plannedRestart,
      lastPaths: new Map(Object.entries(j.lastPaths || {}).map(([k, v]) => [Number(k), v])),
      requests: new Map(Object.entries(j.requests || {}).map(([k, v]) => [Number(k), v])),
      lastSummary: j.lastSummary || null,
    };
  } catch {
    return {
      sessions: new Map(), lastUser: new Map(), choices: new Map(), choiceSeq: 0,
      adminChats: new Map(), alerts: new Map(), starts: [], plannedRestart: false,
      lastPaths: new Map(), requests: new Map(), lastSummary: null,
    };
  }
}

function writeState(extra = {}) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({
      sessions: Object.fromEntries(sessions),
      lastUser: Object.fromEntries(lastUser),
      choices: Object.fromEntries(choices),
      choiceSeq,
      adminChats: Object.fromEntries(adminChats),
      alerts: Object.fromEntries(alerts),
      starts,
      lastPaths: Object.fromEntries(lastPaths),
      requests: Object.fromEntries(requests),
      lastSummary,
      ...extra,
    }));
  } catch (e) { console.error('не смог сохранить состояние:', e.message); }
}

let saveTimer = null;
function saveState() {
  // не чаще раза в секунду: событий бывает несколько подряд, писать на каждое незачем
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeState(); }, 1000);
  saveTimer.unref?.();
}

const restored = loadState();
const sessions = restored.sessions;
const adminChats = restored.adminChats;   // администратор → его чат с ботом, туда идут оповещения
const alerts = restored.alerts;           // ключ оповещения → когда отправляли (не чаще раза в час)
const starts = restored.starts;           // моменты запусков: частые — значит, бот падает
const lastPaths = restored.lastPaths;     // человек → папка последней загрузки («В прошлую папку»)
const requests = restored.requests;       // заявки на доступ: кто, когда, чем кончилось
let lastSummary = restored.lastSummary;   // дата последней утренней сводки

function session(chatId) {
  const now = Date.now();
  let s = sessions.get(chatId);
  if (s && now - s.touched > STATE_TTL_MS) { sessions.delete(chatId); s = null; }
  if (!s) { s = { cmd: null, step: null, path: [], scr: null, found: null, touched: now }; sessions.set(chatId, s); }
  s.touched = now;
  return s;
}
function reset(chatId) {
  // mid сохраняем: следующий экран перепишет то же сообщение, а не заведёт новое
  const mid = sessions.get(chatId)?.mid ?? null;
  sessions.delete(chatId);
  if (mid) sessions.set(chatId, { cmd: null, step: null, path: [], scr: null, found: null, mid, touched: Date.now() });
}

// Кнопки не могут нести длинный путь — в payload кладём короткий ключ, а сам путь держим здесь.
const choices = restored.choices;
let choiceSeq = restored.choiceSeq;
function keyFor(value) {
  const k = 'c' + (++choiceSeq).toString(36);
  choices.set(k, value);
  if (choices.size > 5000) for (const old of [...choices.keys()].slice(0, 2000)) choices.delete(old);
  return k;
}


function maxToken() {
  const t = process.env.MAX_TOKEN;
  if (!t) throw new Error('Не задан MAX_TOKEN');
  return t;
}

async function api(method, path, { query = {}, body = null } = {}) {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  const res = await fetch(`${API}${path}${qs ? '?' + qs : ''}`, {
    method,
    headers: { Authorization: maxToken(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(`MAX ${method} ${path}: HTTP ${res.status} ${String(text).slice(0, 200)}`);
  return json;
}

/**
 * Отдельное сообщение — оно всегда приходит вниз чата.
 *
 * И оно ОБЯЗАНО сбросить экран опросника. Иначе получается ловушка, которую поймал
 * Эмиль 07.09.2026: человек ввёл номер неверно, ошибка пришла вниз, он ввёл заново —
 * а бот отредактировал экран НАВЕРХУ, куда человек уже не смотрит. Выглядит как «бот молчит».
 * Сбрасывая mid, мы заставляем следующий шаг прийти новым сообщением — туда, где взгляд.
 */
async function say(chatId, text, buttons = null) {
  const res = await api('POST', '/messages', {
    query: { chat_id: chatId },
    body: {
      text,
      attachments: buttons ? [{ type: 'inline_keyboard', payload: { buttons } }] : null,
      notify: true,
    },
  });
  const s = sessions.get(chatId);
  if (s) s.mid = null;
  return res;
}

/**
 * Экран опросника — ОДНО сообщение, которое переписывается на каждом шаге.
 * Замерено 07.09.2026: PUT /messages?message_id=… отвечает {"success":true},
 * то есть править своё сообщение можно. Так чат не засоряется десятком карточек,
 * и человек видит текущий шаг там же, где смотрел предыдущий.
 * Если правка не удалась (сообщение удалили, mid протух) — молча шлём новое.
 */
async function screen(chatId, text, buttons = null) {
  /* Именно session(), а не sessions.get(): после reset() сессии нет, и раньше ссылка
   * на отправленный экран просто терялась — «if (mid && s)» не срабатывал. Из-за этого
   * КАЖДЫЙ следующий экран приходил новым сообщением вместо правки текущего.
   * Поймано на живом 07.09.2026 по строке «mid нет — шлю новое (сессия НЕТ)». */
  const s = session(chatId);
  const body = {
    text,
    attachments: buttons ? [{ type: 'inline_keyboard', payload: { buttons } }] : null,
  };
  if (s?.mid) {
    try {
      await api('PUT', '/messages', { query: { message_id: s.mid }, body });
      return;
    } catch { /* сообщение удалили или mid протух — упадём на отправку нового */ }
  }
  const res = await api('POST', '/messages', { query: { chat_id: chatId }, body: { ...body, notify: true } });
  const mid = res?.message?.body?.mid;
  if (mid && s) s.mid = mid;
}

/** Убрать одно своё сообщение. Точечно, а не «почистить весь чат»: экран, который
 *  сейчас заменится файлом, после отправки становится мусором и только мешает.
 *  Чужие сообщения удалить нельзя — MAX отдаёт 403. */
async function drop(chatId, mid) {
  if (!mid) return;
  try { await api('DELETE', '/messages', { query: { message_id: mid } }); } catch { /* уже нет */ }
  const sess = sessions.get(chatId);
  if (sess && sess.mid === mid) sess.mid = null;   // иначе следующая правка уйдёт в пустоту
}


/* Оповещения администратору.
 * Раньше о сбоях знали только из bot.log — то есть узнавали от пользователей. Теперь бот
 * сам пишет основным администраторам в их чат с ботом (чат запоминается, когда админ
 * хоть раз написал боту). Одно и то же оповещение — не чаще раза в час, и время отправки
 * хранится в state.json: при падении в цикле перезапусков бот не засыплет чат.
 * Сбой отправки оповещения ни на что не влияет: он только попадает в журнал работы. */
const ALERT_EVERY_MS = 60 * 60_000;

async function notifyAdmins(key, text, { every = ALERT_EVERY_MS } = {}) {
  const last = Number(alerts.get(key) || 0);
  if (Date.now() - last < every) return;
  alerts.set(key, Date.now());
  saveState();
  console.log(`   оповещение [${key}]: ${text.split('\n')[0]}`);
  for (const id of ADMINS) {
    const chatId = adminChats.get(id);
    if (!chatId) continue;
    try { await say(chatId, text); }
    catch (e) { console.error(`   оповещение администратору ${id} не ушло:`, e.message); }
  }
}

/* Очереди и замки.
 *
 * Раньше события разбирались строго по одному: пока Диск полчаса принимал чужое видео,
 * бот не отвечал НИКОМУ. Теперь у каждого чата своя очередь: внутри чата — по порядку,
 * как и прежде (иначе нажатия одного человека перепутались бы), а разные чаты друг друга
 * не ждут. Выдач записи в чат одновременно — не больше HEAVY_MAX: только при выдаче байты
 * видео идут через компьютер бота, и ноутбук с домашним интернетом не должен захлебнуться.
 * (При загрузке Диск качает файл с серверов MAX сам — через бота байты не идут.) */
const chatQueues = new Map();   // chatId → хвост очереди

function enqueue(chatId, fn) {
  const key = chatId ?? 'none';
  const prev = chatQueues.get(key) ?? Promise.resolve();
  const run = prev.then(fn).catch((e) => console.error('   ошибка обработки:', e?.message || e));
  chatQueues.set(key, run);
  run.finally(() => { if (chatQueues.get(key) === run) chatQueues.delete(key); });
  return run;
}

const HEAVY_MAX = 3;
let heavyNow = 0;
const heavyWait = [];
async function heavy(fn) {
  // Освободившееся место передаётся ожидающему напрямую, иначе в щель между «освободил»
  // и «ожидающий проснулся» мог бы проскочить четвёртый.
  if (heavyNow >= HEAVY_MAX) await new Promise((r) => heavyWait.push(r));
  else heavyNow++;
  try { return await fn(); }
  finally { const next = heavyWait.shift(); if (next) next(); else heavyNow--; }
}

/* Замок на номер записи. Пока события шли по одному, два человека физически не могли
 * менять одну запись одновременно. Теперь могут — и замок возвращает эту гарантию:
 * второй получает «запись сейчас занята», а не гонку на Диске. */
const scrBusy = new Map();   // scr → что с ней делают
const scrLock = (scr, what) => { if (scrBusy.has(scr)) return false; scrBusy.set(scr, what); return true; };
const scrUnlock = (scr) => scrBusy.delete(scr);
const busyText = (scr) =>
  `С записью SCR#${scr} сейчас идёт другое действие (${scrBusy.get(scr)}). Попробуйте через пару минут.`;


/** Меню собирается под права: человек не видит того, чего ему нельзя. */
function menuFor(userId) {
  const m = [];
  if (can(userId, 'upload'))  m.push(btn('📤 Загрузить видеозапись', 'cmd:upload'));
  m.push(btn('🔍 Найти по номеру SCR', 'cmd:find'));
  if (can(userId, 'browse'))  m.push(btn('📂 Обзор записей', 'cmd:browse'));
  if (can(userId, 'replace')) m.push(btn('♻️ Заменить видеозапись', 'cmd:replace'));
  if (can(userId, 'move'))    m.push(btn('📁 Переместить видеозапись', 'cmd:move'));
  if (can(userId, 'admin'))   m.push(btn('⚙️ Администрирование', 'adm:menu'));
  return m;
}

const showMenu = (chatId, prefix = '', userId = null) =>
  screen(chatId, (prefix ? prefix + '\n\n' : '') + 'Выберите действие', rows(menuFor(userId ?? lastUser.get(chatId))));

/* Кто в этом чате: меню строится по правам, а рисовать его иногда приходится там,
 * где userId под рукой нет (например, после ошибки). */
const lastUser = restored.lastUser;

/** Служебные папки в опроснике не показываем: BackUp — архив версий, а всё,
 *  что начинается с подчёркивания (_Журнал, _Служебное), — наши потроха. */
const visibleDirs = (listing) => listing.dirs.filter((d) => d.name !== BACKUP && !d.name.startsWith('_'));

/** Сколько ещё уровней под папкой — по кэшу. null, если часть дерева не прочитана. */
function depthBelow(folder, guard = 0) {
  const hit = folderCache.get(ckey(folder));
  if (!hit || guard > 10) return null;
  const dirs = visibleDirs(hit.listing);
  if (!dirs.length) return 0;
  let max = 0;
  for (const d of dirs) {
    const n = depthBelow(d.path, guard + 1);
    if (n === null) return null;
    max = Math.max(max, n + 1);
  }
  return max;
}

const FLOW = {
  upload:  { label: '📤 Загрузка',     ask: 'Куда сохранить запись?' },
  move:    { label: '📁 Перенос',      ask: 'Куда перенести запись?' },
  browse:  { label: '📂 Обзор записей', ask: 'Выберите папку' },
  restore: { label: '🕘 Восстановление', ask: 'Исходная папка записи неизвестна — куда её вернуть?' },
};

/** Заголовок шага: «📤 Загрузка · шаг 2 из 6» и выбранные папки под ним. */
function flowHead(s, phase) {
  const f = FLOW[s.cmd] || { label: '' };
  const below = depthBelow(disk.joinPath(ROOT, ...s.path));
  const levels = below === null ? null : s.path.length + below;
  let step = null, total = null;
  if (s.cmd === 'upload') {
    total = levels === null ? null : levels + 2;               // папки + номер + файл
    step = phase === 'folder' ? s.path.length + 1 : phase === 'scr' ? s.path.length + 1 : s.path.length + 2;
  } else if (s.cmd === 'move') {
    total = levels === null ? null : levels + 2;               // номер + папки + подтверждение
    step = phase === 'folder' ? s.path.length + 2 : s.path.length + 2;
  } else if (s.cmd === 'replace') {
    total = 3;
    step = phase === 'scr' ? 1 : phase === 'file' ? 2 : 3;
  }
  const head = stepTitle(f.label, step, total);
  const where = s.path.length ? crumbs(s.path) : '';
  return where ? `${head}\n${where}` : head;
}

/** Показать содержимое текущего уровня. Если подпапок нет — уровень последний. */
async function askFolder(chatId, s) {
  const t0 = Date.now();
  const folder = disk.joinPath(ROOT, ...s.path);
  let listing;
  try {
    listing = await listCached(folder);
    const tDisk = Date.now() - t0;
    if (tDisk > 60) console.log(`   [шаг] Диск ${tDisk} мс — мимо кэша`);
  } catch (e) {
    reset(chatId);
    return screen(chatId, trouble('Не удалось прочитать структуру папок', 'Попробуйте ещё раз через минуту.'), rows([HOME()]));
  }

  const dirs = visibleDirs(listing);
  const records = s.cmd === 'browse'
    ? listing.files.filter((f) => SCR_RE.test(f.name) && isLive(f)).sort((a, b) => a.name.localeCompare(b.name))
    : [];

  if (dirs.length === 0 && s.cmd !== 'browse') {
    // Дно дерева: дальше — по команде
    if (s.cmd === 'move') {
      s.step = 'confirm-move';
      return screen(chatId,
        `${stepTitle(FLOW.move.label, s.path.length + 2, s.path.length + 2)}\n\n` +
        `БЫЛО\n${report(s.found.path)}\n${RULE}\nСТАНЕТ\n${report(s.path)}\n${RULE}\nПереместить SCR#${s.scr}?`,
        rows([btn('✅ Переместить', 'go:move'), HOME()]));
    }
    if (s.cmd === 'restore') {
      s.step = 'confirm-restore';
      return confirmRestore(chatId, s);
    }
    s.step = 'await-scr';
    return screen(chatId,
      `${flowHead(s, 'scr')}\n${RULE}\nВведите номер SCR — семь цифр, без «SCR» и «#»\nНапример: 6512028`,
      rows([HOME()]));
  }

  /* Папки и записи — одним списком по страницам: в обзоре на одном уровне бывают и те и другие. */
  const items = [
    // В обзоре на кнопке папки — сколько видео в ней со всеми вложенными папками.
    ...dirs.map((d) => btn(s.cmd === 'browse' ? cut(`📁 ${d.name} — ${videos(countUnder(d.path))}`, 60) : '📁 ' + d.name,
      'dir:' + keyFor(d.name))),
    ...records.map((f) => btn(cut(`🎞 ${f.name.replace(/\.[^.]+$/, '')} · ${mb(f.size)} · ${fmtDate(f.created)}`, 60),
      'rec:' + keyFor(f))),
  ];
  const { slice, nav, page, pages } = paginate(items, s.page);
  s.page = page;

  const top = [];
  // «В прошлую папку» — на первом экране загрузки, если человек уже грузил и папка на месте.
  if (s.cmd === 'upload' && !s.path.length && page === 0) {
    const last = lastPaths.get(lastUser.get(chatId));
    if (last?.length && (await isBottomFolder(last))) {
      top.push(btn(cut(`↩️ В прошлую папку: ${crumbs(last)}`, 60), 'again'));
    }
  }
  const tail = [];
  if (s.path.length) tail.push(btn('⬆️ На уровень выше', 'up'));
  tail.push(HOME());

  const f = FLOW[s.cmd] || FLOW.upload;
  const info = s.cmd === 'browse'
    ? (records.length || dirs.length
      ? (dirs.length
        ? `Папок: ${dirs.length} · всего видео: ${countUnder(folder)}` + (records.length ? ` (здесь: ${records.length})` : '')
        : `Видео в папке: ${records.length}`) + (pages > 1 ? ` · страница ${page + 1} из ${pages}` : '')
      : 'Здесь пока пусто.')
    : (pages > 1 ? `Страница ${page + 1} из ${pages}` : '');
  const text = [flowHead(s, 'folder'), RULE, f.ask, info].filter(Boolean).join('\n');

  const tSend = Date.now();
  const r = await screen(chatId, text, [...rows(top), ...rows(slice), ...nav, ...rows(tail)]);
  console.log(`   [шаг] MAX ${Date.now() - tSend} мс, всего ${Date.now() - t0} мс`);
  return r;
}

/** Сколько записей лежит в папке со всеми вложенными — по индексу, без запросов к Диску.
 *  Индекс обновляется после каждой загрузки, переноса и удаления и раз в 6 часов целиком;
 *  если видео клали на Диск руками — «Обновить структуру папок» в админке. */
function countUnder(folder) {
  const pre = ckey(folder).replace(/\/+$/, '') + '/';
  let n = 0;
  for (const list of scrIndex.values()) for (const f of list) if (ckey(f.path).startsWith(pre)) n++;
  return n;
}
const videos = (n) => (n ? `${n} видео` : 'пусто');

/** Папка существует и подпапок в ней нет — в неё можно загружать. */
async function isBottomFolder(segments) {
  try {
    const listing = await listCached(disk.joinPath(ROOT, ...segments));
    return visibleDirs(listing).length === 0;
  } catch { return false; }
}

/** Папка, в которой лежит файл: «disk:/a/b/c.mp4» → «/a/b» */
const parentOf = (p) => {
  const clean = String(p).replace(/^disk:/i, '');
  const i = clean.lastIndexOf('/');
  return i > 0 ? clean.slice(0, i) : '';
};

/* Что считаем видеозаписью. Бот принимал ЛЮБОЕ вложение: скриншот, документ, архив —
 * и оно вставало на место записи показа работ. Замечено на живом 07.09.2026, когда
 * вместо видео прилетел png и спокойно заменил собой mp4.
 * Проверяем по расширению: тип из мессенджера не приходит, а лезть внутрь файла
 * (он на серверах MAX) — значит качать его к себе, чего мы как раз избегаем. */
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mpg', '.mpeg']);

const extOf = (name) => {
  const m = String(name || '').match(/\.[A-Za-z0-9]{1,8}$/);
  return m ? m[0].toLowerCase() : '';
};

/* кэш структуры папок.
 * Замерено 07.09.2026: чтение папки с Диска — 400–900 мс, и оно происходило на КАЖДОМ
 * шаге опросника. Структура меняется хорошо если раз в месяц, поэтому держим её в памяти.
 *
 * Полное обновление — раз в 6 часов: прогрев — это сотни запросов, и при частом обновлении
 * они уходили бы впустую. Лимиты Диска не документированы, искать их холостым ходом — плохая идея.
 * После загрузки и переноса сбрасываются ТОЛЬКО затронутые папки (раньше — всё дерево
 * с повторным прогревом). Если папки правили руками на Диске — кнопка в админке.
 *
 * Ключ кэша — путь БЕЗ «disk:». Раньше прогрев клал папки под «disk:/Видеопоказы/…»
 * (так их отдаёт Диск), а опросник искал «/Видеопоказы/…» — и кэш почти не срабатывал:
 * каждый шаг всё равно шёл в Диск. Найдено при доработке 01.10.2026.
 */
const FOLDER_CACHE_TTL_MS = 6 * 60 * 60_000;
const folderCache = new Map();   // путь без «disk:» → { at, listing }
const ckey = (p) => String(p).replace(/^disk:/i, '');

async function listCached(folder) {
  const hit = folderCache.get(ckey(folder));
  if (hit && Date.now() - hit.at < FOLDER_CACHE_TTL_MS) return hit.listing;
  const listing = await disk.listFolder(folder);
  folderCache.set(ckey(folder), { at: Date.now(), listing });
  return listing;
}

/** Полный сброс — только по кнопке в админке и по расписанию. */
function dropFolderCache() { folderCache.clear(); warmTree(); }

/** Точечный сброс: папки, где что-то легло или откуда что-то ушло. */
function invalidateFolders(...folders) {
  for (const f of folders) if (f) folderCache.delete(ckey(f));
}

/* Индекс «номер → где лежит».
 * Поиск раньше листал плоский список ВСЕХ файлов Диска и видел только первую тысячу.
 * Теперь индекс собирается заодно с прогревом дерева (прогрев и так читает каждую папку
 * вместе с файлами) и обновляется после загрузки, замены и переноса.
 *
 * Индекс только ускоряет поиск и никогда не решает за Диск:
 *   - попадание проверяется одним stat — файл действительно на месте;
 *   - промах или устаревшая запись — полный поиск по Диску, без предела в 1000.
 * Поэтому ответ «записи нет» по-прежнему даёт только полный поиск. */
const SCR_RE = /SCR#(\d{7})/i;
const isTemp = (name) => /\.new$/i.test(String(name));   // недолитая замена — не запись
const isLive = (f) => !f.path.includes(`/${BACKUP}/`) && !isTemp(f.name);
let scrIndex = new Map();        // '6512028' → [{ name, path, size, created }]

function indexAdd(f) {
  const m = String(f.name).match(SCR_RE);
  if (!m || !isLive(f)) return;
  const list = (scrIndex.get(m[1]) || []).filter((x) => ckey(x.path) !== ckey(f.path));
  list.push({ name: f.name, path: f.path, size: f.size ?? 0, created: f.created ?? null });
  scrIndex.set(m[1], list);
}
function indexRemove(path) {
  for (const [k, list] of scrIndex) {
    const rest = list.filter((x) => ckey(x.path) !== ckey(path));
    if (rest.length !== list.length) { if (rest.length) scrIndex.set(k, rest); else scrIndex.delete(k); }
  }
}

/* Брошенные замены: «SCR#….mp4.new», которые остались, если бот перезапустили посреди
 * замены. Сам бот с ними НИЧЕГО не делает — только показывает администратору. */
const orphanSeen = new Set();    // о каких уже сообщили в этом запуске
const inFlightPaths = new Set(); // .new, которые бот льёт прямо сейчас, — не брошенные

/* Кэш сам по себе опроснику не помогал: каждый шаг — НОВАЯ папка, которую бот видит
 * впервые. Поэтому дерево читаем ЦЕЛИКОМ заранее, в фоне, — человек этих запросов не ждёт.
 * Индекс собирается в отдельную таблицу и подменяет прежний разом, в конце: пока идёт
 * прогрев, поиск пользуется прежним индексом, а не наполовину собранным. */
let warming = null;

async function warmTree() {
  if (warming) return warming;                      // уже греем — не запускаем второй раз
  const t0 = Date.now();
  warming = (async () => {
    let count = 0;
    let complete = true;
    const index = new Map();
    const temps = [];
    const visit = async (folder, depth) => {
      if (depth > 8) return;                        // страховка от бесконечной вложенности
      let listing;
      try {
        listing = await disk.listFolder(folder);
      } catch { complete = false; return; }
      folderCache.set(ckey(folder), { at: Date.now(), listing });
      count++;
      for (const f of listing.files) {
        if (isTemp(f.name) && SCR_RE.test(f.name)) { temps.push(f); continue; }
        const m = String(f.name).match(SCR_RE);
        if (m) index.set(m[1], [...(index.get(m[1]) || []), f]);
      }
      const dirs = listing.dirs.filter((d) => d.name !== BACKUP && !d.name.startsWith('_'));
      // по 6 веток разом: Диск не любит шквал, но и по одной ждать незачем
      for (let i = 0; i < dirs.length; i += 6) {
        await Promise.all(dirs.slice(i, i + 6).map((d) => visit(d.path, depth + 1)));
      }
    };
    await visit(disk.joinPath(ROOT), 0);
    // Неполный прогрев (часть папок не прочиталась) индекс не подменяет: лучше старый
    // целый, чем новый с дырами. Промахи всё равно добирает полный поиск.
    if (complete) scrIndex = index;
    console.log(`   дерево прогрето: ${count} папок, записей в индексе ${scrIndex.size}` +
      `${complete ? '' : ' (часть папок не прочиталась — индекс оставлен прежним)'}` +
      ` за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
    reportOrphans(temps).catch((e) => console.error('   проверка брошенных замен:', e.message));
  })().finally(() => { warming = null; });
  return warming;
}

async function reportOrphans(temps) {
  for (const f of temps) {
    const k = ckey(f.path);
    if (inFlightPaths.has(k) || orphanSeen.has(k)) continue;
    orphanSeen.add(k);
    const key = keyFor(f.path);
    console.log(`   найдена незавершённая замена: ${k}`);
    const text = `⚠️ Найдена незавершённая замена\n\n${f.name}\n${report(f.path)}\n${RULE}\n` +
      'Новая версия записи лежит на Диске под временным именем: бота, видимо, перезапустили ' +
      'посреди замены. Сам бот с ней ничего делать не будет.';
    const buttons = rows([
      btn('✅ Завершить замену', 'orph:fin:' + key),
      btn('📦 Убрать в архив', 'orph:arc:' + key),
    ]);
    for (const id of ADMINS) {
      const chatId = adminChats.get(id);
      if (!chatId) continue;
      try { await say(chatId, text, buttons); } catch (e) { console.error('   не смог сообщить о замене:', e.message); }
    }
  }
}

/** Ищем запись по номеру: сначала индекс (с проверкой), при любом сомнении — весь Диск. */
async function findByScr(scr) {
  const hits = scrIndex.get(scr);
  if (hits?.length) {
    const ok = [];
    for (const f of hits) {
      const meta = await disk.stat(f.path, { fields: 'name,path,size,created' });
      if (!meta) { ok.length = 0; break; }          // индекс устарел — не доверяем ему целиком
      ok.push({ name: meta.name, path: meta.path, size: meta.size ?? 0, created: meta.created ?? null });
    }
    if (ok.length) return ok;
  }
  // BackUp и недолитые «.new» исключаем: это не записи
  const all = (await disk.findFiles(`SCR#${scr}`)).filter(isLive);
  if (all.length) scrIndex.set(scr, all); else scrIndex.delete(scr);
  return all;
}


/* админка.
 * Живёт внутри бота: отдельная панель ради десятка человек не окупается,
 * а здесь всё под рукой и не требует ни хостинга, ни отдельного входа.
 * Три раздела вместо длинного столбика: действия живут рядом с тем, к чему относятся.
 */
const ADMIN_MENU = () => [
  btn('👥 Доступ', 'adm:people'),
  btn('📊 Отчёты', 'adm:reports'),
  btn('🔄 Обновить структуру папок', 'adm:refresh'),
  HOME(),
];
const BACK = () => btn('⬅️ Назад', 'adm:back');

async function adminScreen(chatId, prefix = '') {
  return screen(chatId, (prefix ? prefix + '\n\n' : '') + '⚙️ Администрирование', rows(ADMIN_MENU()));
}

async function onAdmin(chatId, userId, payload, s) {
  if (!isAdmin(userId)) return say(chatId, 'Эта команда доступна только администраторам.');
  return adminRoute(chatId, userId, payload, s);
}

const roleTitle = (a) => (ROLES[a?.role] || ROLES[DEFAULT_ROLE]).title;
const today = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const pendingRequests = () => [...requests.entries()].filter(([, r]) => r.status === 'pending');

/** Выдать доступ — одна функция и для ввода номера, и для заявки. */
function addAccess({ id, name, role, by }) {
  if (access.some((a) => a.id === id)) return 'exists';
  const next = [...access, { id, name: name || null, role, addedBy: by, addedAt: today() }];
  if (!saveAccess(next)) return 'fail';
  access = next;
  console.log(`   доступ выдан: ${name || '—'} (${id}) роль ${role}, администратор ${by}`);
  journal.log({ userId: by, name: nameOf(by), action: 'Выдача доступа',
    where: `${name || 'без имени'} (${id})`, result: ROLES[role].title });
  return 'ok';
}

/** Чат человека с ботом — чтобы сообщить ему о решении администратора. */
const chatOfUser = (userId) => [...lastUser.entries()].find(([, u]) => u === userId)?.[0] ?? null;

/** Список людей кнопками по страницам — для «Изменить роль» и «Убрать». */
function peopleButtons(list, prefix, page) {
  const items = list.map((a) => btn(cut(`${a.name || a.id} · ${roleTitle(a)}`, 60), prefix + keyFor(a.id)));
  return paginate(items, page);
}

async function adminRoute(chatId, userId, payload, s) {

  if (payload === 'adm:people') {
    s.view = null;
    const pend = pendingRequests().length;
    const actions = [
      ...(pend ? [btn(`🙋 Заявки на доступ (${pend})`, 'adm:reqs')] : []),
      btn('➕ Добавить', 'adm:add'),
      ...(access.length ? [btn('🔁 Изменить роль', 'adm:chg'), btn('➖ Убрать', 'adm:del'), btn('🔎 Найти', 'adm:find'),
        btn('📥 Выгрузить в Excel', 'adm:export')] : []),
      BACK(),
    ];
    if (!access.length) return screen(chatId, '👥 Доступ\n\nСписок пуст: ботом пользуются только основные администраторы.', rows(actions));
    const blocks = [];
    for (const [key, def] of Object.entries(ROLES)) {
      const people = access.filter((a) => (ROLES[a.role] ? a.role : DEFAULT_ROLE) === key);
      if (!people.length) continue;
      blocks.push(`${def.title.toUpperCase()} (${people.length})\n` +
        people.map((a) => `  ${a.name || 'без имени'} — ${a.id}`).join('\n'));
    }
    return screen(chatId, cut(`👥 Доступ есть у ${access.length} чел.\n${RULE}\n` + blocks.join(`\n${RULE}\n`), 3800), rows(actions));
  }

  if (payload === 'adm:reqs') {
    const pend = pendingRequests();
    if (!pend.length) return adminRoute(chatId, userId, 'adm:people', s);
    return screen(chatId, `🙋 Заявки на доступ: ${pend.length}\n${RULE}\nВыберите, чтобы решить:`, rows([
      ...pend.map(([id, r]) => btn(cut(`🙋 ${r.name || 'без имени'} · ${id}`, 60), `admreq:${id}`)),
      BACK(),
    ]));
  }

  if (payload.startsWith('admreq:')) {
    const id = Number(payload.slice(7));
    const r = requests.get(id);
    if (!r || r.status !== 'pending') return adminRoute(chatId, userId, 'adm:reqs', s);
    return screen(chatId, requestCardText(id, r), requestButtons(id));
  }

  if (payload === 'adm:reports') {
    const ms = await journal.months();
    const buttons = ms.slice(0, 6).map((m) =>
      btn(`🗒 Журнал за ${journal.monthTitle(m.ym)}`, 'admlog:' + m.ym));
    if (!ms.length) buttons.push(btn('🗒 Журнал пока пуст', 'adm:reports'));
    buttons.push(btn('🕒 Последние действия', 'adm:recent'));
    buttons.push(btn('📋 Сверка с реестром', 'adm:registry'));
    buttons.push(btn('📊 Что на Диске', 'adm:stats'));
    buttons.push(BACK());
    return screen(chatId, '📊 Отчёты', rows(buttons));
  }

  if (payload.startsWith('admlog:')) {
    // В кнопке лежит сам месяц («2026-09»), а не ключ в памяти: ключи не переживают
    // перезапуск бота, и старая кнопка молча переставала работать. Замерено 07.09.2026.
    const ym = payload.slice(7);
    if (!/^\d{4}-\d{2}$/.test(ym)) return adminScreen(chatId);
    await drop(chatId, s.mid);                       // экран «Отчёты» сейчас заменится файлом
    const wait = await say(chatId, 'Готовлю журнал…');
    const caption = `Журнал действий, ${journal.monthTitle(ym)}`;
    try {
      // Excel с фильтрами; если собрать не вышло — прежний CSV, чтобы журнал не остался недоступен.
      try {
        await sendBuffer(chatId, { buffer: await journal.monthXlsx(ym), filename: `Журнал ${ym}.xlsx`, caption });
      } catch (e) {
        console.error('   журнал в Excel не собрался, отдаю CSV:', e.message);
        const path = journal.monthPath(ym);
        const st = await disk.stat(path, { fields: 'name,size' });
        await sendFileFromUrl(chatId, { url: await downloadHref(path), filename: st.name, size: st.size, caption });
      }
      await drop(chatId, wait?.message?.body?.mid);    // и служебное «готовлю» тоже
      return adminScreen(chatId);
    } catch (e) {
      await drop(chatId, wait?.message?.body?.mid);
      return adminScreen(chatId, trouble('Не удалось выгрузить журнал', e.message));
    }
  }

  if (payload === 'adm:recent') return showRecent(chatId);

  if (payload === 'adm:registry') {
    s.step = 'await-registry';
    return screen(chatId,
      '📋 Сверка с реестром\n' + RULE + '\n' +
      'Пришлите файлом таблицу Excel (.xlsx) или CSV со списком номеров SCR.\n' +
      'Колонка не важна: бот найдёт все семизначные номера в любом месте таблицы.\n\n' +
      'В ответ придёт таблица: какие записи есть на Диске, каких нет и какие лежат на Диске, но не в реестре.',
      rows([BACK()]));
  }

  if (payload === 'adm:add') {
    const buttons = Object.entries(ROLES).map(([key, def]) => btn(`${def.title} — ${def.desc}`, 'admrole:' + key));
    buttons.push(BACK());
    return screen(chatId, '➕ Какую роль дать человеку?', rows(buttons));
  }

  if (payload.startsWith('admrole:')) {
    s.newRole = payload.slice(8);
    s.step = 'adm-await-id';
    return screen(chatId,
      `➕ Роль: ${ROLES[s.newRole]?.title || s.newRole}\n${RULE}\n` +
      'Пришлите номер человека — он видит его в отказе бота, когда пытается написать.\n\n' +
      'Можно сразу с именем, через пробел: 12345678 Иван Петров',
      rows([BACK()]));
  }

  /* Смена роли. Раньше — только «убрать и добавить заново»: человек на это время терял
   * доступ, номер вписывался руками ещё раз, а история «кто и когда добавил» пропадала. */
  if (payload === 'adm:chg' || payload.startsWith('admchgp:')) {
    const list = access.filter((a) => !ADMINS.includes(a.id));
    if (!list.length) return adminRoute(chatId, userId, 'adm:people', s);
    const { slice, nav } = peopleButtons(list, 'admchg:', payload.startsWith('admchgp:') ? Number(payload.slice(8)) : 0);
    return screen(chatId, '🔁 Кому изменить роль?', [...rows(slice), ...navAs(nav, 'admchgp:', payload), ...rows([BACK()])]);
  }

  if (payload.startsWith('admchg:')) {
    const id = choices.get(payload.slice(7));
    const who = access.find((a) => a.id === id);
    if (!who) return adminRoute(chatId, userId, 'adm:people', s);
    s.chgId = id;
    const buttons = Object.entries(ROLES).map(([key, def]) =>
      btn(`${key === (ROLES[who.role] ? who.role : DEFAULT_ROLE) ? '✓ ' : ''}${def.title} — ${def.desc}`, 'admchgto:' + key));
    buttons.push(BACK());
    return screen(chatId, `🔁 ${who.name || 'без имени'} (${id})\nСейчас: ${roleTitle(who)}\n${RULE}\nНовая роль:`, rows(buttons));
  }

  if (payload.startsWith('admchgto:')) {
    const role = payload.slice(9);
    const id = s.chgId;
    const who = access.find((a) => a.id === id);
    if (!who || !ROLES[role]) return adminRoute(chatId, userId, 'adm:people', s);
    if (ADMINS.includes(id)) return adminScreen(chatId, 'Основному администратору роль отсюда не меняется.');
    const was = roleTitle(who);
    if ((ROLES[who.role] ? who.role : DEFAULT_ROLE) === role) return adminRoute(chatId, userId, 'adm:people', s);
    const next = access.map((a) => (a.id === id ? { ...a, role } : a));
    if (!saveAccess(next)) return adminScreen(chatId, 'Не удалось сохранить список доступа, попробуйте ещё раз.');
    access = next;
    s.chgId = null;
    journal.log({ userId, name: nameOf(userId), action: 'Смена роли',
      where: `${who.name || 'без имени'} (${id})`, result: `${was} → ${ROLES[role].title}` });
    const theirChat = chatOfUser(id);
    if (theirChat) {
      say(theirChat, `Ваша роль в боте изменена: ${ROLES[role].title}.`, rows(menuFor(id)))
        .catch((e) => console.error('   не сообщил о смене роли:', e.message));
    }
    await say(chatId, `🔁 ${who.name || id}: ${was} → ${ROLES[role].title}`);
    return adminRoute(chatId, userId, 'adm:people', s);
  }

  if (payload === 'adm:del' || payload.startsWith('admdelp:')) {
    const list = access.filter((a) => !ADMINS.includes(a.id) && a.id !== userId);
    if (!list.length) return adminScreen(chatId, 'Убирать некого.');
    const { slice, nav } = peopleButtons(list, 'admdel:', payload.startsWith('admdelp:') ? Number(payload.slice(8)) : 0);
    return screen(chatId, '➖ Кого убрать?', [...rows(slice), ...navAs(nav, 'admdelp:', payload), ...rows([BACK()])]);
  }

  if (payload.startsWith('admdel:')) {
    const id = choices.get(payload.slice(7));
    const gone = access.find((a) => a.id === id);
    if (!gone) return adminScreen(chatId, 'Этого человека уже нет в списке.');
    if (ADMINS.includes(id)) return adminScreen(chatId, `${gone.name || id} — основной администратор, записан в программе; отсюда его не убрать.`);
    if (id === userId) return adminScreen(chatId, 'Себя убрать нельзя — попросите другого администратора.');
    const next = access.filter((a) => a.id !== id);
    if (!saveAccess(next)) return adminScreen(chatId, 'Не удалось сохранить список доступа, попробуйте ещё раз.');
    access = next;
    console.log(`   доступ отозван: ${gone.name} (${id})`);
    journal.log({
      userId, name: nameOf(userId), action: 'Отзыв доступа',
      where: `${gone.name || 'без имени'} (${id})`, result: 'доступ закрыт',
    });
    return onAdmin(chatId, userId, 'adm:people', s);
  }

  if (payload === 'adm:find') {
    s.step = 'adm-await-search';
    return screen(chatId, '🔎 Кого ищем? Введите часть имени или номер.', rows([BACK()]));
  }

  if (payload === 'adm:export') {
    try {
      const { buffer, name } = journal.exportPeople(access, ROLES, nameOf);
      await drop(chatId, s.mid);
      await sendBuffer(chatId, { buffer, filename: name, caption: `Список доступа на ${new Date().toLocaleDateString('ru-RU')}` });
      return onAdmin(chatId, userId, 'adm:people', s);
    } catch (e) {
      return adminScreen(chatId, trouble('Не удалось выгрузить список', e.message));
    }
  }

  if (payload === 'adm:refresh') {
    dropFolderCache();
    meta.reload();
    return adminScreen(chatId, '🔄 Структура папок перечитывается — через минуту свежие папки будут видны в опроснике.');
  }

  if (payload === 'adm:stats') {
    try {
      const files = await disk.findFiles('SCR#');
      const live = files.filter(isLive);
      const backups = files.filter((f) => f.path.includes(`/${BACKUP}/`)).length;
      const bytes = live.reduce((n, f) => n + (f.size || 0), 0);
      const free = await disk.freeSpace();
      return adminScreen(chatId,
        '📊 Что на Диске\n\n' +
        `Записей: ${live.length}\n` +
        `В архиве версий: ${backups}\n` +
        `Занимают: ${(bytes / 1024 ** 3).toFixed(2).replace('.', ',')} ГБ\n` +
        `Свободно: ${(free / 1024 ** 3).toFixed(2).replace('.', ',')} ГБ`);
    } catch (e) {
      alertDisk(e);
      return adminScreen(chatId, trouble('Не удалось собрать статистику', diskTrouble(e)));
    }
  }

  return adminScreen(chatId);
}

/** Строка страниц для списков админки: «pg:next» превращается в «admchgp:2» и т. п. */
function navAs(nav, prefix, payload) {
  if (!nav.length) return [];
  const cur = payload.startsWith(prefix) ? Number(payload.slice(prefix.length)) || 0 : 0;
  return [nav[0].map((b) => (b.payload === 'pg:prev' ? btn(b.text, prefix + (cur - 1))
    : b.payload === 'pg:next' ? btn(b.text, prefix + (cur + 1)) : b))];
}

/** 🕒 Последние действия — прямо сообщением, без скачивания журнала. */
async function showRecent(chatId, n = 15) {
  try {
    const now = new Date();
    const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    let list = await journal.readMonth(ym(now));
    if (list.length < n) {
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      list = [...(await journal.readMonth(ym(prev))), ...list];
    }
    const last = list.slice(-n).reverse();
    if (!last.length) return adminScreen(chatId, '🕒 Действий пока не было.');
    const lines = last.map((r) => {
      const err = /^ОШИБКА/.test(r['Результат']) ? ' ⚠️' : '';
      return `${r['Дата'].slice(0, 5)} ${r['Время'].slice(0, 5)} · ${r['Кто (имя)'] || r['Кто (номер)']}${err}\n` +
        `   ${r['Действие']}${r['SCR'] ? ' ' + r['SCR'] : ''}${r['Где'] ? ' · ' + cut(r['Где'], 70) : ''}` +
        (err ? `\n   ${cut(r['Результат'], 90)}` : '');
    });
    return screen(chatId, cut(`🕒 Последние ${last.length} действий\n${RULE}\n${lines.join('\n')}`, 3800),
      rows([btn('⬅️ К отчётам', 'adm:reports'), HOME()]));
  } catch (e) {
    alertDisk(e);
    return adminScreen(chatId, trouble('Не удалось прочитать журнал', diskTrouble(e)));
  }
}

function allowed(userId) {
  return ADMINS.includes(userId) || access.some((a) => a.id === userId);
}
const isAdmin = (userId) => can(userId, 'admin');
const nameOf = (userId) => (access.find((a) => a.id === userId)?.name) || String(userId);

/** Сбои, о которых администратор должен узнать сразу, а не от пользователей. */
function alertDisk(e) {
  if (e?.status === 401 || e?.status === 403) {
    notifyAdmins('disk-auth', `⛔ У бота нет доступа к Яндекс.Диску (HTTP ${e.status}).\n` +
      'Скорее всего, истёк или отозван токен YANDEX_DISK_TOKEN — загрузки и поиск не работают.');
  } else if (e?.status === 507) {
    notifyAdmins('disk-full', '⚠️ На Яндекс.Диске закончилось место — загрузки не проходят.');
  }
}

/** Короткая причина сбоя Диска для человека в чате; полный текст ошибки — в журнал работы. */
function diskTrouble(e) {
  if (e?.status === 507) return 'На Диске закончилось место — сообщите администратору.';
  if (e?.status === 423) return 'Диск временно не принимает загрузки — попробуйте позже.';
  if (e?.status === 413) return 'Файл слишком большой для этого Диска — сообщите администратору.';
  if (e?.status === 401 || e?.status === 403) return 'У бота нет доступа к Диску — сообщите администратору.';
  return 'Не получилось связаться с Диском, попробуйте ещё раз. Если повторится — сообщите администратору.';
}

/* Заявка на доступ.
 * Раньше постороннему бот отвечал «перешлите номер администратору» — и дальше всё шло
 * руками: переслать, вписать номер, не ошибиться в цифрах. Теперь у отказа есть кнопка
 * «Запросить доступ», а администратору приходит карточка с выбором роли в одно касание.
 * Посторонним открыта ровно эта кнопка; выдаёт доступ по-прежнему только администратор. */
const REQUEST_EVERY_MS = 24 * 60 * 60_000;
const userName = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.name || u?.username || null;

/** Отказ с номером: человеку есть что переслать администратору, а админу — что вписать. */
function denied(chatId, userId) {
  console.log(`   ОТКАЗ в доступе: user_id=${userId}`);
  const pending = requests.get(userId)?.status === 'pending';
  return say(chatId,
    `Доступ к боту не выдан.\n\nВаш номер: ${userId}\n` +
    (pending
      ? 'Заявка уже у администратора — дождитесь решения, бот пришлёт сообщение.'
      : 'Нажмите «Запросить доступ» — администратор получит заявку. Или перешлите номер администратору.'),
    pending ? null : rows([btn('🙋 Запросить доступ', 'req:access')]));
}

function requestCardText(id, r) {
  return `🙋 Заявка на доступ\n\nИмя: ${r.name || 'не указано'}\nНомер: ${id}\n` +
    `Когда: ${new Date(r.at).toLocaleString('ru-RU')}\n${RULE}\nКакую роль дать?`;
}
const requestButtons = (id) => rows([
  btn('👁 Гость — только поиск', `areq:viewer:${id}`),
  btn('👷 Руководитель проекта', `areq:editor:${id}`),
  btn('⛔ Отклонить', `areq:no:${id}`),
]);

async function onAccessRequest(chatId, user) {
  const id = user?.user_id;
  if (!id || !chatId) return;
  if (allowed(id)) return showMenu(chatId, 'Доступ у вас уже есть.', id);
  const r = requests.get(id);
  if (r?.status === 'pending') return say(chatId, 'Заявка уже отправлена — администратор её рассмотрит.');
  if (r && Date.now() - r.at < REQUEST_EVERY_MS) {
    return say(chatId, `Заявку можно отправлять не чаще раза в сутки. Можно переслать номер администратору: ${id}`);
  }
  const adminChatIds = [...new Set(ADMINS.map((a) => adminChats.get(a)).filter(Boolean))];
  if (!adminChatIds.length) return say(chatId, `Сейчас передать заявку некому. Перешлите ваш номер администратору: ${id}`);
  // Решённые заявки старше месяца не храним: state.json не должен расти без предела.
  for (const [k, v] of requests) if (v.status !== 'pending' && Date.now() - v.at > 30 * 24 * 60 * 60_000) requests.delete(k);
  const req = { name: userName(user), chatId, at: Date.now(), status: 'pending' };
  requests.set(id, req);
  saveState();
  console.log(`   заявка на доступ: ${req.name || '—'} (${id})`);
  let sent = 0;
  for (const ac of adminChatIds) {
    try { await say(ac, requestCardText(id, req), requestButtons(id)); sent++; }
    catch (e) { console.error('   заявка не дошла до администратора:', e.message); }
  }
  if (!sent) {
    requests.delete(id);
    return say(chatId, `Не удалось передать заявку. Перешлите ваш номер администратору: ${id}`);
  }
  return say(chatId, '🙋 Заявка отправлена администратору. Когда он её рассмотрит, бот пришлёт сообщение.');
}

async function onAccessDecision(chatId, adminId, payload) {
  const [, role, idStr] = payload.split(':');
  const id = Number(idStr);
  const r = requests.get(id);
  if (!r || r.status !== 'pending') {
    return say(chatId, r
      ? `Эту заявку уже рассмотрели: ${r.status === 'approved' ? 'доступ выдан' : 'отклонена'}${r.by ? ` (${nameOf(r.by)})` : ''}.`
      : 'Заявка не найдена — возможно, её уже рассмотрели.');
  }
  if (role === 'no') {
    Object.assign(r, { status: 'rejected', by: adminId, decidedAt: Date.now() });
    saveState();
    journal.log({ userId: adminId, name: nameOf(adminId), action: 'Отказ в доступе',
      where: `${r.name || 'без имени'} (${id})`, result: 'заявка отклонена' });
    if (r.chatId) say(r.chatId, 'Заявка на доступ отклонена администратором.').catch(() => {});
    return say(chatId, `⛔ Заявка ${r.name || id} отклонена.`);
  }
  if (!ROLES[role] || role === 'admin') return say(chatId, 'Неизвестная роль.');
  const res = addAccess({ id, name: r.name, role, by: adminId });
  if (res === 'fail') return say(chatId, 'Не удалось сохранить список доступа, попробуйте ещё раз.');
  Object.assign(r, { status: 'approved', role, by: adminId, decidedAt: Date.now() });
  saveState();
  if (r.chatId) {
    say(r.chatId, `✅ Доступ выдан: ${ROLES[role].title}.`, rows(menuFor(id)))
      .catch((e) => console.error('   не сообщил о выдаче доступа:', e.message));
  }
  return say(chatId, `✅ ${r.name || id}: доступ выдан — ${ROLES[role].title}.` +
    (res === 'exists' ? ' (Человек уже был в списке.)' : ''));
}

const noRight = (chatId, userId) =>
  say(chatId, 'Это действие недоступно для вашей роли.', rows(menuFor(userId)));

async function onCallback(u) {
  const cb = u.callback;
  const chatId = u.message?.recipient?.chat_id ?? cb?.user?.user_id;
  const userId = cb?.user?.user_id;
  const payload = String(cb?.payload || '');
  if (payload === 'req:access') return onAccessRequest(chatId, cb?.user);
  if (!allowed(userId)) return denied(chatId, userId);

  lastUser.set(chatId, userId);
  if (ADMINS.includes(userId)) adminChats.set(userId, chatId);   // сюда пойдут оповещения
  const s = session(chatId);

  if (payload === 'pg:noop') return;                 // счётчик страниц — не кнопка

  if (payload === 'cmd:menu') {
    reset(chatId);
    return showMenu(chatId);
  }

  if (payload.startsWith('areq:')) {
    if (!isAdmin(userId)) return say(chatId, 'Эта команда доступна только администраторам.');
    return onAccessDecision(chatId, userId, payload);
  }
  if (payload === 'adm:back' || payload === 'adm:menu') { s.step = null; return onAdmin(chatId, userId, 'adm:menu', s); }
  if (payload.startsWith('adm')) return onAdmin(chatId, userId, payload, s);   // adm:, admdel:, admrole:, admlog:…
  if (payload.startsWith('orph:')) {
    if (!isAdmin(userId)) return say(chatId, 'Эта команда доступна только администраторам.');
    return onOrphan(chatId, userId, payload);
  }

  // Кнопки опросника из старого сообщения, когда команда уже закончилась, — не гадаем.
  if ((payload === 'up' || payload.startsWith('dir:') || payload === 'pg:prev' || payload === 'pg:next') &&
      !s.cmd && s.view !== 'versions') {
    return showMenu(chatId, 'Кнопка устарела — начните заново.', userId);
  }

  // Страницы: в обзоре версий — по версиям, иначе — по папкам опросника
  if (payload === 'pg:prev' || payload === 'pg:next') {
    s.page = (s.page || 0) + (payload === 'pg:next' ? 1 : -1);
    return s.view === 'versions' ? showVersions(chatId, userId, s) : askFolder(chatId, s);
  }

  // Выбор одной записи из нескольких с одинаковым номером
  if (payload.startsWith('pick:')) {
    const f = choices.get(payload.slice(5));
    if (!f || s.step !== 'pick' || !s.scr) return showMenu(chatId, 'Кнопка устарела — начните заново.', userId);
    s.found = f;
    s.step = null;
    return afterFound(chatId, s);
  }

  if (payload === 'up') { s.path.pop(); s.page = 0; return askFolder(chatId, s); }

  if (payload.startsWith('dir:')) {
    const name = choices.get(payload.slice(4));
    if (!name) return askFolder(chatId, s);   // ключ протух после перезапуска
    s.path.push(name);
    s.page = 0;
    return askFolder(chatId, s);
  }

  // «В прошлую папку» и «Ещё запись сюда»: сразу к номеру, если папка на месте
  if (payload === 'again') {
    if (!can(userId, 'upload')) return noRight(chatId, userId);
    const last = lastPaths.get(userId);
    const ok = last?.length && (await isBottomFolder(last));
    Object.assign(s, { cmd: 'upload', step: 'folder', path: ok ? [...last] : [], scr: null, found: null,
      page: 0, view: null, pending: null, renum: false });
    return askFolder(chatId, s);
  }

  if (payload === 'cmd:upload') {
    if (!can(userId, 'upload')) return say(chatId, 'Загрузка недоступна: у вас роль «Гость» — только поиск записей.');
    Object.assign(s, { cmd: 'upload', step: 'folder', path: [], scr: null, found: null, page: 0, view: null,
      pending: null, renum: false });
    return askFolder(chatId, s);
  }

  if (payload === 'cmd:browse') {
    if (!can(userId, 'browse')) return noRight(chatId, userId);
    Object.assign(s, { cmd: 'browse', step: 'folder', path: [], scr: null, found: null, page: 0, view: null });
    return askFolder(chatId, s);
  }

  if (payload === 'cmd:find' || payload === 'cmd:replace' || payload === 'cmd:move') {
    const cmd = payload.slice(4);
    if (!can(userId, cmd)) return say(chatId, 'Это действие недоступно: у вас роль «Гость» — только поиск записей.');
    Object.assign(s, { cmd, step: 'await-scr', path: [], scr: null, found: null, page: 0, view: null, pending: null });
    const what = cmd === 'find' ? 'найти' : cmd === 'replace' ? 'заменить' : 'переместить';
    const head = cmd === 'find' ? '🔍 Поиск записи' : cmd === 'replace' ? stepTitle('♻️ Замена', 1, 3) : stepTitle('📁 Перенос', 1, null);
    // Просим номер одинаково во всех командах: в ветке загрузки текст согласовали,
    // а здесь оставался старый — без подсказки про префикс и без примера.
    return screen(chatId, `${head}\n${RULE}\nКакую запись ${what}?\nВведите номер SCR — семь цифр, без «SCR» и «#»\nНапример: 6512028`,
      rows([HOME()]));
  }

  if (payload.startsWith('rec:')) return openRecord(chatId, userId, s, choices.get(payload.slice(4)));
  if (payload.startsWith('ra:')) return onRecordAction(chatId, userId, s, payload.slice(3));
  if (payload.startsWith('cmt:')) {
    if (!can(userId, 'comment')) return noRight(chatId, userId);
    const f = choices.get(payload.slice(4));
    if (!f) return showMenu(chatId, 'Кнопка устарела — найдите запись заново.', userId);
    s.rec = f;
    s.scr = (f.name.match(SCR_RE) || [])[1];
    return askComment(chatId, s);
  }
  if (payload.startsWith('ver:')) {
    const v = choices.get(payload.slice(4));
    if (!v || !s.scr) return showMenu(chatId, 'Кнопка устарела — откройте версии заново.', userId);
    s.ver = v;
    s.cmd = s.cmd === 'restore' ? 'restore' : 'versions';
    s.path = [];
    return confirmRestore(chatId, s);
  }

  if (payload === 'go:move') return doMove(chatId, userId, s);
  if (payload === 'go:file') return confirmedFile(chatId, userId, s);
  if (payload === 'go:renum') {
    if (s.step !== 'confirm-file' || !s.pending) return showMenu(chatId, 'Кнопка устарела — начните заново.', userId);
    s.step = 'await-scr';
    s.renum = true;
    return screen(chatId, `${flowHead(s, 'scr')}\n${RULE}\nВведите правильный номер SCR — семь цифр.\nФайл присылать заново не нужно.`,
      rows([HOME()]));
  }
  if (payload === 'go:restore') return doRestore(chatId, userId, s);
  if (payload === 'go:delete') return doDelete(chatId, userId, s);

  return showMenu(chatId);
}

async function onMessage(u) {
  const m = u.message;
  const chatId = m?.recipient?.chat_id;

  /* Человек написал текст — его сообщение встало НИЖЕ нашего экрана, и правка
   * ушла бы наверх, где он уже не смотрит. Снаружи это выглядит как «бот молчит»:
   * в логе всё обработано за полсекунды, а в чате пусто. Поймано трижды за вечер
   * 07.09.2026, каждый раз под видом разной поломки.
   * Поэтому: текст от человека → следующий экран приходит НОВЫМ сообщением.
   * Нажатие кнопки ленту не двигает — там правка по-прежнему правильна. */
  if (chatId) {
    const sess = sessions.get(chatId);
    if (sess) sess.mid = null;
  }
  const userId = m?.sender?.user_id;
  const text = (m?.body?.text || '').trim();
  const attachments = m?.body?.attachments || [];
  if (!chatId) return;
  if (!allowed(userId)) return denied(chatId, userId);

  lastUser.set(chatId, userId);
  if (ADMINS.includes(userId)) adminChats.set(userId, chatId);   // сюда пойдут оповещения
  const s = session(chatId);

  if (/^\/(start|menu|help)$/i.test(text)) {
    reset(chatId);
    return showMenu(chatId, 'Бот хранит видеозаписи показов работ по контрактам.');
  }

  // Команды из списка бота делают ровно то же, что кнопки меню: человеку не должно быть
  // разницы, нажал он кнопку или набрал /find.
  if (/^\/admin\b/i.test(text)) {
    if (!isAdmin(userId)) return say(chatId, 'Эта команда доступна только администраторам.');
    reset(chatId);
    return onAdmin(chatId, userId, 'adm:menu', session(chatId));
  }

  const cmdAlias = { upload: 'cmd:upload', find: 'cmd:find', replace: 'cmd:replace', move: 'cmd:move', browse: 'cmd:browse' };
  const asCommand = text.match(/^\/(upload|find|replace|move|browse)\b/i);
  if (asCommand) {
    return onCallback({
      message: { recipient: { chat_id: chatId } },
      callback: { user: { user_id: userId }, payload: cmdAlias[asCommand[1].toLowerCase()] },
    });
  }

  // Файл прислали — запись на шаге загрузки или замены, либо реестр для сверки
  const file = attachments.find((a) => a.type === 'file' || a.type === 'video');
  if (file) return onFile(chatId, userId, s, file);

  if (s.step === 'await-registry' && text) return say(chatId, 'Пришлите реестр файлом — таблицей .xlsx или .csv.');

  // Комментарий к записи
  if (s.step === 'await-comment' && text) return saveComment(chatId, userId, s, text);

  // Поиск человека в админке
  if (s.step === 'adm-await-search' && text) {
    if (!isAdmin(userId)) return noRight(chatId, userId);
    const q = text.trim().toLowerCase();
    const hits = access.filter((a) =>
      String(a.id).includes(q) || (a.name || '').toLowerCase().includes(q));
    s.step = null;
    if (!hits.length) return say(chatId, `По запросу «${text.trim()}» никого не нашёл.`);
    const lines = hits.map((a) =>
      `${a.name || 'без имени'} — ${a.id}\n  ${roleTitle(a)}` +
      (a.addedAt ? `, добавлен ${a.addedAt}` : '')).join(`\n${RULE}\n`);
    return say(chatId, cut(`Нашёл ${hits.length}:\n${RULE}\n${lines}`, 3800));
  }

  // Номер человека для админки
  if (s.step === 'adm-await-id' && text) {
    if (!isAdmin(userId)) return noRight(chatId, userId);
    const mm = text.match(/^\s*(\d{4,15})\s*(.*)$/);
    if (!mm) return say(chatId, 'Не разобрал номер. Пришлите только цифры, при желании имя через пробел.');
    const id = Number(mm[1]);
    const name = (mm[2] || '').trim() || null;
    const role = ROLES[s.newRole] ? s.newRole : DEFAULT_ROLE;
    const res = addAccess({ id, name, role, by: userId });
    s.step = null;
    if (res === 'exists') await say(chatId, `${id} уже в списке.`);
    if (res === 'fail') return adminScreen(chatId, 'Не удалось сохранить список доступа, попробуйте ещё раз.');
    const req = requests.get(id);
    if (req?.status === 'pending') Object.assign(req, { status: 'approved', role, by: userId, decidedAt: Date.now() });
    s.newRole = null;
    return onAdmin(chatId, userId, 'adm:people', s);
  }

  // Номер SCR
  if (s.step === 'await-scr' && text) {
    const digits = text.replace(/\D/g, '');
    if (digits.length !== SCR_DIGITS) {
      // Ошибку шлём ОТДЕЛЬНЫМ сообщением, а не правкой экрана: правку человек не замечает,
      // она меняется вверху чата, а смотрит он вниз. Решение Эмиля от 07.09.2026.
      return say(chatId, `В номере должно быть семь цифр, а вы ввели ${digits.length}.\nНапример: 6512028`);
    }
    s.scr = digits;
    return afterScr(chatId, s);
  }

  return showMenu(chatId);
}

async function afterScr(chatId, s) {
  const userId = lastUser.get(chatId);
  let existing;
  try {
    existing = await findByScr(s.scr);
  } catch (e) {
    // Раньше сбой Диска здесь уходил только в журнал работы, а человек не получал ответа.
    console.error('   поиск по номеру не удался:', e.message);
    alertDisk(e);
    reset(chatId);
    return say(chatId, trouble(`Не удалось проверить номер SCR#${s.scr}`, diskTrouble(e)), rows(menuFor(userId)));
  }

  if (s.cmd === 'upload') {
    if (existing.length) {
      reset(chatId);
      const dup = existing.length > 1 ? `Внимание: записей с этим номером на Диске ${existing.length} — сообщите администратору.` : '';
      return say(chatId,
        card({ title: `ℹ️ Запись SCR#${s.scr} уже загружена`, path: existing[0].path, size: existing[0].size,
          created: existing[0].created,
          notes: ['Чтобы загрузить новую версию, выберите «Заменить видеозапись» — прежняя сохранится в архиве.', dup] }),
        rows(menuFor(userId)));
    }
    // Номер исправили после предупреждения о несовпадении — файл уже есть, повторно не просим.
    if (s.renum && s.pending?.att) {
      const att = s.pending.att;
      Object.assign(s, { renum: false, pending: null, step: 'await-file' });
      return onFile(chatId, userId, s, att);
    }
    s.step = 'await-file';
    return screen(chatId,
      `${flowHead(s, 'file')}\n${RULE}\nSCR#${s.scr} — принято.\n\nПришлите видеозапись файлом. Если отправить её как видео, мессенджер сожмёт качество.`,
      rows([HOME()]));
  }

  if (!existing.length) {
    // Записи нет, но, может быть, её удалили — тогда она в архиве и её можно вернуть.
    let archived = [];
    if (can(userId, 'versions')) { try { archived = await versionsOf(s.scr); } catch { /* без подсказки */ } }
    const extra = archived.length ? [btn(`🕘 В архиве версий: ${archived.length} — посмотреть`, 'ra:versions')] : [];
    s.rec = null;
    return say(chatId,
      `Записи SCR#${s.scr} нет. Проверьте номер или загрузите её через «Загрузить видеозапись».` +
      (archived.length ? '\n\nВ архиве есть прежние версии этой записи — её, видимо, удалили.' : ''),
      rows([...extra, ...menuFor(userId)]));
  }

  /* Несколько записей с одним номером. Раньше бот молча брал первую попавшуюся —
   * и мог выдать, заменить или перенести не ту. Теперь показывает все и даёт выбрать. */
  if (existing.length > 1) {
    s.step = 'pick';
    notifyAdmins(`dup:${s.scr}`, `⚠️ На Диске ${existing.length} записи с номером SCR#${s.scr}:\n` +
      existing.map((f) => `• ${ckey(f.path)}`).join('\n') + '\nЛишнюю стоит убрать.', { every: 24 * 60 * 60_000 });
    const list = existing.map((f, i) =>
      `${i + 1}) ${reportInline(f.path) || ckey(parentOf(f.path))} · ${f.name} · ${mb(f.size)}`).join('\n');
    const buttons = existing.map((f, i) =>
      btn(cut(`${i + 1}) ${reportInline(f.path) || f.name}`, 60), 'pick:' + keyFor(f)));
    buttons.push(HOME());
    return screen(chatId,
      `⚠️ Записей с номером SCR#${s.scr} несколько: ${existing.length}.\n${RULE}\n${list}\n${RULE}\nКакую взять?`,
      rows(buttons));
  }

  s.found = existing[0];
  return afterFound(chatId, s);
}

/** Запись выбрана — дальше по команде. */
async function afterFound(chatId, s) {
  const userId = lastUser.get(chatId);
  if (s.cmd === 'find') {
    const found = s.found;
    reset(chatId);
    return sendRecord(chatId, found, userId);
  }

  if (s.cmd === 'replace') {
    s.step = 'await-file';
    const comment = await meta.getComment(s.scr);
    return screen(chatId,
      `${stepTitle('♻️ Замена', 2, 3)}\n\n` +
      card({ scr: s.scr, path: s.found.path, size: s.found.size, created: s.found.created, comment,
        notes: ['Пришлите новую версию файлом. Прежняя сохранится в архиве — ничего не потеряется.'] }),
      rows([HOME()]));
  }

  if (s.cmd === 'move') {
    s.step = 'folder';
    s.path = [];
    s.page = 0;
    s.wasAt = report(s.found.path);
    await say(chatId, card({ title: '📁 Переносим запись', scr: s.scr, path: s.found.path, size: s.found.size }));
    return askFolder(chatId, s);
  }

  // Команда потерялась (например, пришли по старой кнопке после возврата в меню).
  // Без этой ветки функция просто заканчивалась и бот молчал.
  return showMenu(chatId, 'Не понял, что делаем с этим номером — выберите действие.', userId);
}

/** Отдать запись в чат. Файлом, а не видео: важен оригинал, а не проигрывание. */
async function sendRecord(chatId, found, userId) {
  const prev = sessions.get(chatId)?.mid;
  await drop(chatId, prev);                          // экран поиска заменяется самой записью
  const wait = await say(chatId, `Готовлю запись, это займёт до минуты`);
  try {
    const scr = (found.name.match(SCR_RE) || [])[1];
    const comment = scr ? await meta.getComment(scr) : null;
    // Кнопки едут на самом файле — отдельным сообщением меню только плодит экраны.
    const buttons = [
      ...(can(userId, 'browse') ? [btn('📋 Действия с записью', 'rec:' + keyFor(found))] : []),
      HOME(),
    ];
    // Байты записи идут через компьютер бота — поэтому таких выдач одновременно не больше HEAVY_MAX.
    await heavy(async () => sendFileFromUrl(chatId, {
      url: await downloadHref(found.path),
      filename: found.name,
      size: found.size,
      caption: card({ scr, path: found.path, comment }),
      buttons: rows(buttons),
    }));
    await drop(chatId, wait?.message?.body?.mid);    // «Готовлю запись» своё отработало
  } catch (e) {
    await drop(chatId, wait?.message?.body?.mid);
    console.error('   выдача записи не удалась:', e.message);
    alertDisk(e);
    const msg = e instanceof SendError ? 'Не удалось отправить запись в MAX, попробуйте ещё раз.' : diskTrouble(e);
    await say(chatId, trouble('Запись не отправлена', msg), rows(menuFor(lastUser.get(chatId))));
  }
}

async function downloadHref(path) {
  const r = await fetch(
    `https://cloud-api.yandex.net/v1/disk/resources/download?path=${encodeURIComponent(path)}`,
    { headers: { Authorization: `OAuth ${process.env.YANDEX_DISK_TOKEN}` }, signal: AbortSignal.timeout(60_000) },
  );
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.href) {
    // HTTP-код нужен дальше: по 401/403 администратору уходит оповещение про токен.
    throw Object.assign(new Error(`Диск не дал ссылку на скачивание (HTTP ${r.status})`), { status: r.status });
  }
  return j.href;
}

/* ---------- карточка записи: обзор, версии, комментарий, удаление ---------- */

/** Карточка записи с действиями по правам. Открывается из обзора и после поиска. */
async function openRecord(chatId, userId, s, f, { notice = '' } = {}) {
  if (!f?.path) return showMenu(chatId, 'Кнопка устарела — найдите запись заново.', userId);
  let st;
  try { st = await disk.stat(f.path, { fields: 'name,path,size,created' }); }
  catch (e) { alertDisk(e); return screen(chatId, trouble('Не удалось открыть запись', diskTrouble(e)), rows([HOME()])); }
  if (!st) {
    indexRemove(f.path);
    return screen(chatId, trouble('Записи здесь больше нет', 'Её переместили, заменили или удалили. Найдите её заново по номеру.'),
      rows([HOME()]));
  }
  const rec = { name: st.name, path: st.path || f.path, size: st.size ?? 0, created: st.created ?? null };
  const scr = (rec.name.match(SCR_RE) || [])[1];
  const comment = scr ? await meta.getComment(scr) : null;
  Object.assign(s, { rec, scr, step: 'record', view: null });
  const b = [btn('📥 Получить файл', 'ra:get')];
  if (can(userId, 'replace')) b.push(btn('♻️ Заменить', 'ra:replace'));
  if (can(userId, 'move')) b.push(btn('📁 Переместить', 'ra:move'));
  if (can(userId, 'versions')) b.push(btn('🕘 Версии', 'ra:versions'));
  if (can(userId, 'comment')) b.push(btn(comment ? '💬 Изменить комментарий' : '💬 Добавить комментарий', 'ra:comment'));
  if (can(userId, 'comment') && comment) b.push(btn('🧹 Убрать комментарий', 'ra:delcomment'));
  if (can(userId, 'delete')) b.push(btn('🗑 Удалить запись', 'ra:delete'));
  if (s.cmd === 'browse') b.push(btn('⬅️ К папке', 'ra:back'));
  b.push(HOME());
  return screen(chatId, card({ title: '🎞 Видеозапись', scr, path: rec.path, size: rec.size, created: rec.created,
    comment, notes: [notice] }), rows(b));
}

async function onRecordAction(chatId, userId, s, action) {
  if (action === 'versions') {
    if (!can(userId, 'versions')) return noRight(chatId, userId);
    if (!s.scr) return showMenu(chatId, 'Кнопка устарела — найдите запись заново.', userId);
    s.view = 'versions';
    s.page = 0;
    return showVersions(chatId, userId, s);
  }
  if (!s.rec) return showMenu(chatId, 'Кнопка устарела — найдите запись заново.', userId);
  const scr = s.scr;
  switch (action) {
    case 'open': return openRecord(chatId, userId, s, s.rec);
    case 'back': s.cmd = 'browse'; s.view = null; return askFolder(chatId, s);
    case 'get': return sendRecord(chatId, s.rec, userId);
    case 'replace':
      if (!can(userId, 'replace')) return noRight(chatId, userId);
      Object.assign(s, { cmd: 'replace', found: s.rec, pending: null });
      return afterFound(chatId, s);
    case 'move':
      if (!can(userId, 'move')) return noRight(chatId, userId);
      Object.assign(s, { cmd: 'move', found: s.rec });
      return afterFound(chatId, s);
    case 'comment':
      if (!can(userId, 'comment')) return noRight(chatId, userId);
      return askComment(chatId, s);
    case 'delcomment':
      if (!can(userId, 'comment')) return noRight(chatId, userId);
      try {
        await meta.setComment(scr, null, userId);
        journal.log({ userId, name: nameOf(userId), action: 'Комментарий убран', scr, where: reportInline(s.rec.path) });
        return openRecord(chatId, userId, s, s.rec, { notice: '🧹 Комментарий убран.' });
      } catch (e) {
        alertDisk(e);
        return say(chatId, trouble('Комментарий не убран', diskTrouble(e)));
      }
    case 'delete':
      if (!can(userId, 'delete')) return noRight(chatId, userId);
      s.step = 'confirm-delete';
      return screen(chatId, card({ title: `🗑 Удалить запись SCR#${scr}?`, path: s.rec.path, size: s.rec.size,
        created: s.rec.created,
        notes: ['Запись уйдёт в архив, а не исчезнет: вернуть её можно через «Версии».'] }),
      rows([btn('🗑 Да, удалить', 'go:delete'), btn('Отмена', 'ra:open'), HOME()]));
    default: return openRecord(chatId, userId, s, s.rec);
  }
}

/* Комментарий: дата показа, кто принимал, примечание. Хранится по номеру записи
 * и переживает перенос и замену. */
const COMMENT_MAX = 500;

function askComment(chatId, s) {
  s.step = 'await-comment';
  return screen(chatId,
    `💬 Комментарий к SCR#${s.scr}\n${RULE}\nНапишите его одним сообщением, до ${COMMENT_MAX} символов.\n` +
    'Например: «Показ 12.09, принимал Иванов, замечаний нет».',
    rows([btn('Отмена', 'ra:open'), HOME()]));
}

async function saveComment(chatId, userId, s, text) {
  if (!can(userId, 'comment')) return noRight(chatId, userId);
  if (!s.scr || !s.rec) return showMenu(chatId, 'Не понял, к какой записи комментарий — найдите её заново.', userId);
  const t = cut(text.replace(/\s+/g, ' ').trim(), COMMENT_MAX);
  try {
    await meta.setComment(s.scr, t, userId);
  } catch (e) {
    console.error('   комментарий не сохранён:', e.message);
    alertDisk(e);
    return say(chatId, trouble('Комментарий не сохранён', diskTrouble(e)));
  }
  journal.log({ userId, name: nameOf(userId), action: 'Комментарий', scr: s.scr, where: reportInline(s.rec.path), result: t });
  return openRecord(chatId, userId, s, s.rec, { notice: '💬 Комментарий сохранён.' });
}

/* История версий. Раньше архив существовал «на бумаге»: достать прежнюю версию можно было
 * только из веб-интерфейса Диска, зная путь BackUp/дата/номер/время. Теперь — список и
 * восстановление одной кнопкой, в безопасном порядке, как при замене. */
function parseVersion(f) {
  const segs = ckey(f.path).split('/').filter(Boolean);
  const i = segs.indexOf(BACKUP);
  const date = segs[i + 1] || '';
  const uid = Number(segs[i + 2]);
  const file = segs[segs.length - 1];
  const m = file.match(/^(\d{2})-(\d{2})-(\d{2}) (.*)$/);
  const rest = m ? m[4] : file;
  const kind = /^удалено /.test(rest) ? 'удалил' : /^незавершённая /.test(rest) ? 'незавершённая замена' : 'заменил';
  return { name: f.name, path: f.path, size: f.size, created: f.created,
    date, uid, time: m ? `${m[1]}:${m[2]}` : '', kind, sortKey: `${date} ${m ? m[1] + m[2] + m[3] : ''}` };
}

async function versionsOf(scr) {
  const all = await disk.findFiles(`SCR#${scr}`);
  return all
    .filter((f) => f.path.includes(`/${BACKUP}/`) && (f.name.match(SCR_RE) || [])[1] === scr)
    .map(parseVersion)
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey));
}

const VERSIONS_PAGE = 8;

async function showVersions(chatId, userId, s) {
  const scr = s.scr;
  let list, live;
  try { [list, live] = await Promise.all([versionsOf(scr), findByScr(scr)]); }
  catch (e) { alertDisk(e); return screen(chatId, trouble('Не удалось прочитать архив', diskTrouble(e)), rows([HOME()])); }
  s.view = 'versions';
  const back = s.rec ? [btn('⬅️ К записи', 'ra:open')] : [];
  if (!list.length) {
    return screen(chatId, `🕘 Версии SCR#${scr}\n${RULE}\nПрежних версий нет: запись не заменяли и не удаляли.`,
      rows([...back, HOME()]));
  }
  const { slice, nav, page } = paginate(list, s.page, VERSIONS_PAGE);
  s.page = page;
  const dd = (v) => (v.date ? v.date.split('-').reverse().join('.') : '');
  const now = live.length ? `Сейчас: ${reportInline(live[0].path)} · ${mb(live[0].size)}` : 'Сейчас записи нет — она удалена.';
  const lines = slice.map((v, i) => `${page * VERSIONS_PAGE + i + 1}) ${dd(v)} ${v.time} · ${v.kind}: ${nameOf(v.uid)} · ${mb(v.size)}`);
  const buttons = slice.map((v, i) => btn(`↩️ Восстановить ${page * VERSIONS_PAGE + i + 1})`, 'ver:' + keyFor(v)));
  return screen(chatId,
    `🕘 Версии SCR#${scr}\n${now}\n${RULE}\nДата — когда версию сменили или удалили, и кто это сделал:\n${lines.join('\n')}`,
    [...rows(buttons), ...nav, ...rows([...back, HOME()])]);
}

/** Куда встанет восстановленная версия: на место текущей, в исходную папку или в выбранную. */
async function confirmRestore(chatId, s) {
  const v = s.ver;
  if (!v || !s.scr) return showMenu(chatId, 'Кнопка устарела — откройте версии заново.');
  let live;
  try { live = await findByScr(s.scr); }
  catch (e) { alertDisk(e); return screen(chatId, trouble('Не удалось проверить запись', diskTrouble(e)), rows([HOME()])); }
  if (live.length > 1) {
    return screen(chatId, trouble('Не могу восстановить', `Записей SCR#${s.scr} сейчас несколько (${live.length}) — сначала уберите лишнюю.`),
      rows([HOME()]));
  }
  let note;
  if (live.length === 1) {
    s.restoreTo = parentOf(live[0].path);
    note = 'Текущая версия уйдёт в архив, на её место встанет выбранная.';
  } else if (s.cmd === 'restore' && s.path.length) {
    s.restoreTo = disk.joinPath(ROOT, ...s.path);
    note = 'Запись встанет в выбранную папку.';
  } else {
    const origin = await meta.getOrigin(v.path);
    if (origin) {
      s.restoreTo = parentOf(origin);
      note = 'Запись вернётся в папку, где лежала до удаления.';
    } else {
      // Откуда удалили — неизвестно (удаление было до этой версии бота): пусть человек выберет.
      Object.assign(s, { cmd: 'restore', path: [], page: 0, step: 'folder' });
      return askFolder(chatId, s);
    }
  }
  s.step = 'confirm-restore';
  const dd = v.date ? v.date.split('-').reverse().join('.') : '';
  return screen(chatId,
    card({ title: `🕘 Восстановить версию SCR#${s.scr}?`, path: s.restoreTo, size: v.size,
      notes: [`Версия: ${dd} ${v.time} (${v.kind}: ${nameOf(v.uid)})`, note, 'Архивная копия останется в архиве.'] }),
    rows([btn('✅ Восстановить', 'go:restore'), btn('⬅️ К версиям', 'ra:versions'), HOME()]));
}

async function doRestore(chatId, userId, s) {
  const v = s.ver, scr = s.scr, folder = s.restoreTo;
  if (!v || !scr || !folder || s.step !== 'confirm-restore') return showMenu(chatId, 'Кнопка устарела — откройте версии заново.', userId);
  if (!can(userId, 'versions')) return noRight(chatId, userId);
  if (!scrLock(scr, 'восстановление')) return say(chatId, busyText(scr));
  const target = `${ckey(folder)}/SCR#${scr}${extOf(v.name)}`;
  const landing = `${target}.new`;
  try {
    if (!(await disk.stat(v.path, { fields: 'path' }))) {
      reset(chatId);
      return say(chatId, 'Этой версии в архиве уже нет.', rows(menuFor(userId)));
    }
    const live = await findByScr(scr);
    if (live.length > 1) {
      reset(chatId);
      return say(chatId, trouble('Не могу восстановить', `Записей SCR#${scr} сейчас несколько — сначала уберите лишнюю.`), rows(menuFor(userId)));
    }
    inFlightPaths.add(ckey(landing));
    // Копия, а не перенос: архивная версия остаётся в архиве.
    await disk.copy(v.path, landing);
    let backup = null;
    if (live.length) {
      backup = await archive(userId, live[0]);
      indexRemove(live[0].path);
    }
    try {
      await disk.move(landing, target);
    } catch (e) {
      if (backup) { try { await disk.move(backup, live[0].path); indexAdd(live[0]); } catch { /* останется в архиве */ } }
      throw e;
    }
    const st = await disk.stat(target);
    if (st) indexAdd({ name: st.name, path: st.path || target, size: st.size, created: st.created });
    invalidateFolders(folder, live[0] ? parentOf(live[0].path) : null);
    const dd = v.date ? v.date.split('-').reverse().join('.') : '';
    journal.log({ userId, name: nameOf(userId), action: 'Восстановление версии', scr, where: reportInline(target),
      result: `версия от ${dd} ${v.time}${backup ? '; прежняя в архиве' : ''}` });
    reset(chatId);
    return say(chatId,
      card({ title: '↩️ Версия восстановлена', scr, path: target, size: st?.size,
        notes: backup ? [`Прежняя версия сохранена в архиве:\n${ckey(backup)}`] : [] }),
      rows(menuFor(userId)));
  } catch (e) {
    console.error('   восстановление не удалось:', e.message);
    alertDisk(e);
    reset(chatId);
    return say(chatId, trouble('Не удалось восстановить версию', diskTrouble(e)), rows(menuFor(userId)));
  } finally {
    scrUnlock(scr);
    inFlightPaths.delete(ckey(landing));
  }
}

/* Удаление — только администратор, и только в архив: настоящего удаления в боте нет. */
async function doDelete(chatId, userId, s) {
  const f = s.rec, scr = s.scr;
  if (!f || !scr || s.step !== 'confirm-delete') return showMenu(chatId, 'Кнопка устарела — найдите запись заново.', userId);
  if (!can(userId, 'delete')) return noRight(chatId, userId);
  if (!scrLock(scr, 'удаление')) return say(chatId, busyText(scr));
  try {
    if (!(await disk.stat(f.path, { fields: 'path' }))) {
      reset(chatId);
      return say(chatId, 'Записи здесь уже нет — её переместили или удалили.', rows(menuFor(userId)));
    }
    const dest = await archive(userId, f, 'удалено');
    indexRemove(f.path);
    invalidateFolders(parentOf(f.path));
    journal.log({ userId, name: nameOf(userId), action: 'Удаление видеозаписи', scr, where: reportInline(f.path),
      result: 'в архиве: ' + ckey(dest) });
    reset(chatId);
    return say(chatId,
      card({ title: '🗑 Запись удалена', scr, path: f.path, size: f.size,
        notes: ['Она в архиве. Вернуть: «Найти по номеру SCR» → «В архиве версий» → «Восстановить».'] }),
      rows(menuFor(userId)));
  } catch (e) {
    console.error('   удаление не удалось:', e.message);
    alertDisk(e);
    reset(chatId);
    return say(chatId, trouble('Не удалось удалить запись', diskTrouble(e)), rows(menuFor(userId)));
  } finally {
    scrUnlock(scr);
  }
}

/* ---------- сверка с реестром ---------- */

const decodeText = (buf) => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1251').decode(buf); }   // CSV из старого Excel
};

async function onRegistry(chatId, userId, s, att) {
  if (!isAdmin(userId)) return noRight(chatId, userId);
  const name = att.filename || '';
  const ext = extOf(name);
  if (!['.xlsx', '.csv', '.txt'].includes(ext)) {
    return say(chatId, 'Пришлите таблицу .xlsx или .csv. Старый формат .xls не подходит — пересохраните файл в Excel как .xlsx.');
  }
  if (Number(att.size || 0) > 20 * 1024 * 1024) return say(chatId, 'Файл реестра больше 20 МБ — это не похоже на список номеров.');
  if (!att.payload?.url) return say(chatId, 'Не вижу вложения. Пришлите реестр файлом.');
  const wait = await say(chatId, '📋 Сверяю реестр с Диском…');
  try {
    const r = await fetch(att.payload.url, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`MAX не отдал файл: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const cells = ext === '.xlsx' ? readXlsxCells(buf) : [decodeText(buf)];
    const wanted = new Set();
    for (const c of cells) for (const m of String(c).matchAll(/(?<!\d)(\d{7})(?!\d)/g)) wanted.add(m[1]);
    if (!wanted.size) {
      await drop(chatId, wait?.message?.body?.mid);
      return say(chatId, 'В файле не нашёл ни одного семизначного номера SCR.', rows([BACK()]));
    }
    // Индекс должен быть полным: дожидаемся прогрева, если он идёт или ещё не был.
    if (warming) await warming;
    if (!scrIndex.size) await warmTree();

    const place = (f) => { const p = parts(f.path); return [p.gk || '', p.op || '', p.napr || '', p.sys || '', f.name]; };
    const rowsOut = [];
    let have = 0, missing = 0, extra = 0;
    for (const n of [...wanted].sort()) {
      const hit = scrIndex.get(n);
      if (hit?.length) { have++; rowsOut.push([`SCR#${n}`, hit.length > 1 ? `есть (${hit.length} шт.)` : 'есть', ...place(hit[0])]); }
      else { missing++; rowsOut.push([`SCR#${n}`, 'нет на Диске', '', '', '', '', '']); }
    }
    for (const [n, list] of [...scrIndex.entries()].sort()) {
      if (wanted.has(n)) continue;
      extra++;
      rowsOut.push([`SCR#${n}`, 'нет в реестре', ...place(list[0])]);
    }
    const summary = `📋 Сверка с реестром «${name}»\n${RULE}\n` +
      `Номеров в реестре: ${wanted.size}\nЕсть на Диске: ${have}\nНет на Диске: ${missing}\n` +
      `На Диске, но не в реестре: ${extra}`;
    const buffer = writeXlsx([{ name: 'Сверка', header: ['SCR', 'Статус', 'ГК', 'ОП', 'Направление', 'Система', 'Файл'], rows: rowsOut }]);
    await drop(chatId, wait?.message?.body?.mid);
    await sendBuffer(chatId, { buffer, filename: `Сверка ${new Date().toLocaleDateString('ru-RU').replace(/\./g, '-')}.xlsx`, caption: summary });
    s.step = null;
    return adminScreen(chatId);
  } catch (e) {
    await drop(chatId, wait?.message?.body?.mid);
    console.error('   сверка с реестром не удалась:', e.message);
    alertDisk(e);
    return say(chatId, trouble('Сверка не получилась', /xlsx|zip/.test(e.message)
      ? 'Файл не читается как таблица Excel. Пересохраните его в Excel как .xlsx и пришлите снова.'
      : diskTrouble(e)), rows([BACK()]));
  }
}

/* ---------- загрузка и замена ---------- */

/* Имя версии в архиве. Дата и время — оба по часам компьютера бота: раньше дата бралась
 * в UTC, а время местное, и замены с полуночи до трёх ночи по Москве попадали в папку
 * вчерашнего дня. */
function backupPath(userId, name) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const clock = `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  return disk.joinPath(ROOT, BACKUP, stamp, String(userId), `${clock} ${name}`);
}

/** Убрать запись в архив и запомнить, откуда, — чтобы восстановить на прежнее место. */
async function archive(userId, f, label = '') {
  const dest = backupPath(userId, label ? `${label} ${f.name}` : f.name);
  await disk.move(f.path, dest);
  meta.setOrigin(dest, f.path);
  return dest;
}

// PRIEMKA_TEST_* — только для автотестов, чтобы не ждать по 10 минут; в .env их не ставят.
const UPLOAD_WAIT_MS = Number(process.env.PRIEMKA_TEST_UPLOAD_WAIT_MS) || 10 * 60_000;  // столько человек ждёт в чате
const UPLOAD_WAIT_BG_MS = 60 * 60_000;   // столько бот дожидается большой загрузки в фоне
const BG_POLL_MS = Number(process.env.PRIEMKA_TEST_BG_POLL_MS) || 15_000;
const PROGRESS_MS = Number(process.env.PRIEMKA_TEST_PROGRESS_MS) || 20_000;   // как часто обновлять «прошло …»
const PENDING_TTL_MS = 30 * 60_000;      // файл, ждущий подтверждения, — не дольше получаса
const background = new Set();            // фоновые доливки — чтобы тесты могли их дождаться

/** Номер в имени файла: «SCR#6512028.mp4» или просто семь цифр подряд. */
function numberInName(name) {
  const s = String(name || '');
  return (s.match(SCR_RE) || s.match(/(?<!\d)(\d{7})(?!\d)/) || [])[1] || null;
}

async function onFile(chatId, userId, s, attachment) {
  if (s.step === 'await-registry') return onRegistry(chatId, userId, s, attachment);
  if (s.step !== 'await-file' || !s.scr) {
    return showMenu(chatId, 'Сначала выберите действие, а потом пришлите запись.');
  }
  // Права проверяем ещё раз именно здесь, на шаге, который меняет Диск: роль могли
  // отнять, пока человек выбирал папки.
  if (!can(userId, s.cmd)) {
    reset(chatId);
    return say(chatId, 'Это действие вам больше недоступно — права изменились. Обратитесь к администратору.',
      rows(menuFor(userId)));
  }
  const url = attachment.payload?.url;
  const size = Number(attachment.size || 0);
  const srcName = attachment.filename || 'video.mp4';

  const ext = extOf(srcName);
  if (attachment.type === 'file' && ext && !VIDEO_EXT.has(ext)) {
    return say(chatId,
      `Это не похоже на видеозапись: файл «${srcName}».\n\n` +
      `Пришлите запись в одном из форматов: ${[...VIDEO_EXT].map((e) => e.slice(1)).join(', ')}.`);
  }

  if (!url) {
    return say(chatId, 'Не вижу вложения. Пришлите запись файлом.', rows(menuFor(lastUser.get(chatId))));
  }

  const file = { url, size, name: srcName, at: Date.now(), att: attachment };
  /* Сверка номера с именем файла: «ввели 6512028, а файл — SCR#6512029.mp4» — типичная
   * ошибка, когда видео загружают не под тем номером. Нет цифр в имени — не спрашиваем. */
  const inName = numberInName(srcName);
  const mismatch = inName && inName !== s.scr;
  const warn = mismatch ? `⚠️ В имени файла номер ${inName}, а вы указали SCR#${s.scr}.` : '';

  // Замена — всегда с подтверждением: «было → станет».
  if (s.cmd === 'replace' && s.found) {
    Object.assign(s, { pending: file, step: 'confirm-file' });
    return screen(chatId,
      `${stepTitle('♻️ Замена', 3, 3)}\nПроверьте перед заменой\n${RULE}\n` +
      `БЫЛО: ${s.found.name} · ${mb(s.found.size)}${s.found.created ? ` · загружена ${fmtDate(s.found.created)}` : ''}\n` +
      `СТАНЕТ: ${srcName}${size ? ` · ${mb(size)}` : ''}\n` +
      `${report(s.found.path)}\n${RULE}\n` +
      (warn ? `${warn}\n` : '') +
      'Прежняя версия уйдёт в архив — её можно будет вернуть.',
      rows([btn(`✅ Заменить SCR#${s.scr}`, 'go:file'), HOME()]));
  }

  if (mismatch) {
    Object.assign(s, { pending: file, step: 'confirm-file' });
    return screen(chatId,
      `⚠️ Проверьте номер\n\nВы указали номер SCR#${s.scr}, а файл называется «${srcName}» — в имени номер ${inName}.\n` +
      `${RULE}\nВсё верно?`,
      rows([btn(`✅ Да, загрузить как SCR#${s.scr}`, 'go:file'), btn('✏️ Ввести другой номер', 'go:renum'), HOME()]));
  }

  return doUpload(chatId, userId, s, file);
}

/** Человек подтвердил файл (замена или несовпадение номера) — грузим. */
async function confirmedFile(chatId, userId, s) {
  if (s.step !== 'confirm-file' || !s.pending || !s.scr) return showMenu(chatId, 'Кнопка устарела — начните заново.', userId);
  if (Date.now() - s.pending.at > PENDING_TTL_MS) {
    // Ссылка MAX на присланный файл живёт ограниченное время — не рискуем, просим заново.
    Object.assign(s, { pending: null, step: 'await-file' });
    return say(chatId, 'С тех пор как вы прислали файл, прошло больше получаса. Пришлите его, пожалуйста, ещё раз.');
  }
  if (!can(userId, s.cmd)) {
    reset(chatId);
    return say(chatId, 'Это действие вам больше недоступно — права изменились. Обратитесь к администратору.', rows(menuFor(userId)));
  }
  const file = s.pending;
  s.pending = null;
  return doUpload(chatId, userId, s, file);
}

const elapsed = (ms) => {
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec} с` : `${Math.floor(sec / 60)} мин ${sec % 60} с`;
};
const progressText = (scr, ms) =>
  `⏳ Загружаю SCR#${scr} · прошло ${elapsed(ms)}\nДиск принимает файл с серверов MAX; большие записи — до нескольких минут.`;

async function doUpload(chatId, userId, s, file) {
  const { url, size, name: srcName } = file;
  const cmd = s.cmd;
  const scr = s.scr;
  const found = s.found;
  const path = [...s.path];
  // При ЗАМЕНЕ новая версия встаёт ровно туда, где лежала старая: опросник в этой команде
  // не проходится, поэтому s.path пуст, и раньше файл улетал в корень /Видеопоказы.
  // Расширение берём у НОВОГО файла — прислать могут .mov вместо .mp4.
  const replacing = cmd === 'replace' && !!found;
  const target = replacing
    ? parentOf(found.path) + '/' + `SCR#${scr}${extOf(srcName)}`
    : disk.joinPath(ROOT, ...path, `SCR#${scr}${extOf(srcName)}`);
  /* При замене порядок ВАЖЕН: сначала кладём новую версию во временное имя, и только
   * когда она реально на Диске — убираем старую в архив и ставим новую на её место.
   * Раньше старая уезжала в архив ПЕРВОЙ: любой сбой заливки — и человек оставался
   * без записи вообще (в поиске её уже нет, новой ещё нет). Поймано ревизией 07.09.2026. */
  const landing = replacing ? `${target}.new` : target;
  const ctx = { chatId, userId, cmd, scr, found, target, landing, replacing, path };

  if (!scrLock(scr, replacing ? 'замена' : 'загрузка')) return say(chatId, busyText(scr));
  let detached = false;
  let stopProgress = async () => {};
  try {
    // Хватит ли места — до загрузки, а не 507-м после получаса ожидания.
    if (size > 0) {
      let free = null;
      try { free = await disk.freeSpace(); } catch { /* проверка не удалась — грузим как раньше */ }
      if (free !== null && free < size) {
        reset(chatId);
        notifyAdmins('disk-full', `⚠️ На Яндекс.Диске не хватает места: свободно ${mb(free)}, ` +
          `а прислали запись на ${mb(size)}. Загрузки не проходят.`);
        return say(chatId, trouble('На Диске не хватает места',
          `Запись весит ${mb(size)}, а свободно ${mb(free)}. Загрузка не начиналась. Сообщите администратору.`),
        rows(menuFor(userId)));
      }
    }

    // Пока человек выбирал файл, состояние Диска могло измениться — перепроверяем под замком.
    if (cmd === 'upload') {
      const now = await findByScr(scr);
      if (now.length) {
        reset(chatId);
        return say(chatId,
          card({ title: `ℹ️ Запись SCR#${scr} уже загружена`, path: now[0].path,
            notes: ['Пока вы присылали файл, её загрузил другой пользователь.',
              'Чтобы загрузить новую версию, выберите «Заменить видеозапись».'] }),
          rows(menuFor(userId)));
      }
    }
    if (replacing && !(await disk.stat(found.path, { fields: 'path' }))) {
      reset(chatId);
      return say(chatId, `Прежняя версия SCR#${scr} уже перемещена или заменена другим пользователем — начните заново.`,
        rows(menuFor(userId)));
    }

    /* Ход загрузки: вместо одного «Загружаю…» сообщение обновляется само — видно, что бот
     * работает, а не завис. Процентов нет: Диск их не сообщает, только «идёт» или «готово». */
    const startedAt = Date.now();
    const prog = await say(chatId, progressText(scr, 0));
    const progMid = prog?.message?.body?.mid;
    const timer = setInterval(() => {
      if (!progMid) return;
      api('PUT', '/messages', { query: { message_id: progMid }, body: { text: progressText(scr, Date.now() - startedAt) } })
        .catch(() => { /* не обновилось — не страшно */ });
    }, PROGRESS_MS);
    timer.unref?.();
    stopProgress = async () => { clearInterval(timer); stopProgress = async () => {}; await drop(chatId, progMid); };

    inFlightPaths.add(ckey(landing));
    // Папку заводим для РОДИТЕЛЯ файла: от самого пути файла Диск создаёт каталог
    // с именем «SCR#….mp4», и заливка туда же падает с 409.
    await disk.ensureFolder(parentOf(target));
    // Яндекс качает файл с серверов MAX сам — байты через компьютер бота не идут.
    const href = await disk.uploadFromUrl(url, landing);

    try {
      await disk.waitOperation(href, { timeoutMs: UPLOAD_WAIT_MS });
    } catch (e) {
      if (e?.code !== 'timeout') throw e;
      /* Большое видео Диск принимает дольше 10 минут. Раньше человек получал «ошибку»,
       * хотя файл потом спокойно долетал. Теперь бот честно говорит «ещё идёт», отпускает
       * человека и дожидается результата в фоне. Замок на номер держится до конца. */
      detached = true;
      await stopProgress();
      reset(chatId);
      await say(chatId,
        `⏳ Загрузка SCR#${scr} ещё идёт — большой файл Диск принимает дольше обычного.\n` +
        'Когда закончится, пришлю результат. Пока можно пользоваться ботом.', rows(menuFor(userId)));
      const job = (async () => {
        try {
          await disk.waitOperation(href, { timeoutMs: UPLOAD_WAIT_BG_MS, initialDelayMs: BG_POLL_MS, maxDelayMs: Math.max(BG_POLL_MS, 60_000) });
          const done = await finishUpload(ctx);
          await say(chatId, uploadDoneText(ctx, done), uploadDoneButtons(ctx, done));
        } catch (err) {
          await uploadFailed(ctx, err);
        } finally {
          scrUnlock(scr);
          inFlightPaths.delete(ckey(landing));
        }
      })();
      background.add(job);
      job.finally(() => background.delete(job));
      return;
    }

    await stopProgress();
    const done = await finishUpload(ctx);
    reset(chatId);
    return say(chatId, uploadDoneText(ctx, done), uploadDoneButtons(ctx, done));
  } catch (e) {
    await stopProgress();
    reset(chatId);
    return uploadFailed(ctx, e);
  } finally {
    if (!detached) { scrUnlock(scr); inFlightPaths.delete(ckey(landing)); }
  }
}

/** Файл на Диске — довести дело до конца: архив прежней версии, индекс, журнал. */
async function finishUpload({ userId, cmd, scr, found, target, landing, replacing, path }) {
  let backup = null;
  if (replacing) {
    // время в имени: иначе вторая замена той же записи за сутки падала на занятом пути
    backup = await archive(userId, found);
    try {
      await disk.move(landing, target);
    } catch (e) {
      // Новая версия не встала на место — возвращаем прежнюю, чтобы запись не пропала из поиска.
      try { await disk.move(backup, found.path); } catch { /* останется в архиве — сообщим ниже */ }
      throw e;
    }
  }

  const meta = await disk.stat(target);
  if (!meta) throw new Error(`после загрузки файла нет на Диске: ${ckey(target)}`);
  invalidateFolders(parentOf(target), replacing ? parentOf(found.path) : null);
  if (replacing) indexRemove(found.path);
  indexAdd({ name: meta.name, path: meta.path || target, size: meta.size, created: meta.created });
  // «В прошлую папку» и «Ещё запись сюда» — по папке последней ЗАГРУЗКИ человека.
  if (cmd === 'upload' && path?.length) { lastPaths.set(userId, [...path]); saveState(); }

  journal.log({
    userId, name: nameOf(userId),
    action: cmd === 'replace' ? 'Замена видеозаписи' : 'Загрузка видеозаписи',
    scr, where: reportInline(target),
    result: cmd === 'replace' ? 'прежняя версия в архиве' : 'успешно',
  });
  return { meta, backup };
}

function uploadDoneText({ cmd, scr, target }, { meta, backup }) {
  return card({
    title: cmd === 'replace' ? '♻️ Видеозапись заменена' : '✅ Видеозапись загружена',
    scr, path: target, size: meta.size,
    notes: cmd === 'replace' ? [`Прежняя версия сохранена в архиве:\n${ckey(backup || '')}`] : [],
  });
}

/** После загрузки: «Ещё запись сюда», комментарий — и обычное меню. */
function uploadDoneButtons({ cmd, userId }, { meta }) {
  const rec = { name: meta.name, path: meta.path, size: meta.size, created: meta.created };
  const extra = [];
  if (cmd === 'upload') extra.push(btn('📤 Ещё запись сюда', 'again'));
  if (can(userId, 'comment')) extra.push(btn('💬 Добавить комментарий', 'cmt:' + keyFor(rec)));
  return rows([...extra, ...menuFor(userId)]);
}

async function uploadFailed({ chatId, userId, cmd, scr, target }, e) {
  journal.log({
    userId, name: nameOf(userId),
    action: cmd === 'replace' ? 'Замена видеозаписи' : 'Загрузка видеозаписи',
    scr, where: reportInline(target), result: 'ОШИБКА: ' + String(e?.message || e).slice(0, 120),
  });
  console.error('   загрузка не удалась:', e?.message || e);
  if ([401, 403, 507].includes(e?.status)) alertDisk(e);
  else {
    notifyAdmins(`upload:${scr}`, `⚠️ Не удалась ${cmd === 'replace' ? 'замена' : 'загрузка'} SCR#${scr} ` +
      `(${nameOf(userId)}).\n${String(e?.message || e).slice(0, 300)}`);
  }
  try {
    return await say(chatId, trouble('Не удалось загрузить запись', diskTrouble(e)), rows(menuFor(userId)));
  } catch (err) { console.error('   не смог сообщить об ошибке загрузки:', err.message); }
}

async function doMove(chatId, userId, s) {
  const scr = s.scr;
  /* Кнопки живут в истории чата: по старой можно прийти с пустой сессией (тогда падало
   * «Cannot read properties of null») или уже начав другой перенос — и тогда запись
   * уезжала в корень мимо структуры, потому что s.path пуст. Поймано ревизией. */
  if (!s.found || !s.scr || !s.path.length) {
    return showMenu(chatId, 'Кнопка устарела — начните перенос заново.', lastUser.get(chatId));
  }
  if (!can(userId, 'move')) {
    reset(chatId);
    return say(chatId, 'Это действие вам больше недоступно — права изменились. Обратитесь к администратору.',
      rows(menuFor(userId)));
  }
  if (!scrLock(scr, 'перенос')) return say(chatId, busyText(scr));
  const found = s.found;
  const dest = disk.joinPath(ROOT, ...s.path, `SCR#${s.scr}${extOf(found.name)}`);
  try {
    /* Перенос «сам в себя» Диск отбивает 409-м с текстом про несуществующий путь —
     * человеку это читалось как поломка. Ловим до обращения к API. */
    if (ckey(found.path).replace(/\/+/g, '/') === ckey(dest).replace(/\/+/g, '/')) {
      reset(chatId);
      return say(chatId,
        card({ title: 'ℹ️ Запись уже лежит в этой папке — переносить некуда', scr, path: dest }),
        rows(menuFor(lastUser.get(chatId))));
    }

    await disk.move(found.path, dest);
    invalidateFolders(parentOf(found.path), parentOf(dest));
    indexRemove(found.path);
    indexAdd({ name: found.name, path: dest, size: found.size, created: found.created });
    journal.log({
      userId, name: nameOf(userId),
      action: 'Перемещение видеозаписи', scr,
      where: reportInline(dest), result: 'из: ' + reportInline(found.path),
    });
    const was = s.wasAt || '';
    reset(chatId);
    return say(chatId,
      card({ title: '📁 Видеозапись перемещена', scr, path: dest, size: found.size,
        notes: was ? [`Было:\n${was}`] : [] }),
      rows(menuFor(lastUser.get(chatId))));
  } catch (e) {
    // Сырой ответ Диска — простыня с путями и английским текстом: она уходит в лог,
    // а человеку остаётся короткая причина.
    console.error('   перемещение не удалось:', e.message);
    alertDisk(e);
    reset(chatId);
    const why =
      e.code === 'DiskResourceAlreadyExistsError' ? 'В этой папке уже есть запись с таким номером.'
      : e.status === 409 ? 'Диск не принял перемещение по этому пути.'
      : e.status === 404 ? 'Запись не найдена — возможно, её уже переместили.'
      : 'Не получилось связаться с Диском, попробуйте ещё раз.';
    return say(chatId, trouble('Не удалось переместить запись', why), rows(menuFor(lastUser.get(chatId))));
  } finally {
    scrUnlock(scr);
  }
}

/* Брошенная замена: администратор решает, что с ней делать. Ничего не удаляется —
 * «убрать» значит переложить в архив. */
async function onOrphan(chatId, userId, payload) {
  const [, action, key] = payload.split(':');
  const path = choices.get(key);
  if (!path) return say(chatId, 'Кнопка устарела: бот перезапускался. Незавершённая замена, если она ещё есть, ' +
    'будет показана снова после следующего прогрева.');
  const name = String(path).split('/').pop();
  const m = name.match(SCR_RE);
  const scr = m?.[1];
  if (!scr) return say(chatId, 'Не разобрал номер записи в имени файла.');
  if (!scrLock(scr, 'разбор незавершённой замены')) return say(chatId, busyText(scr));
  try {
    if (!(await disk.stat(path, { fields: 'path' }))) {
      return say(chatId, `Файла ${name} уже нет на Диске — разбирать нечего.`);
    }
    if (action === 'arc') {
      const dest = await archive(userId, { name: name.replace(/\.new$/i, ''), path }, 'незавершённая');
      journal.log({ userId, name: nameOf(userId), action: 'Незавершённая замена — в архив', scr,
        where: reportInline(path), result: ckey(dest) });
      return say(chatId, `📦 Убрано в архив:\n${ckey(dest)}`);
    }
    // Завершить: прежняя версия — в архив, временная — на её место. Только если однозначно,
    // что именно заменяем: ровно одна запись с этим номером и в той же папке.
    const target = String(path).replace(/\.new$/i, '');
    const live = await findByScr(scr);
    const same = live.filter((f) => ckey(parentOf(f.path)) === ckey(parentOf(target)));
    if (live.length > 1 || (live.length === 1 && !same.length)) {
      return say(chatId, `Не могу завершить замену автоматически: записи SCR#${scr} лежат в других папках ` +
        `(${live.length}). Разберите вручную на Диске или уберите временный файл в архив.`);
    }
    let backup = null;
    if (live.length) {
      backup = await archive(userId, live[0]);
      indexRemove(live[0].path);
    }
    await disk.move(path, target);
    const meta = await disk.stat(target);
    if (meta) indexAdd({ name: meta.name, path: meta.path || target, size: meta.size });
    invalidateFolders(parentOf(target));
    journal.log({ userId, name: nameOf(userId), action: 'Завершение замены', scr,
      where: reportInline(target), result: backup ? 'прежняя версия в архиве' : 'прежней версии не было' });
    return say(chatId, `♻️ Замена SCR#${scr} завершена.\n\n${report(target, { scr, size: meta?.size })}` +
      (backup ? `\n\nПрежняя версия сохранена:\n${ckey(backup)}` : ''));
  } catch (e) {
    console.error('   разбор незавершённой замены не удался:', e.message);
    alertDisk(e);
    return say(chatId, `Не получилось.\n${diskTrouble(e)}`);
  } finally {
    scrUnlock(scr);
  }
}


/* Маркер позиции в ленте событий — В ФАЙЛЕ, а не только в памяти.
 * Замерено 07.09.2026: без него перезапуск бота ТЕРЯЕТ накопленные события —
 * MAX на запрос без маркера отдаёт только самое последнее обновление, остальные пропадают. */
const MARKER_FILE = dataFile('marker.json');

function loadMarker() {
  try { return JSON.parse(readFileSync(MARKER_FILE, 'utf8')).marker ?? null; }
  catch { return null; }
}
function saveMarker(m) {
  if (m == null) return;
  try { writeFileSync(MARKER_FILE, JSON.stringify({ marker: m, at: new Date().toISOString() })); }
  catch (e) { console.error('не смог сохранить маркер:', e.message); }
}

let marker = loadMarker();
let stopping = false;

/** Чат, к которому относится событие, — по нему события раскладываются по очередям. */
function chatOf(u) {
  if (u.update_type === 'message_callback') return u.message?.recipient?.chat_id ?? u.callback?.user?.user_id;
  if (u.update_type === 'message_created') return u.message?.recipient?.chat_id;
  if (u.update_type === 'bot_started') return u.chat_id;
  return null;
}

/** Разбор одного события — то, что раньше делал цикл опроса прямо у себя внутри. */
async function handleUpdate(u) {
  const at = new Date(u.timestamp || Date.now()).toLocaleTimeString('ru-RU');
  const t0 = Date.now();
  try {
    if (u.update_type === 'message_callback') {
      console.log(`${at} кнопка: ${u.callback?.payload}`);
      await onCallback(u);
      console.log(`         обработано за ${Date.now() - t0} мс`);
    } else if (u.update_type === 'message_created') {
      const t = u.message?.body?.text || (u.message?.body?.attachments?.[0]?.type ?? '');
      console.log(`${at} сообщение: ${String(t).slice(0, 60)}`);
      await onMessage(u);
      console.log(`         обработано за ${Date.now() - t0} мс`);
    } else if (u.update_type === 'bot_started') {
      // userId берём из события: без него меню собралось бы для роли по умолчанию,
      // и администратор при первом запуске не увидел бы свою кнопку.
      const uid = u.user?.user_id ?? null;
      console.log(`${at} запуск бота пользователем ${uid ?? '?'}`);
      if (uid) lastUser.set(u.chat_id, uid);
      if (uid && ADMINS.includes(uid)) adminChats.set(uid, u.chat_id);
      if (uid && !allowed(uid)) { await denied(u.chat_id, uid); }
      else await showMenu(u.chat_id, 'Бот хранит видеозаписи показов работ по контрактам.', uid);
    }
  } catch (e) {
    console.error(`${at} ошибка обработки:`, e.message);
  }
  saveState();
}

/** Событие — в очередь его чата; цикл опроса дальше не ждёт. */
const dispatch = (u) => enqueue(chatOf(u), () => handleUpdate(u));

/* Проверки здоровья: место на Диске, срок токена, размер bot.log. Раз в час; каждое
 * оповещение — не чаще раза в сутки. Любой сбой здесь только пишется в журнал работы. */
const DAY_MS = 24 * 60 * 60_000;
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

async function healthTick() {
  try {
    const free = await disk.freeSpace();
    if (free < LOW_SPACE_BYTES) {
      notifyAdmins('space-low', `⚠️ На Яндекс.Диске осталось мало места: ${(free / 1024 ** 3).toFixed(1).replace('.', ',')} ГБ.`,
        { every: DAY_MS });
    }
  } catch (e) {
    console.error('   проверка места на Диске не удалась:', e.message);
    alertDisk(e);
  }

  if (YANDEX_TOKEN_ISSUED) {
    const issued = Date.parse(YANDEX_TOKEN_ISSUED);
    if (Number.isFinite(issued)) {
      const left = Math.ceil((issued + YANDEX_TOKEN_DAYS * DAY_MS - Date.now()) / DAY_MS);
      if (left <= 30) {
        notifyAdmins('token-age', left > 0
          ? `🔑 Токен Яндекс.Диска истекает примерно через ${left} дн. (выдан ${YANDEX_TOKEN_ISSUED}). ` +
            'Получите новый и обновите .env: остановить бота, удалить .env, запустить setup.cmd.'
          : `🔑 Срок токена Яндекс.Диска, по расчёту, уже вышел (выдан ${YANDEX_TOKEN_ISSUED}). ` +
            'Если бот ещё работает — обновите YANDEX_TOKEN_ISSUED в .env; если нет — получите новый токен.',
        { every: DAY_MS });
      }
    } else {
      console.error(`   YANDEX_TOKEN_ISSUED=${YANDEX_TOKEN_ISSUED} — не дата, ждём вид 2026-09-07`);
    }
  }

  rotateLogIfNeeded();
}

/* bot.log пишет start-bot.cmd, пока бот работает, — переименовать файл на ходу нельзя.
 * Поэтому, когда журнал перерос 10 МБ, бот глубокой ночью, если ничем не занят, сам
 * завершается, а start-bot.cmd через 10 секунд переносит журнал в архив и запускает его
 * снова. Только под start-bot.cmd (он ставит PRIEMKA_SUPERVISED=1): запущенный руками
 * из консоли бот так не делает — его некому было бы поднять. */
function rotateLogIfNeeded() {
  if (process.env.PRIEMKA_SUPERVISED !== '1') return;
  let size = 0;
  try { size = statSync(join(BOT_DIR, 'bot.log')).size; } catch { return; }
  const hour = new Date().getHours();
  const idle = scrBusy.size === 0 && heavyNow === 0 && chatQueues.size === 0 && background.size === 0;
  if (size < LOG_ROTATE_BYTES || hour < 3 || hour >= 5 || !idle) return;
  console.log(`bot.log вырос до ${(size / 1024 / 1024).toFixed(0)} МБ — плановый перезапуск для переноса журнала в архив`);
  writeState({ plannedRestart: true });
  saveMarker(marker);
  process.exit(0);
}

/* Утренняя сводка администратору: что было вчера. Отправляется один раз в день, с SUMMARY_HOUR;
 * если ноутбук утром был выключен — сразу после включения. Дата последней сводки — в state.json,
 * поэтому перезапуск бота второй сводки за день не пришлёт. */
const SUMMARY_HOUR = /^\d{1,2}$/.test(process.env.SUMMARY_HOUR || '') && Number(process.env.SUMMARY_HOUR) <= 23
  ? Number(process.env.SUMMARY_HOUR) : 9;

const ACTION_GROUPS = [
  ['Загружено', /^Загрузка/], ['Заменено', /^Замена|^Завершение замены/], ['Перемещено', /^Перемещение/],
  ['Восстановлено', /^Восстановление/], ['Удалено', /^Удаление/],
  ['Доступ: выдан / изменён / закрыт', /доступ|роли/i],
];

async function buildSummary(day) {
  const p = (n) => String(n).padStart(2, '0');
  const ym = `${day.getFullYear()}-${p(day.getMonth() + 1)}`;
  const dayRu = day.toLocaleDateString('ru-RU');
  const rowsDay = (await journal.readMonth(ym)).filter((r) => r['Дата'] === dayRu);
  const errors = rowsDay.filter((r) => /^ОШИБКА/.test(r['Результат']));
  const ok = rowsDay.filter((r) => !/^ОШИБКА/.test(r['Результат']));
  const lines = ACTION_GROUPS
    .map(([label, re]) => [label, ok.filter((r) => re.test(r['Действие'])).length])
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label}: ${n}`);
  let free = null;
  try { free = await disk.freeSpace(); } catch { /* без места — не беда */ }
  const out = [`☀️ Сводка за ${dayRu}`, ''];
  out.push(...(lines.length ? lines : ['Действий не было.']));
  if (errors.length) {
    out.push(RULE, `⚠️ Ошибок: ${errors.length}`,
      ...errors.slice(0, 5).map((r) => `• ${r['Время'].slice(0, 5)} ${r['Кто (имя)'] || r['Кто (номер)']} — ${r['Действие']} ${r['SCR']}`));
  }
  out.push(RULE, `Записей на Диске: ${scrIndex.size}`);
  if (free !== null) out.push(`Свободно: ${(free / 1024 ** 3).toFixed(1).replace('.', ',')} ГБ`);
  const pend = pendingRequests().length;
  if (pend) out.push(`🙋 Ждут решения заявок на доступ: ${pend}`);
  return out.join('\n');
}

async function summaryTick(now = new Date()) {
  if (now.getHours() < SUMMARY_HOUR) return;
  const p = (n) => String(n).padStart(2, '0');
  const todayKey = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  if (lastSummary === todayKey) return;
  const chats = [...new Set(ADMINS.map((a) => adminChats.get(a)).filter(Boolean))];
  if (!chats.length) return;                         // некому — пришлём, когда администратор напишет боту
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  let text;
  try { text = await buildSummary(yesterday); }
  catch (e) { console.error('   сводка не собралась:', e.message); alertDisk(e); return; }
  let sent = 0;
  for (const c of chats) {
    try { await say(c, text, rows([btn('🕒 Последние действия', 'adm:recent'), HOME()])); sent++; }
    catch (e) { console.error('   сводка не ушла:', e.message); }
  }
  // День отмечаем, только если сводка дошла: иначе следующая проверка через 5 минут повторит.
  if (sent) { lastSummary = todayKey; saveState(); }
}

/* Список команд в MAX — рядом с полем ввода, чтобы меню не приходилось искать в ленте.
 * Поддерживает ли это API MAX, документация прямо не говорит: не вышло — просто живём дальше. */
const COMMANDS = [
  { name: 'start', description: 'Главное меню' },
  { name: 'upload', description: 'Загрузить видеозапись' },
  { name: 'find', description: 'Найти запись по номеру SCR' },
  { name: 'browse', description: 'Обзор записей по папкам' },
  { name: 'replace', description: 'Заменить видеозапись' },
  { name: 'move', description: 'Переместить видеозапись' },
  { name: 'admin', description: 'Администрирование' },
];
async function registerCommands() {
  try {
    await api('PATCH', '/me', { body: { commands: COMMANDS } });
    console.log('Список команд в MAX обновлён.');
  } catch (e) {
    console.log(`Список команд в MAX не обновлён (${String(e.message).slice(0, 120)}) — бот работает и без него.`);
  }
}

/** Запись о запуске: частые запуски подряд означают, что бот падает. */
function noteStart() {
  const now = Date.now();
  const recent = starts.filter((t) => now - t < 60 * 60_000);
  recent.push(now);
  starts.splice(0, starts.length, ...recent.slice(-50));
  saveState();
  if (restored.plannedRestart) return;   // перезапуск для ротации журнала — не повод беспокоить
  if (recent.length >= 4) {
    notifyAdmins('crashloop', `⚠️ Бот перезапускался ${recent.length} раз за последний час — похоже, он падает. ` +
      'Загляните в bot.log.');
  } else {
    notifyAdmins('start', '▶️ Бот запущен и на связи.');
  }
}

async function loop() {
  // Сеть при включении ноутбука поднимается не сразу: ждём, а не падаем — иначе каждая
  // такая загрузка выглядела бы для оповещений как падение бота.
  let me;
  for (let attempt = 0; ; attempt++) {
    try { me = await api('GET', '/me'); break; }
    catch (e) {
      console.error(`MAX не отвечает (${e.message}) — повтор через ${Math.min(60, 5 * (attempt + 1))} с`);
      await new Promise((r) => setTimeout(r, Math.min(60, 5 * (attempt + 1)) * 1000));
    }
  }
  console.log(`Бот «${me.name}» (@${me.username}) на связи.`);
  console.log(`Корень на Диске: /${ROOT}, доступ: ${access.length ? access.length + ' чел.' : 'только основные администраторы'}`);
  console.log(`Основные администраторы: ${ADMINS.join(', ')}`);
  if (sessions.size) console.log(`Восстановлено диалогов: ${sessions.size}`);
  noteStart();
  warmTree();                                   // не ждём: опросник начнёт работать сразу, просто первые шаги медленнее
  setInterval(() => { folderCache.clear(); meta.reload(); warmTree(); }, FOLDER_CACHE_TTL_MS);
  setTimeout(healthTick, 60_000);
  setInterval(healthTick, 60 * 60_000);
  setTimeout(() => summaryTick().catch(() => {}), 2 * 60_000);
  setInterval(() => summaryTick().catch(() => {}), 5 * 60_000);
  registerCommands();
  console.log(marker ? `Продолжаю с маркера ${marker} — события за время простоя не потеряются.` : 'Маркера нет, начинаю с текущего момента.');

  while (!stopping) {
    try {
      const pollStart = Date.now();
      const res = await api('GET', '/updates', {
        query: { limit: 50, timeout: POLL_TIMEOUT_SEC, marker },
      });
      const waited = Date.now() - pollStart;
      if ((res?.updates || []).length) console.log(`         [опрос висел ${waited} мс, событий ${res.updates.length}]`);
      if (res?.marker != null && res.marker !== marker) { marker = res.marker; saveMarker(marker); }
      // Не ждём обработки: долгая загрузка в одном чате больше не держит остальные.
      for (const u of res?.updates || []) dispatch(u);
    } catch (e) {
      console.error('опрос не удался:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/* Для автотестов: PRIEMKA_NO_START=1 загружает бота, не начиная опрос MAX.
 * В обычной работе эта переменная не задаётся, и бот запускается как раньше. */
export const _test = {
  dispatch, handleUpdate, warmTree, findByScr,
  idle: async ({ withBackground = true } = {}) => {
    for (let i = 0; i < 50 && (chatQueues.size || (withBackground && background.size)); i++) {
      await Promise.all([...chatQueues.values(), ...(withBackground ? background : [])]);
    }
  },
  state: () => ({ sessions, scrIndex, folderCache, adminChats, scrBusy, alerts, choices }),
  setAccess: (list) => { access = list; },
  healthTick,
  rotateLogIfNeeded,
  summaryTick,
  resetSummary: () => { lastSummary = null; },
  registerCommands,
};

if (process.env.PRIEMKA_NO_START !== '1') {
  process.on('SIGINT', () => { stopping = true; console.log('\nостанавливаюсь…'); writeState(); process.exit(0); });
  loop().catch((e) => { console.error('фатально:', e); process.exit(1); });
}
