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

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import * as disk from './yandex-disk.js';
import { sendFileFromUrl, SendError } from './max-upload.js';
import * as journal from './journal.js';

const API = 'https://platform-api2.max.ru';
const ROOT = 'Видеопоказы';
const BACKUP = 'BackUp';
const SCR_DIGITS = 7;                    // «SCR#6512028» — решение Эмиля, проверяем строго
const STATE_TTL_MS = 30 * 60_000;        // получас на диалог, потом всё забываем
const POLL_TIMEOUT_SEC = 30;

/* Кто управляет доступом. Держим в коде намеренно: список админов меняется раз в год,
 * а если его положить в тот же файл, что и обычных пользователей, любой админ сможет
 * случайно разжаловать всех остальных, включая себя. */
const ADMINS = [
  7421093,    // Эмиль Халилов
  90235418,   // Даниил Рыскин, МЦ
];

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
const ACCESS_FILE = new URL('./access.json', import.meta.url);

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
  try { renameSync(ACCESS_FILE, new URL('./access.json.broken', import.meta.url)); } catch {}
  console.error('access.json повреждён и отложен в access.json.broken: пускаю только администраторов из кода');
  return [];
}
/* Через временный файл и переименование: оборванная запись не оставит полфайла. На Windows
 * антивирус иногда держит файл долю секунды, поэтому несколько попыток. */
function saveAccess(list) {
  const tmp = new URL('./access.json.tmp', import.meta.url);
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
const STATE_FILE = new URL('./state.json', import.meta.url);

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
    };
  } catch {
    return { sessions: new Map(), lastUser: new Map(), choices: new Map(), choiceSeq: 0 };
  }
}

let saveTimer = null;
function saveState() {
  // не чаще раза в секунду: событий бывает несколько подряд, писать на каждое незачем
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeFileSync(STATE_FILE, JSON.stringify({
        sessions: Object.fromEntries(sessions),
        lastUser: Object.fromEntries(lastUser),
        choices: Object.fromEntries(choices),
        choiceSeq,
      }));
    } catch (e) { console.error('не смог сохранить состояние:', e.message); }
  }, 1000);
}

const restored = loadState();
const sessions = restored.sessions;

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
      const dest = disk.joinPath(ROOT, ...s.path, `SCR#${s.scr}${extOf(s.found.name)}`);
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
 * шаге опросника. Структура меняется хорошо если раз в месяц, поэтому держим её в памяти:
 * шаг становится ~200 мс вместо 600–900. Кэш сбрасывается сам через пять минут и
 * принудительно — после любой записи на Диск, иначе свежая папка не появится в списке.
 */
/* Раз в 6 часов, а не в полчаса. Структура папок меняется раз в месяц, а прогрев —
 * это 872 запроса за раз: при получасовом обновлении получалось 42 тысячи запросов
 * в сутки ВПУСТУЮ против 350 полезных. Лимиты Диска не документированы, и искать их
 * холостым ходом — плохая идея.
 * Свежесть при этом не страдает: кэш сбрасывается сам после каждой загрузки и
 * перемещения, а если папки правили руками на Диске — есть кнопка в админке. */
const FOLDER_CACHE_TTL_MS = 6 * 60 * 60_000;
const folderCache = new Map();   // путь → { at, listing }

async function listCached(folder) {
  const hit = folderCache.get(folder);
  if (hit && Date.now() - hit.at < FOLDER_CACHE_TTL_MS) return hit.listing;
  const listing = await disk.listFolder(folder);
  folderCache.set(folder, { at: Date.now(), listing });
  return listing;
}

function dropFolderCache() { folderCache.clear(); warmTree(); }

/* Кэш сам по себе опроснику не помогал: каждый шаг — НОВАЯ папка, которую бот видит
 * впервые, и он всё равно шёл в Диск. Замерено 07.09.2026: 405–444 мс на шаг, при том
 * что отправка сообщения занимает ~190 мс. То есть две трети ожидания — это Диск.
 *
 * Поэтому дерево читаем ЦЕЛИКОМ заранее, в фоне: 4 контракта × периоды × направления —
 * это около полутора сотен запросов, но человек их не ждёт. Дальше опросник работает
 * из памяти, и шаг упирается только в скорость мессенджера. */
