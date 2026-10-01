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
import { sendFileFromUrl, SendError } from './max-upload.js';
import * as journal from './journal.js';
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
  admin:  { title: 'Администратор',        can: ['find', 'upload', 'replace', 'move', 'admin'] },
  editor: { title: 'Руководитель проекта', can: ['find', 'upload', 'replace', 'move'] },
  viewer: { title: 'Гость',                can: ['find'] },
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
    };
  } catch {
    return {
      sessions: new Map(), lastUser: new Map(), choices: new Map(), choiceSeq: 0,
      adminChats: new Map(), alerts: new Map(), starts: [], plannedRestart: false,
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

// Кнопки MAX идут строками: массив массивов. Каждая своя строка — так длинные
// названия папок не режутся пополам на узком экране телефона.
const rows = (items) => items.map((b) => [b]);
const btn = (text, payload) => ({ type: 'callback', text, payload });

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
    return screen(chatId, 'Не удалось прочитать структуру папок. Попробуйте ещё раз через минуту.', rows([btn('⬅️ В начало', 'cmd:menu')]));
  }

  /* Служебные папки в опроснике не показываем: BackUp — архив версий, а всё,
   * что начинается с подчёркивания (_Журнал и что заведём дальше), — наши потроха.
   * Человек выбирает, куда положить запись, а не гуляет по файловой системе. */
  const dirs = listing.dirs.filter((d) => d.name !== BACKUP && !d.name.startsWith('_'));

  if (dirs.length === 0) {
    // Дно дерева: дальше спрашиваем номер
    if (s.cmd === 'move') {
      s.step = 'confirm-move';
      return screen(chatId,
        `БЫЛО\n${report(s.found.path)}\n${RULE}\nСТАНЕТ\n${report(s.path)}\n${RULE}\nПереместить SCR#${s.scr}?`,
        rows([btn('✅ Переместить', 'go:move'), btn('⬅️ В начало', 'cmd:menu')]));
    }
    s.step = 'await-scr';
    return screen(chatId,
      `${report(s.path)}\n${RULE}\nВведите номер SCR — семь цифр, без «SCR» и «#»\nНапример: 6512028`,
      rows([btn('⬅️ В начало', 'cmd:menu')]));
  }

  const buttons = dirs.map((d) => btn('📁 ' + d.name, 'dir:' + keyFor(d.name)));
  if (s.path.length) buttons.push(btn('⬆️ На уровень выше', 'up'));
  buttons.push(btn('⬅️ В начало', 'cmd:menu'));

  const chosen = s.path.length ? report(s.path) : '';
  const tSend = Date.now();
  // При перемещении «сохранить» звучит как новая загрузка — спрашиваем по делу.
  const ask = s.cmd === 'move' ? 'Куда перенести запись?' : 'Куда сохранить запись?';
  const r = await screen(chatId, chosen ? `${chosen}\n${RULE}\n${ask}` : ask, rows(buttons));
  console.log(`   [шаг] MAX ${Date.now() - tSend} мс, всего ${Date.now() - t0} мс`);
  return r;
}


/* отчёт вместо пути.
 * Человеку не нужен путь на Диске: ему нужно понимать, к какому контракту и периоду
 * относится запись. Корневую папку не показываем вообще — она всегда одна и та же.
 * Префикс «Код-направления » режем: в отчёте это лишний шум.
 */
function parts(pathOrSegments) {
  const seg = Array.isArray(pathOrSegments)
    ? pathOrSegments.slice()
    : String(pathOrSegments).replace(/^disk:/i, '').split('/').filter(Boolean);
  // убираем корень и имя файла, если они попали в список
  if (seg[0] === ROOT) seg.shift();
  if (seg.length && /\.[A-Za-z0-9]{1,8}$/.test(seg[seg.length - 1])) seg.pop();
  const [gk, op, napr, sys] = seg;
  return {
    gk: gk || null,
    op: op || null,
    napr: napr ? napr.replace(/^Код[-\s]?направлени[яй]\s*/i, '') : null,
    sys: sys || null,
  };
}