let warming = null;

async function warmTree() {
  if (warming) return warming;                      // уже греем — не запускаем второй раз
  const t0 = Date.now();
  warming = (async () => {
    let count = 0;
    const visit = async (folder, depth) => {
      if (depth > 4) return;                        // глубже структура не уходит
      let listing;
      try {
        listing = await disk.listFolder(folder);
      } catch { return; }
      folderCache.set(folder, { at: Date.now(), listing });
      count++;
      const dirs = listing.dirs.filter((d) => d.name !== BACKUP && !d.name.startsWith('_'));
      // по 6 веток разом: Диск не любит шквал, но и по одной ждать незачем
      for (let i = 0; i < dirs.length; i += 6) {
        await Promise.all(dirs.slice(i, i + 6).map((d) => visit(d.path, depth + 1)));
      }
    };
    await visit(disk.joinPath(ROOT), 0);
    console.log(`   дерево прогрето: ${count} папок за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  })().finally(() => { warming = null; });
  return warming;
}

/** Ищем запись по номеру. Имя всегда «SCR#<7 цифр>», поэтому подстроки достаточно. */
async function findByScr(scr) {
  const all = await disk.findFiles(`SCR#${scr}`);
  // BackUp исключаем: там лежат прошлые версии, их находить не надо
  return all.filter((f) => !f.path.includes(`/${BACKUP}/`));
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

  if (payload === 'adm:people' || payload === 'adm:list') {
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
    const path = disk.joinPath('Видеопоказы', '_Журнал', `${ym}.csv`);
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
      const live = files.filter((f) => !f.path.includes(`/${BACKUP}/`));
      const backups = files.length - live.length;
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
  const s = session(chatId);

  if (payload === 'cmd:menu') {
    reset(chatId);
    return showMenu(chatId);
  }

  if (payload === 'adm:back' || payload === 'adm:menu') { s.step = null; return onAdmin(chatId, userId, 'adm:menu', s); }
  if (payload.startsWith('adm')) return onAdmin(chatId, userId, payload, s);   // adm:, admdel:, admrole:, admlog:

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

  if (payload === 'go:move') return doMove(chatId, s);

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
  const existing = await findByScr(s.scr);

  if (s.cmd === 'upload') {
    if (existing.length) {
      const where = existing[0].path.replace('disk:', '');
      reset(chatId);
      return say(chatId,
        `Запись SCR#${s.scr} уже загружена\n\n${report(existing[0].path)}\n${RULE}\n` +
        `Чтобы загрузить новую версию, выберите «Заменить видеозапись» — прежняя сохранится в архиве.`,
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
  s.found = existing[0];

  if (s.cmd === 'find') {
    reset(chatId);
    return sendRecord(chatId, s.found);
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
    const link = await disk.stat(found.path);   // stat отдаёт и file-ссылку
    const href = link.file || (await downloadHref(found.path));
    await sendFileFromUrl(chatId, {
      url: href,
      filename: found.name,
      size: found.size,
      caption: `${(found.name.match(/SCR#\d{7}/) || [found.name])[0]}\n${report(found.path)}`,
      // Кнопка едет на самом файле — отдельным сообщением меню только плодит экраны.
      buttons: rows([btn('⬅️ В начало', 'cmd:menu')]),
    });
    await drop(chatId, wait?.message?.body?.mid);    // «Готовлю запись» своё отработало
  } catch (e) {
    await drop(chatId, wait?.message?.body?.mid);
    console.error('   выдача записи не удалась:', e.message);
    const msg = e instanceof SendError ? 'Не удалось отправить запись в MAX, попробуйте ещё раз.' : diskTrouble(e);
    await say(chatId, msg, rows(menuFor(lastUser.get(chatId))));
  }
}

async function downloadHref(path) {
  const r = await fetch(
    `https://cloud-api.yandex.net/v1/disk/resources/download?path=${encodeURIComponent(path)}`,
    { headers: { Authorization: `OAuth ${process.env.YANDEX_DISK_TOKEN}` } },
  );
  const j = await r.json();
  if (!j?.href) throw new Error('Диск не дал ссылку на скачивание');
  return j.href;
}

async function onFile(chatId, userId, s, attachment) {
  if (s.step !== 'await-file' || !s.scr) {
    return showMenu(chatId, 'Сначала выберите действие, а потом пришлите запись.');
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

  // При ЗАМЕНЕ новая версия встаёт ровно туда, где лежала старая: опросник в этой команде
  // не проходится, поэтому s.path пуст, и раньше файл улетал в корень /Видеопоказы.
  // Расширение берём у НОВОГО файла — прислать могут .mov вместо .mp4.
  const target = (s.cmd === 'replace' && s.found)
    ? parentOf(s.found.path) + '/' + `SCR#${s.scr}${extOf(srcName)}`
    : disk.joinPath(ROOT, ...s.path, `SCR#${s.scr}${extOf(srcName)}`);

  try {
    await say(chatId, 'Загружаю…');
    // Папку заводим для РОДИТЕЛЯ файла: от самого пути файла Диск создаёт каталог
    // с именем «SCR#….mp4», и заливка туда же падает с 409.
    await disk.ensureFolder(parentOf(target));

    /* При замене порядок ВАЖЕН: сначала кладём новую версию во временное имя, и только
     * когда она реально на Диске — убираем старую в архив и ставим новую на её место.
     * Раньше старая уезжала в архив ПЕРВОЙ: любой сбой заливки — и человек оставался
     * без записи вообще (в поиске её уже нет, новой ещё нет). Поймано ревизией 07.09.2026. */
    const replacing = s.cmd === 'replace' && s.found;
    const landing = replacing ? `${target}.new` : target;

    const href = await disk.uploadFromUrl(url, landing);
    await disk.waitOperation(href, { timeoutMs: 10 * 60_000 });

    if (replacing) {
      // время в имени: иначе вторая замена той же записи за сутки падала на занятом пути
      const now = new Date();
      const stamp = now.toISOString().slice(0, 10);
      const clock = now.toTimeString().slice(0, 8).replace(/:/g, '-');
      const backup = disk.joinPath(ROOT, BACKUP, stamp, String(userId), `${clock} ${s.found.name}`);
      await disk.move(s.found.path, backup);
      await disk.move(landing, target);
      s.backupPath = backup;
    }

    const meta = await disk.stat(target);
    dropFolderCache();

    journal.log({
      userId, name: nameOf(userId),
      action: s.cmd === 'replace' ? 'Замена видеозаписи' : 'Загрузка видеозаписи',
      scr: s.scr, where: reportInline(target),
      result: s.cmd === 'replace' ? 'прежняя версия в архиве' : 'успешно',
    });

    reset(chatId);
    const head = s.cmd === 'replace' ? '♻️ Видеозапись заменена' : '✅ Видеозапись загружена';
    const tail = s.cmd === 'replace'
      ? `\n\nПрежняя версия сохранена:\n${(s.backupPath || '').replace('disk:', '')}`
      : '';
    return say(chatId, `${head}\n\n${report(target, { scr: s.scr, size: meta.size })}${tail}`, rows(menuFor(lastUser.get(chatId))));
  } catch (e) {
    journal.log({
      userId, name: nameOf(userId),
      action: s.cmd === 'replace' ? 'Замена видеозаписи' : 'Загрузка видеозаписи',
      scr: s.scr, where: reportInline(target), result: 'ОШИБКА: ' + e.message.slice(0, 120),
    });
    console.error('   загрузка не удалась:', e.message);
    reset(chatId);
    return say(chatId, `Не удалось загрузить запись.\n${diskTrouble(e)}`, rows(menuFor(lastUser.get(chatId))));
  }
}

async function doMove(chatId, s) {
  const scr = s.scr;
  /* Кнопки живут в истории чата: по старой можно прийти с пустой сессией (тогда падало
   * «Cannot read properties of null») или уже начав другой перенос — и тогда запись
   * уезжала в корень мимо структуры, потому что s.path пуст. Поймано ревизией. */
  if (!s.found || !s.scr || !s.path.length) {
    return showMenu(chatId, 'Кнопка устарела — начните перенос заново.', lastUser.get(chatId));
  }
  try {
    const dest = disk.joinPath(ROOT, ...s.path, `SCR#${s.scr}${extOf(s.found.name)}`);

    /* Перенос «сам в себя» Диск отбивает 409-м с текстом про несуществующий путь —
     * человеку это читалось как поломка. Ловим до обращения к API. */
    const norm = (x) => String(x).replace(/^disk:/, '').replace(/\/+/g, '/');
    if (norm(s.found.path) === norm(dest)) {
      reset(chatId);
      return say(chatId,
        `Запись уже лежит в этой папке — переносить некуда.\n\nНомер: SCR#${scr}\n${RULE}\n${report(dest)}`,
        rows(menuFor(lastUser.get(chatId))));
    }

    await disk.move(s.found.path, dest);
    dropFolderCache();
    journal.log({
      userId: lastUser.get(chatId), name: nameOf(lastUser.get(chatId)),
      action: 'Перемещение видеозаписи', scr,
      where: reportInline(dest), result: 'из: ' + reportInline(s.found.path),
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
    reset(chatId);
    const why =
      e.code === 'DiskResourceAlreadyExistsError' ? 'В этой папке уже есть запись с таким номером.'
      : e.status === 409 ? 'Диск не принял перемещение по этому пути.'
      : e.status === 404 ? 'Запись не найдена — возможно, её уже переместили.'
      : 'Не получилось связаться с Диском, попробуйте ещё раз.';
    return say(chatId, `Не удалось переместить запись.\n${why}`, rows(menuFor(lastUser.get(chatId))));
  }
}


/* Маркер позиции в ленте событий — В ФАЙЛЕ, а не только в памяти.
 * Замерено 07.09.2026: без него перезапуск бота ТЕРЯЕТ накопленные события —
 * MAX на запрос без маркера отдаёт только самое последнее обновление, остальные пропадают. */
const MARKER_FILE = new URL('./marker.json', import.meta.url);

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

async function loop() {
  const me = await api('GET', '/me');
  console.log(`Бот «${me.name}» (@${me.username}) на связи.`);
  console.log(`Корень на Диске: /${ROOT}, доступ: ${access.length ? access.length + ' чел.' : 'только основные администраторы'}`);
  if (sessions.size) console.log(`Восстановлено диалогов: ${sessions.size}`);
  warmTree();                                   // не ждём: опросник начнёт работать сразу, просто первые шаги медленнее
  setInterval(() => { folderCache.clear(); warmTree(); }, FOLDER_CACHE_TTL_MS);
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
      for (const u of res?.updates || []) {
        const at = new Date(u.timestamp).toLocaleTimeString('ru-RU');
        const t0 = Date.now();
        try {
          if (u.update_type === 'message_callback') { console.log(`${at} кнопка: ${u.callback?.payload}`); await onCallback(u); console.log(`         обработано за ${Date.now()-t0} мс`); }
          else if (u.update_type === 'message_created') {
            const t = u.message?.body?.text || (u.message?.body?.attachments?.[0]?.type ?? '');
            console.log(`${at} сообщение: ${String(t).slice(0, 60)}`);
            await onMessage(u);
            console.log(`         обработано за ${Date.now()-t0} мс`);
          } else if (u.update_type === 'bot_started') {
            // userId берём из события: без него меню собралось бы для роли по умолчанию,
            // и администратор при первом запуске не увидел бы свою кнопку.
            const uid = u.user?.user_id ?? null;
            console.log(`${at} запуск бота пользователем ${uid ?? '?'}`);
            if (uid) lastUser.set(u.chat_id, uid);
            if (uid && !allowed(uid)) { await denied(u.chat_id, uid); }
            else await showMenu(u.chat_id, 'Бот хранит видеозаписи показов работ по контрактам.', uid);
          }
        } catch (e) {
          console.error(`${at} ошибка обработки:`, e.message);
        }
        saveState();
      }
    } catch (e) {
      console.error('опрос не удался:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

process.on('SIGINT', () => { stopping = true; console.log('\nостанавливаюсь…'); process.exit(0); });

loop().catch((e) => { console.error('фатально:', e); process.exit(1); });