/** Многострочный отчёт: только заполненные поля. */
function report(src, { scr = null, size = null } = {}) {
  const p = parts(src);
  const lines = [];
  if (scr) lines.push(`Номер: SCR#${scr}`);
  if (p.gk) lines.push(`ГК: ${p.gk}`);
  if (p.op) lines.push(`ОП: ${p.op}`);
  if (p.napr) lines.push(`Направление: ${p.napr}`);
  if (p.sys) lines.push(`Система: ${p.sys}`);
  if (size != null) lines.push(`Размер: ${(size / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`);
  return lines.join('\n');
}

/** Черта между «куда положим» и вопросом к человеку: без неё путь и вопрос
 *  сливаются в одну простыню и читать приходится по слогам. */
const RULE = '––––––––––––––––––––';

/** Однострочный вариант — для подписей и коротких сообщений. */
function reportInline(src) {
  const p = parts(src);
  return [p.gk && `ГК: ${p.gk}`, p.op && `ОП: ${p.op}`, p.napr && `Направление: ${p.napr}`, p.sys && `Система: ${p.sys}`]
    .filter(Boolean).join(' · ');
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
 */
/* Три раздела вместо восьми пунктов: экран, где всё в столбик, читается хуже,
 * чем два коротких шага. Действия живут внутри своего раздела — рядом с тем,
 * к чему относятся. */
const ADMIN_MENU = () => [
  btn('👥 Доступ', 'adm:people'),
  btn('📊 Отчёты', 'adm:reports'),
  btn('🔄 Обновить структуру папок', 'adm:refresh'),
  btn('⬅️ В начало', 'cmd:menu'),
];

async function adminScreen(chatId, prefix = '') {
  return screen(chatId, (prefix ? prefix + '\n\n' : '') + 'Администрирование', rows(ADMIN_MENU()));
}

async function onAdmin(chatId, userId, payload, s) {
  if (!isAdmin(userId)) return say(chatId, 'Эта команда доступна только администраторам.');
  return adminRoute(chatId, userId, payload, s);
}

async function adminRoute(chatId, userId, payload, s) {

  if (payload === 'adm:people') {
    if (!access.length) return screen(chatId, 'Список пуст: ботом пользуются только основные администраторы.', rows([
      btn('➕ Добавить', 'adm:add'),
      btn('⬅️ Назад', 'adm:back'),
    ]));
    const blocks = [];
    for (const [key, def] of Object.entries(ROLES)) {
      const people = access.filter((a) => (ROLES[a.role] ? a.role : DEFAULT_ROLE) === key);
      if (!people.length) continue;
      blocks.push(`${def.title.toUpperCase()} (${people.length})\n` +
        people.map((a) => `  ${a.name || 'без имени'} — ${a.id}`).join('\n'));
    }
    return screen(chatId, `Доступ есть у ${access.length} чел.\n${RULE}\n` + blocks.join(`\n${RULE}\n`), rows([
      btn('➕ Добавить', 'adm:add'),
      btn('➖ Убрать', 'adm:del'),
      btn('🔎 Найти', 'adm:find'),
      btn('📥 Выгрузить в Excel', 'adm:export'),
      btn('⬅️ Назад', 'adm:back'),
    ]));
  }

  if (payload === 'adm:reports') {
    const ms = await journal.months();
    const buttons = ms.slice(0, 6).map((m) =>
      btn(`🗒 Журнал за ${journal.monthTitle(m.ym)}`, 'admlog:' + m.ym));
    if (!ms.length) buttons.push(btn('🗒 Журнал пока пуст', 'adm:reports'));
    buttons.push(btn('📊 Что на Диске', 'adm:stats'));
    buttons.push(btn('⬅️ Назад', 'adm:back'));
    return screen(chatId, 'Отчёты', rows(buttons));
  }

  if (payload.startsWith('admlog:')) {
    // В кнопке лежит сам месяц («2026-09»), а не ключ в памяти: ключи не переживают
    // перезапуск бота, и старая кнопка молча переставала работать. Замерено 07.09.2026.
    const ym = payload.slice(7);
    if (!/^\d{4}-\d{2}$/.test(ym)) return adminScreen(chatId);
    const path = journal.monthPath(ym);
    try {
      const meta = await disk.stat(path, { fields: 'name,size,file' });
      await drop(chatId, s.mid);                       // экран «Отчёты» сейчас заменится файлом
      const wait = await say(chatId, 'Готовлю журнал…');
      await sendFileFromUrl(chatId, {
        url: await downloadHref(path), filename: meta.name, size: meta.size,
        caption: `Журнал действий, ${journal.monthTitle(meta.name.slice(0, 7))}`,
      });
      await drop(chatId, wait?.message?.body?.mid);    // и служебное «готовлю» тоже
      return adminScreen(chatId);
    } catch (e) {
      return adminScreen(chatId, `Не удалось выгрузить журнал.\n${e.message}`);
    }
  }

  if (payload === 'adm:add') {
    const buttons = Object.entries(ROLES).map(([key, def]) =>
      btn(`${def.title} — ${def.can.filter((c) => c !== 'admin').join(', ')}`, 'admrole:' + key));
    buttons.push(btn('⬅️ Назад', 'adm:back'));
    return screen(chatId, 'Какую роль дать человеку?', rows(buttons));
  }

  if (payload.startsWith('admrole:')) {
    s.newRole = payload.slice(8);
    s.step = 'adm-await-id';
    return screen(chatId,
      `Роль: ${ROLES[s.newRole]?.title || s.newRole}\n${RULE}\n` +
      'Пришлите номер человека — он видит его в отказе бота, когда пытается написать.\n\n' +
      'Можно сразу с именем, через пробел: 12345678 Иван Петров',
      rows([btn('⬅️ Назад', 'adm:back')]));
  }

  if (payload === 'adm:del') {
    if (!access.length) return adminScreen(chatId, 'Убирать некого — список пуст.');
    const buttons = access.map((a) => btn(
      `➖ ${a.name || a.id} · ${(ROLES[a.role] || ROLES[DEFAULT_ROLE]).title}`, 'admdel:' + keyFor(a.id)));
    buttons.push(btn('⬅️ Назад', 'adm:back'));
    return screen(chatId, 'Кого убрать?', rows(buttons));
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
    return screen(chatId, 'Кого ищем? Введите часть имени или номер.', rows([btn('⬅️ Назад', 'adm:back')]));
  }

  if (payload === 'adm:export') {
    try {
      const { path, name, size } = await journal.exportPeople(access, ROLES);
      await drop(chatId, s.mid);
      const wait = await say(chatId, `Готовлю выгрузку, ${access.length} чел.`);
      const dl = await downloadHref(path);
      await sendFileFromUrl(chatId, { url: dl, filename: name, size, caption: `Список доступа на ${new Date().toLocaleDateString('ru-RU')}` });
      await drop(chatId, wait?.message?.body?.mid);
      return onAdmin(chatId, userId, 'adm:people', s);
    } catch (e) {
      return adminScreen(chatId, `Не удалось выгрузить список.\n${e.message}`);
    }
  }

  if (payload === 'adm:refresh') {
    dropFolderCache();
    return adminScreen(chatId, 'Структура папок перечитана — свежие папки уже видны в опроснике.');
  }

  if (payload === 'adm:stats') {
    try {
      const files = await disk.findFiles('SCR#');
      const live = files.filter(isLive);
      const backups = files.filter((f) => f.path.includes(`/${BACKUP}/`)).length;
      const bytes = live.reduce((n, f) => n + (f.size || 0), 0);
      const free = await disk.freeSpace();
      return adminScreen(chatId,
        `Записей на Диске: ${live.length}\n` +
        `В архиве версий: ${backups}\n` +
        `Занимают: ${(bytes / 1024 ** 3).toFixed(2)} ГБ\n` +
        `Свободно на Диске: ${(free / 1024 ** 3).toFixed(2)} ГБ`);
    } catch (e) {
      return adminScreen(chatId, `Не удалось собрать статистику.\n${e.message}`);
    }
  }

  return adminScreen(chatId);
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

/** Отказ с номером: человеку есть что переслать администратору, а админу — что вписать. */
function denied(chatId, userId) {
  console.log(`   ОТКАЗ в доступе: user_id=${userId}`);
  return say(chatId,
    `Доступ к боту не выдан.\n\nВаш номер: ${userId}\nПерешлите его администратору, чтобы получить доступ.`);
}

async function onCallback(u) {
  const cb = u.callback;
  const chatId = u.message?.recipient?.chat_id ?? cb?.user?.user_id;
  const userId = cb?.user?.user_id;
  const payload = String(cb?.payload || '');
  if (!allowed(userId)) return denied(chatId, userId);

  lastUser.set(chatId, userId);
  if (ADMINS.includes(userId)) adminChats.set(userId, chatId);   // сюда пойдут оповещения
  const s = session(chatId);

  if (payload === 'cmd:menu') {
    reset(chatId);
    return showMenu(chatId);
  }

  if (payload === 'adm:back' || payload === 'adm:menu') { s.step = null; return onAdmin(chatId, userId, 'adm:menu', s); }
  if (payload.startsWith('adm')) return onAdmin(chatId, userId, payload, s);   // adm:, admdel:, admrole:, admlog:
  if (payload.startsWith('orph:')) {
    if (!isAdmin(userId)) return say(chatId, 'Эта команда доступна только администраторам.');
    return onOrphan(chatId, userId, payload);
  }

  // Выбор одной записи из нескольких с одинаковым номером
  if (payload.startsWith('pick:')) {
    const f = choices.get(payload.slice(5));
    if (!f || s.step !== 'pick' || !s.scr) return showMenu(chatId, 'Кнопка устарела — начните заново.', userId);
    s.found = f;
    s.step = null;
    return afterFound(chatId, s);
  }

  if (payload === 'up') { s.path.pop(); return askFolder(chatId, s); }

  if (payload.startsWith('dir:')) {
    const name = choices.get(payload.slice(4));
    if (!name) return askFolder(chatId, s);   // ключ протух после перезапуска
    s.path.push(name);
    return askFolder(chatId, s);
  }

  if (payload === 'cmd:upload') {
    if (!can(userId, 'upload')) return say(chatId, 'Загрузка недоступна: у вас роль «Гость» — только поиск записей.');
    Object.assign(s, { cmd: 'upload', step: 'folder', path: [], scr: null, found: null });
    return askFolder(chatId, s);
  }

  if (payload === 'cmd:find' || payload === 'cmd:replace' || payload === 'cmd:move') {
    const cmd = payload.slice(4);
    if (!can(userId, cmd)) return say(chatId, 'Это действие недоступно: у вас роль «Гость» — только поиск записей.');
    Object.assign(s, { cmd, step: 'await-scr', path: [], scr: null, found: null });
    const what = cmd === 'find' ? 'найти' : cmd === 'replace' ? 'заменить' : 'переместить';
    // Просим номер одинаково во всех командах: в ветке загрузки текст согласовали,
    // а здесь оставался старый — без подсказки про префикс и без примера.
    return screen(chatId, `Какую запись ${what}?\n${RULE}\nВведите номер SCR — семь цифр, без «SCR» и «#»\nНапример: 6512028`,
      rows([btn('⬅️ В начало', 'cmd:menu')]));
  }

  if (payload === 'go:move') return doMove(chatId, userId, s);

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

  const cmdAlias = { upload: 'cmd:upload', find: 'cmd:find', replace: 'cmd:replace', move: 'cmd:move' };
  const asCommand = text.match(/^\/(upload|find|replace|move)\b/i);
  if (asCommand) {
    return onCallback({
      message: { recipient: { chat_id: chatId } },
      callback: { user: { user_id: userId }, payload: cmdAlias[asCommand[1].toLowerCase()] },
    });
  }

  // Файл прислали — значит ждём его на шаге загрузки или замены
  const file = attachments.find((a) => a.type === 'file' || a.type === 'video');
  if (file) return onFile(chatId, userId, s, file);

  // Поиск человека в админке
  if (s.step === 'adm-await-search' && text) {
    const q = text.trim().toLowerCase();
    const hits = access.filter((a) =>
      String(a.id).includes(q) || (a.name || '').toLowerCase().includes(q));
    s.step = null;
    if (!hits.length) return say(chatId, `По запросу «${text.trim()}» никого не нашёл.`);
    const lines = hits.map((a) =>
      `${a.name || 'без имени'} — ${a.id}\n  ${(ROLES[a.role] || ROLES[DEFAULT_ROLE]).title}` +
      (a.addedAt ? `, добавлен ${a.addedAt}` : '')).join(`\n${RULE}\n`);
    return say(chatId, `Нашёл ${hits.length}:\n${RULE}\n${lines}`);
  }

  // Номер человека для админки
  if (s.step === 'adm-await-id' && text) {
    const m = text.match(/^\s*(\d{4,15})\s*(.*)$/);
    if (!m) return say(chatId, 'Не разобрал номер. Пришлите только цифры, при желании имя через пробел.');
    const id = Number(m[1]);
    const name = (m[2] || '').trim() || null;
    if (access.some((a) => a.id === id)) {
      s.step = null;
      await say(chatId, `${id} уже в списке.`);
      return onAdmin(chatId, userId, 'adm:people', s);
    }
    const role = ROLES[s.newRole] ? s.newRole : DEFAULT_ROLE;
    const next = [...access, { id, name, role, addedBy: userId, addedAt: new Date().toISOString().slice(0, 10) }];
    if (!saveAccess(next)) { s.step = null; return adminScreen(chatId, 'Не удалось сохранить список доступа, попробуйте ещё раз.'); }
    access = next;
    console.log(`   доступ выдан: ${name || '—'} (${id}) роль ${role}, администратор ${userId}`);
    journal.log({
      userId, name: nameOf(userId), action: 'Выдача доступа',
      where: `${name || 'без имени'} (${id})`, result: ROLES[role].title,
    });
    s.newRole = null;
    s.step = null;
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
  let existing;
  try {
    existing = await findByScr(s.scr);
  } catch (e) {
    // Раньше сбой Диска здесь уходил только в журнал работы, а человек не получал ответа.
    console.error('   поиск по номеру не удался:', e.message);
    alertDisk(e);
    reset(chatId);
    return say(chatId, `Не удалось проверить номер SCR#${s.scr}.\n${diskTrouble(e)}`, rows(menuFor(lastUser.get(chatId))));
  }

  if (s.cmd === 'upload') {
    if (existing.length) {
      reset(chatId);
      const dup = existing.length > 1
        ? `\n\nВнимание: записей с этим номером на Диске ${existing.length} — сообщите администратору.` : '';
      return say(chatId,
        `Запись SCR#${s.scr} уже загружена\n\n${report(existing[0].path)}\n${RULE}\n` +
        `Чтобы загрузить новую версию, выберите «Заменить видеозапись» — прежняя сохранится в архиве.${dup}`,
        rows(menuFor(lastUser.get(chatId))));
    }
    s.step = 'await-file';
    return screen(chatId,
      `SCR#${s.scr} — принято.\n\nПришлите видеозапись файлом. Если отправить её как видео, мессенджер сожмёт качество.`,
      rows([btn('⬅️ В начало', 'cmd:menu')]));
  }

  if (!existing.length) {
    return say(chatId,
      `Записи SCR#${s.scr} нет. Проверьте номер или загрузите её через «Загрузить видеозапись».`,
      rows(menuFor(lastUser.get(chatId))));
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
    buttons.push(btn('⬅️ В начало', 'cmd:menu'));
    return screen(chatId,
      `⚠️ Записей с номером SCR#${s.scr} несколько: ${existing.length}.\n${RULE}\n${list}\n${RULE}\nКакую взять?`,
      rows(buttons));
  }

  s.found = existing[0];
  return afterFound(chatId, s);
}

const mb = (bytes) => `${(Number(bytes || 0) / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
const cut = (text, n) => (String(text).length > n ? String(text).slice(0, n - 1) + '…' : String(text));

/** Запись выбрана — дальше по команде. */
async function afterFound(chatId, s) {
  if (s.cmd === 'find') {
    const found = s.found;
    reset(chatId);
    return sendRecord(chatId, found);
  }

  if (s.cmd === 'replace') {
    s.step = 'await-file';
    return screen(chatId,
      `${report(s.found.path, { scr: s.scr, size: s.found.size })}\n${RULE}\n` +
      `Пришлите новую версию файлом. Прежняя сохранится в архиве — ничего не потеряется.`,
      rows([btn('⬅️ В начало', 'cmd:menu')]));
  }

  if (s.cmd === 'move') {
    s.step = 'folder';
    s.path = [];
    s.wasAt = report(s.found.path);
    await say(chatId, report(s.found.path, { scr: s.scr }));
    return askFolder(chatId, s);
  }

  // Команда потерялась (например, пришли по старой кнопке после возврата в меню).
  // Без этой ветки функция просто заканчивалась и бот молчал.
  return showMenu(chatId, 'Не понял, что делаем с этим номером — выберите действие.', lastUser.get(chatId));
}

/** Отдать запись в чат. Файлом, а не видео: важен оригинал, а не проигрывание. */
async function sendRecord(chatId, found) {
  const prev = sessions.get(chatId)?.mid;
  await drop(chatId, prev);                          // экран поиска заменяется самой записью
  const wait = await say(chatId, `Готовлю запись, это займёт до минуты`);
  try {
    // Байты записи идут через компьютер бота — поэтому таких выдач одновременно не больше HEAVY_MAX.
    await heavy(async () => sendFileFromUrl(chatId, {
      url: await downloadHref(found.path),
      filename: found.name,
      size: found.size,
      caption: `${(found.name.match(/SCR#\d{7}/) || [found.name])[0]}\n${report(found.path)}`,
      // Кнопка едет на самом файле — отдельным сообщением меню только плодит экраны.
      buttons: rows([btn('⬅️ В начало', 'cmd:menu')]),
    }));
    await drop(chatId, wait?.message?.body?.mid);    // «Готовлю запись» своё отработало
  } catch (e) {
    await drop(chatId, wait?.message?.body?.mid);
    console.error('   выдача записи не удалась:', e.message);
    alertDisk(e);
    const msg = e instanceof SendError ? 'Не удалось отправить запись в MAX, попробуйте ещё раз.' : diskTrouble(e);
    await say(chatId, msg, rows(menuFor(lastUser.get(chatId))));
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

// PRIEMKA_TEST_* — только для автотестов, чтобы не ждать по 10 минут; в .env их не ставят.
const UPLOAD_WAIT_MS = Number(process.env.PRIEMKA_TEST_UPLOAD_WAIT_MS) || 10 * 60_000;  // столько человек ждёт в чате
const UPLOAD_WAIT_BG_MS = 60 * 60_000;   // столько бот дожидается большой загрузки в фоне
const BG_POLL_MS = Number(process.env.PRIEMKA_TEST_BG_POLL_MS) || 15_000;
const background = new Set();            // фоновые доливки — чтобы тесты могли их дождаться

async function onFile(chatId, userId, s, attachment) {
  if (s.step !== 'await-file' || !s.scr) {
    return showMenu(chatId, 'Сначала выберите действие, а потом пришлите запись.');
  }
  const cmd = s.cmd;
  // Права проверяем ещё раз именно здесь, на шаге, который меняет Диск: роль могли
  // отнять, пока человек выбирал папки.
  if (!can(userId, cmd)) {
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

  const scr = s.scr;
  const found = s.found;
  // При ЗАМЕНЕ новая версия встаёт ровно туда, где лежала старая: опросник в этой команде
  // не проходится, поэтому s.path пуст, и раньше файл улетал в корень /Видеопоказы.
  // Расширение берём у НОВОГО файла — прислать могут .mov вместо .mp4.
  const replacing = cmd === 'replace' && !!found;
  const target = replacing
    ? parentOf(found.path) + '/' + `SCR#${scr}${extOf(srcName)}`
    : disk.joinPath(ROOT, ...s.path, `SCR#${scr}${extOf(srcName)}`);
  /* При замене порядок ВАЖЕН: сначала кладём новую версию во временное имя, и только
   * когда она реально на Диске — убираем старую в архив и ставим новую на её место.
   * Раньше старая уезжала в архив ПЕРВОЙ: любой сбой заливки — и человек оставался
   * без записи вообще (в поиске её уже нет, новой ещё нет). Поймано ревизией 07.09.2026. */
  const landing = replacing ? `${target}.new` : target;
  const ctx = { chatId, userId, cmd, scr, found, target, landing, replacing };

  if (!scrLock(scr, replacing ? 'замена' : 'загрузка')) return say(chatId, busyText(scr));
  let detached = false;
  try {
    // Хватит ли места — до загрузки, а не 507-м после получаса ожидания.
    if (size > 0) {
      let free = null;
      try { free = await disk.freeSpace(); } catch { /* проверка не удалась — грузим как раньше */ }
      if (free !== null && free < size) {
        reset(chatId);
        notifyAdmins('disk-full', `⚠️ На Яндекс.Диске не хватает места: свободно ${mb(free)}, ` +
          `а прислали запись на ${mb(size)}. Загрузки не проходят.`);
        return say(chatId,
          `На Диске не хватает места: запись весит ${mb(size)}, а свободно ${mb(free)}.\n` +
          'Загрузка не начиналась. Сообщите администратору.', rows(menuFor(userId)));
      }
    }

    // Пока человек выбирал файл, состояние Диска могло измениться — перепроверяем под замком.
    if (cmd === 'upload') {
      const now = await findByScr(scr);
      if (now.length) {
        reset(chatId);
        return say(chatId,
          `Запись SCR#${scr} уже загружена — пока вы присылали файл, её загрузил другой пользователь.\n\n` +
          `${report(now[0].path)}\n${RULE}\nЧтобы загрузить новую версию, выберите «Заменить видеозапись».`,
          rows(menuFor(userId)));
      }
    }
    if (replacing && !(await disk.stat(found.path, { fields: 'path' }))) {
      reset(chatId);
      return say(chatId, `Прежняя версия SCR#${scr} уже перемещена или заменена другим пользователем — начните заново.`,
        rows(menuFor(userId)));
    }

    await say(chatId, 'Загружаю…');
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
      reset(chatId);
      await say(chatId,
        `⏳ Загрузка SCR#${scr} ещё идёт — большой файл Диск принимает дольше обычного.\n` +
        'Когда закончится, пришлю результат. Пока можно пользоваться ботом.', rows(menuFor(userId)));
      const job = (async () => {
        try {
          await disk.waitOperation(href, { timeoutMs: UPLOAD_WAIT_BG_MS, initialDelayMs: BG_POLL_MS, maxDelayMs: Math.max(BG_POLL_MS, 60_000) });
          const done = await finishUpload(ctx);
          await say(chatId, uploadDoneText(ctx, done), rows(menuFor(userId)));
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

    const done = await finishUpload(ctx);
    reset(chatId);
    return say(chatId, uploadDoneText(ctx, done), rows(menuFor(lastUser.get(chatId))));
  } catch (e) {
    reset(chatId);
    return uploadFailed(ctx, e);
  } finally {
    if (!detached) { scrUnlock(scr); inFlightPaths.delete(ckey(landing)); }
  }
}

/** Файл на Диске — довести дело до конца: архив прежней версии, индекс, журнал. */
async function finishUpload({ userId, cmd, scr, found, target, landing, replacing }) {
  let backup = null;
  if (replacing) {
    // время в имени: иначе вторая замена той же записи за сутки падала на занятом пути
    backup = backupPath(userId, found.name);
    await disk.move(found.path, backup);
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
  indexAdd({ name: meta.name, path: meta.path || target, size: meta.size });

  journal.log({
    userId, name: nameOf(userId),
    action: cmd === 'replace' ? 'Замена видеозаписи' : 'Загрузка видеозаписи',
    scr, where: reportInline(target),
    result: cmd === 'replace' ? 'прежняя версия в архиве' : 'успешно',
  });
  return { meta, backup };
}

function uploadDoneText({ cmd, scr, target }, { meta, backup }) {
  const head = cmd === 'replace' ? '♻️ Видеозапись заменена' : '✅ Видеозапись загружена';
  const tail = cmd === 'replace' ? `\n\nПрежняя версия сохранена:\n${ckey(backup || '')}` : '';
  return `${head}\n\n${report(target, { scr, size: meta.size })}${tail}`;
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
    return await say(chatId, `Не удалось загрузить запись.\n${diskTrouble(e)}`, rows(menuFor(userId)));
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
        `Запись уже лежит в этой папке — переносить некуда.\n\nНомер: SCR#${scr}\n${RULE}\n${report(dest)}`,
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
      `📁 Видеозапись перемещена\n\nНомер: SCR#${scr}\n${RULE}\n` +
      (was ? `БЫЛО\n${was}\n${RULE}\n` : '') + `СТАЛО\n${report(dest)}`,
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
    return say(chatId, `Не удалось переместить запись.\n${why}`, rows(menuFor(lastUser.get(chatId))));
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
      const dest = backupPath(userId, `незавершённая ${name.replace(/\.new$/i, '')}`);
      await disk.move(path, dest);
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
      backup = backupPath(userId, live[0].name);
      await disk.move(live[0].path, backup);
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
  setInterval(() => { folderCache.clear(); warmTree(); }, FOLDER_CACHE_TTL_MS);
  setTimeout(healthTick, 60_000);
  setInterval(healthTick, 60 * 60_000);
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
};

if (process.env.PRIEMKA_NO_START !== '1') {
  process.on('SIGINT', () => { stopping = true; console.log('\nостанавливаюсь…'); writeState(); process.exit(0); });
  loop().catch((e) => { console.error('фатально:', e); process.exit(1); });
}
