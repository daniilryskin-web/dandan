// Клиент Яндекс.Диска для бота «Приёмка».
// Только встроенные модули Node 22 (fetch, AbortSignal.timeout, Blob) — npm-зависимостей нет.
// Модуль в формате ESM: в package.json проекта должно быть "type": "module".

const API_HOST = 'cloud-api.yandex.net';
const API_BASE = `https://${API_HOST}/v1`;

// Документированные ограничения на значения path (одинаковы для upload и upload-ext).
const MAX_NAME_LENGTH = 255;
const MAX_PATH_LENGTH = 32760;

// Символы, которые Диск не принимает в именах: Windows-набор \ : * ? " < > |, управляющие
// и слэш (слэш в имени файла молча превратился бы в новый уровень пути — см. sanitizeName).
const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/;

// Частота запросов у Диска не документирована вообще: есть код 429, но ни окна, ни чисел,
// ни обязательного Retry-After. Поэтому свой backoff, а Retry-After уважаем, если вдруг придёт.
const RETRY_STATUSES = new Set([423, 429, 500, 503]);
// Эти два кода означают, что запрос заведомо НЕ выполнен, — их безопасно повторять
// даже для POST (загрузка по ссылке), где повтор иначе породил бы вторую закачку.
const SAFE_RETRY_STATUSES = new Set([423, 429]);
const MAX_RETRIES = 4;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 30_000;
// Retry-After берём как есть только до этого потолка: Диск вправе прислать «через час»,
// и молчаливый sleep(3600000) повесил бы обработку видео намертво.
const RETRY_AFTER_MAX_MS = 60_000;

const DEFAULT_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 15 * 60_000; // фолбэк льёт байты видео через нас — минуты, а не секунды

// Расшифровки кодов взяты из таблиц ошибок disk-api; текст сразу человеческий,
// чтобы бот мог отдать его сотруднику в чат без перевода.
const STATUS_HINTS = {
  400: 'некорректные данные запроса',
  401: 'запрос не авторизован — проверьте токен YANDEX_DISK_TOKEN и его права (cloud_api:disk.write, disk.read, disk.info)',
  403: 'API недоступно: не хватает прав или превышена квота',
  404: 'ресурс не найден (в том числе когда нет родительской папки)',
  406: 'ресурс не может быть представлен в запрошенном формате',
  409: 'конфликт: ресурс по указанному пути уже существует',
  413: 'файл больше допустимого размера (потолок зависит от тарифа аккаунта)',
  423: 'ресурс заблокирован: технические работы или превышен лимит трафика на загрузку',
  429: 'слишком много запросов к Диску',
  500: 'внутренняя ошибка Яндекс.Диска',
  503: 'сервис Яндекс.Диска временно недоступен',
  507: 'на Диске не хватает свободного места',
};

/** Ошибка Диска с HTTP-кодом и идентификатором error из тела ответа. */
export class DiskError extends Error {
  constructor(message, { status = 0, code = null, path = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DiskError';
    this.status = status; // HTTP-код; 0 — ошибка до ответа сервера (сеть, валидация)
    this.code = code;     // поле error из объекта Error; перечня значений в документации нет
    this.path = path;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Текст ошибки уходит сотруднику в чат и в логи, поэтому перед склейкой вычищаем секреты:
// сам OAuth-токен и query-строки ссылок (там живут одноразовые подписи Диска и токен файла MAX).
function redact(text) {
  let out = String(text ?? '');
  const token = process.env.YANDEX_DISK_TOKEN;
  if (token && token.length >= 8) out = out.split(token).join('***');
  out = out.replace(/([?&][\w.-]*(?:token|secret|signature|sign|hash|key|password|pwd)=)[^&\s'"]+/gi, '$1***');
  return out;
}

// Ссылку в сообщении показываем без query-строки — в ней подпись или токен доступа.
function safeUrl(raw) {
  try {
    const parsed = new URL(String(raw));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return redact(String(raw ?? '').slice(0, 120));
  }
}

// Токен читаем на каждом вызове, а не при импорте: иначе порядок загрузки .env начинает
// решать, работает бот или нет.
function authToken() {
  const value = process.env.YANDEX_DISK_TOKEN;
  if (!value) {
    throw new DiskError('Не задан YANDEX_DISK_TOKEN — видео приёмки складывать некуда');
  }
  return value;
}

// href из ответов Диска мы подставляем в запрос ВМЕСТЕ с OAuth-токеном. Если в теле ответа
// (или в подменённом ответе) окажется чужой хост, токен уедет туда. Спецификация fetch снимает
// Authorization при кросс-доменном редиректе, но полагаться на это не будем — проверяем сами.
function assertApiUrl(url, context) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new DiskError(`${context}: некорректный адрес запроса`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== API_HOST) {
    throw new DiskError(`${context}: адрес ${parsed.origin} не относится к ${API_HOST} — OAuth-токен туда не отправляем`);
  }
  return parsed;
}

// URLSearchParams кодирует пробел как «+», а Диску нужен строгий percent-encoding пути
// («/Приёмка/123» → «%2F%D0%9F...»), поэтому собираем query руками.
function buildUrl(endpoint, query = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `${API_BASE}${endpoint}?${parts.join('&')}` : `${API_BASE}${endpoint}`;
}

/**
 * Одно безопасное имя из того, что прислал сотрудник или отдал транспорт.
 * Живые данные ломают путь именно здесь: «видео 1/2.mp4» создаёт лишний уровень,
 * «.mp4» превращается в скрытый файл, хвостовой пробел Диск режет молча, эмодзи считается
 * за два UTF-16-символа при обрезке по 255.
 * Слэш заменяем, а не режем: имя ОБЯЗАНО остаться одним сегментом.
 */
function sanitizeName(raw, { fallback = 'file' } = {}) {
  let name = String(raw ?? '')
    .normalize('NFC')
    .replace(/\u00a0/g, ' ')
    .replace(new RegExp(FORBIDDEN_NAME_CHARS.source, 'g'), '_')
    .trim()
    .replace(/^\.+/, '')     // «.mp4», «..» — скрытые имена и ловушки обхода пути
    .replace(/[. ]+$/, '');  // хвостовые точки и пробелы теряются при переносе на Диск

  if (name === '') return fallback;

  const chars = [...name];
  if (chars.length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    const keepExt = [...ext].length <= 16 ? ext : '';
    name = chars.slice(0, MAX_NAME_LENGTH - [...keepExt].length).join('') + keepExt;
    name = name.replace(/[. ]+$/, '') || fallback;
  }
  return name;
}

/**
 * Собрать путь из отдельных ИМЁН: каждый аргумент — ровно один уровень, слэши внутри
 * аргумента экранируются. Так номер приёмки «12/34» и имя файла из чата не могут
 * расползтись по дереву Диска.
 * @example joinPath('Приёмка', number, fileName) → '/Приёмка/12_34/видео.mp4'
 */
export function joinPath(...names) {
  const segments = names
    .flat()
    .filter((n) => n !== undefined && n !== null && String(n).trim() !== '')
    .map((n) => {
      const s = String(n);
      // Слэш ВНУТРИ имени экранируется, как и задумано: номер приёмки «12/34» становится
      // «12_34» и остаётся одним уровнем. А вот аргумент, начинающийся со слэша или с
      // «disk:», — это готовый путь, переданный по ошибке: раньше он молча превращался
      // в «_Приёмка_1302», файл улетал в несуществующую папку, и Диск отвечал
      // бессмысленным «409 конфликт: путь не существует». Замерено 07.09.2026.
      if (/^\s*(\/|disk:)/i.test(s)) {
        throw new DiskError(
          `joinPath принимает отдельные имена, по одному уровню на аргумент, а получил готовый путь «${s}». ` +
          `Сегменты передаются через запятую: joinPath('Приёмка', '1302', имяФайла).`
        );
      }
      return sanitizeName(s, { fallback: '' });
    })
    .filter(Boolean);
  if (segments.length === 0) {
    throw new DiskError('joinPath: не из чего собрать путь на Диске');
  }
  return normalizePath(`/${segments.join('/')}`);
}

// Приводим «disk:/Приёмка/12», «/Приёмка/12/» и «Приёмка//12» к одному виду —
// иначе разбиение на уровни в ensureFolder начнёт создавать пустые сегменты.
function normalizePath(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new DiskError('Пустой путь на Яндекс.Диске');
  }
  const segments = raw.replace(/^disk:/i, '').split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) {
    throw new DiskError(`Путь «${raw}» указывает на корень Диска — так нельзя`);
  }
  if (segments.includes('..')) {
    throw new DiskError(`Путь не должен содержать «..»: ${raw}`);
  }
  // Проверяем КАЖДЫЙ уровень, а не только последний: длинное или битое имя папки
  // ломает загрузку так же, как имя файла, но диагностируется потом гораздо хуже.
  for (const segment of segments) {
    if (FORBIDDEN_NAME_CHARS.test(segment)) {
      throw new DiskError(`Имя «${segment}» содержит символ, который Диск не примет — прогони его через sanitizeName()`);
    }
    if (/^[. ]|[. ]$/.test(segment)) {
      throw new DiskError(`Имя «${segment}» начинается или заканчивается точкой/пробелом — прогони его через sanitizeName()`);
    }
    if ([...segment].length > MAX_NAME_LENGTH) {
      throw new DiskError(`Имя «${segment.slice(0, 40)}…» длиннее ${MAX_NAME_LENGTH} символов`);
    }
  }
  const path = `/${segments.join('/')}`;
  if (path.length > MAX_PATH_LENGTH) {
    throw new DiskError(`Путь длиннее ${MAX_PATH_LENGTH} символов: ${path.length}`, { path });
  }
  return path;
}

// Очередь на путь: два видео подряд от одного сотрудника попадают в ensureFolder и upload
// одновременно, и без неё они гоняются за одну и ту же папку/имя.
// Замок ВНУТРИПРОЦЕССНЫЙ: несколько инстансов бота он не спасает, поэтому финальный арбитр —
// сам Диск (overwrite=false + обработка 409).
const pathLocks = new Map();

function withPathLock(key, fn) {
  const prev = pathLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {}); // хвост очереди не должен реджектиться
  pathLocks.set(key, tail);
  tail.then(() => {
    if (pathLocks.get(key) === tail) pathLocks.delete(key);
  });
  return run;
}

function retryAfterMs(response) {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

// Джиттер обязателен: два видео, пойманные одним 429, иначе будут ходить к Диску
// строго в такт и получать 429 снова.
function backoffMs(attempt) {
  const base = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

// Один и тот же HTTP-код Диск отдаёт по разным поводам, и подсказка только по коду врёт.
// Замерено 07.09.2026: на 409 приходит и «путь занят», и DiskPathDoesntExistsError —
// то есть ровно обратное по смыслу. Поле error точнее кода, поэтому оно и главнее.
const ERROR_HINTS = {
  DiskPathDoesntExistsError: 'по этому пути ничего нет — обычно не создана родительская папка',
  DiskPathPointsToExistentDirectoryError: 'по этому пути уже лежит папка',
  DiskResourceAlreadyExistsError: 'ресурс с таким именем уже существует',
  DiskNotFoundError: 'ресурс не найден',
  DiskResourceUploadTrafficLimitExceededError: 'исчерпана месячная квота загрузки — Диск до конца периода только на чтение',
  DiskUploadTrafficLimitExceeded: 'исчерпана месячная квота загрузки — Диск до конца периода только на чтение',
  DiskFileSizeLimitExceededError: 'файл больше максимального размера для этого тарифа',
  DiskNotEnoughFreeSpaceError: 'на Диске не хватает места',
  UnauthorizedError: 'токен недействителен или истёк',
};

function formatApiError(status, body, context, path) {
  const code = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : null;
  const hint = (code && ERROR_HINTS[code]) || STATUS_HINTS[status] || 'неожиданный ответ Диска';
  // Тело ошибки логируем целиком: перечня значений error в документации нет,
  // справочник по кодам придётся накапливать эмпирически.
  const details = [];
  if (body && typeof body === 'object') {
    if (typeof body.message === 'string') details.push(body.message);
    if (typeof body.description === 'string' && body.description !== body.message) details.push(body.description);
    if (body.error !== undefined && body.error !== null) {
      details.push(`error=${typeof body.error === 'string' ? body.error : JSON.stringify(body.error)}`);
    }
  } else if (typeof body === 'string' && body.trim()) {
    details.push(body.trim().slice(0, 500));
  }
  const tail = details.length ? ` (${redact(details.join('; '))})` : '';
  return new DiskError(`${context}: HTTP ${status} — ${hint}${tail}`, {
    status,
    code,
    path,
  });
}

/**
 * Запрос к cloud-api. url передаётся целиком: href из ответов Диска — непрозрачная строка,
 * разбирать и пересобирать её нельзя (формы /operations?id=... и /operations/<id> расходятся
 * даже внутри самой документации).
 *
 * idempotent: по умолчанию всё, кроме POST. Повторять POST /resources/upload после таймаута
 * нельзя — первый запрос мог дойти, и Диск начнёт качать файл дважды.
 */
async function apiRequest(method, url, {
  expect = [200],
  context = 'Запрос к Яндекс.Диску',
  path = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  idempotent = method !== 'POST',
} = {}) {
  assertApiUrl(url, context);

  // Токен читаем ДО цикла: иначе «нет токена» уедет в ветку сетевой ошибки и будет
  // четыре раза бессмысленно повторено.
  const headers = {
    Authorization: `OAuth ${authToken()}`, // именно OAuth, не Bearer
    Accept: 'application/json',
    // Content-Type не шлём: тела в запросах нет, у upload/publish/create-folder все параметры
    // живут в query-строке.
  };

  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError';
      const reason = timedOut
        ? `Диск не ответил за ${Math.round(timeoutMs / 1000)} с`
        : `сеть не ответила — ${redact(error?.message)}`;
      if (idempotent && attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      const note = idempotent ? '' : ' Повтор не делаем: запрос мог дойти до Диска — результат нужно проверить.';
      throw new DiskError(`${context}: ${reason}.${note}`, { path, cause: error });
    }

    // Тело тоже читается по сети и тоже рвётся — без catch это необработанный throw
    // посреди успешного, казалось бы, запроса.
    let raw = '';
    try {
      raw = await response.text();
    } catch (error) {
      if (idempotent && attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new DiskError(
        `${context}: пришёл HTTP ${response.status}, но тело ответа оборвалось — ${redact(error?.message)}`,
        { status: response.status, path, cause: error },
      );
    }

    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw; // не-JSON от Диска не ждём, но глотать молча тоже нельзя
      }
    }

    if (expect.includes(response.status)) {
      return { status: response.status, body };
    }

    const retryable = idempotent ? RETRY_STATUSES.has(response.status) : SAFE_RETRY_STATUSES.has(response.status);
    if (retryable && attempt < MAX_RETRIES) {
      const asked = retryAfterMs(response);
      if (asked !== null && asked > RETRY_AFTER_MAX_MS) {
        // Ждать столько внутри обработчика видео нельзя — пусть бот скажет сотруднику честно.
        throw new DiskError(
          `${context}: HTTP ${response.status} — ${STATUS_HINTS[response.status] ?? 'Диск просит подождать'}; повтор возможен не раньше чем через ${Math.round(asked / 1000)} с`,
          { status: response.status, path },
        );
      }
      await sleep(asked ?? backoffMs(attempt));
      continue;
    }

    throw formatApiError(response.status, body, context, path);
  }
}

/**
 * Метаданные ресурса. Он же — способ убедиться, что файл реально лёг в папку:
 * 202 и даже status=success сами по себе этого не доказывают.
 * @returns {Promise<object|null>} объект Resource или null, если ресурса нет (404)
 */
export async function stat(path, { fields = 'name,path,type,size,md5,public_url' } = {}) {
  const target = normalizePath(path);
  const { status, body } = await apiRequest('GET', buildUrl('/disk/resources', { path: target, fields }), {
    expect: [200, 404],
    context: `Чтение метаданных ${target}`,
    path: target,
  });
  return status === 404 ? null : body;
}

/**
 * Создать папку, пережив «уже существует». Промежуточные уровни API сам не создаёт,
 * поэтому идём по цепочке: /Приёмка, потом /Приёмка/<номер>.
 * @returns {Promise<string>} нормализованный путь папки
 */
export async function ensureFolder(path) {
  const target = normalizePath(path);
  const segments = target.slice(1).split('/');
  let current = '';
  for (const segment of segments) {
    current += `/${segment}`;
    // Замок на уровень: два видео одной приёмки не будут создавать один и тот же
    // «/Приёмка/12» параллельно.
    await withPathLock(current, ((folder) => () => createFolder(folder))(current));
  }
  return target;
}

async function createFolder(folder) {
  const { status } = await apiRequest('PUT', buildUrl('/disk/resources', { path: folder }), {
    // 409 считаем «папка уже есть»: в таблице create-folder этот сценарий официально не описан,
    // а соседняя ручка upload-ext документирует 409 именно как «ресурс уже существует».
    expect: [201, 409],
    context: `Создание папки ${folder}`,
    path: folder,
  });
  if (status === 201) return;

  // 409 может означать и «здесь лежит ФАЙЛ с таким именем» — тогда дальше писать некуда,
  // и молчать об этом нельзя.
  let meta = await stat(folder, { fields: 'type,path' });
  if (!meta) {
    // Гонка с параллельным создателем: 409 пришёл раньше, чем папка стала видна в stat.
    await sleep(700);
    meta = await stat(folder, { fields: 'type,path' });
  }
  if (!meta) {
    throw new DiskError(`Папка ${folder} не создана: Диск ответил 409, но ресурса по пути нет`, { status: 409, path: folder });
  }
  if (meta.type !== 'dir') {
    throw new DiskError(`По пути ${folder} лежит файл, а не папка — положить видео приёмки некуда`, { status: 409, path: folder });
  }
}

/**
 * Асинхронная загрузка по внешней ссылке: Яндекс качает файл сам, байты через нас не идут.
 * Ответ 202 означает только «скачивание начато» — исход узнаёт waitOperation.
 * @returns {Promise<string>} href ручки статуса операции (использовать как непрозрачную строку)
 */
export async function uploadFromUrl(url, path) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    // Саму ссылку в текст ошибки не кладём: в её query-строке обычно сидит токен доступа к файлу.
    throw new DiskError(`Ссылка на файл должна быть http(s), получено: ${safeUrl(url)}`);
  }
  const target = normalizePath(path);
  return withPathLock(target, async () => {
    const { body } = await apiRequest('POST', buildUrl('/disk/resources/upload', { url, path: target }), {
      expect: [202],
      context: `Загрузка по ссылке в ${target}`,
      path: target,
      // POST не повторяем при обрыве: две принятые операции = два файла или конфликт.
      idempotent: false,
    });
    const href = body && typeof body === 'object' ? body.href : null;
    if (!href) {
      throw new DiskError(`Загрузка в ${target} принята (202), но href операции не пришёл — опрашивать нечего`, { status: 202, path: target });
    }
    if (body.templated === true) {
      // Какие переменные подставлять в templated-href, документация не описывает —
      // честно падаем, а не шлём URL с «{...}».
      throw new DiskError(`Диск вернул шаблонный href операции для ${target} — подстановку переменных не знаем`, { status: 202, path: target });
    }
    return href;
  });
}

/**
 * Опрос статуса операции до success или failed.
 * Интервал и общий дедлайн документацией не заданы — здесь экспонента от 2 с с потолком 30 с.
 * @returns {Promise<object>} тело операции со status: 'success'
 */
export async function waitOperation(href, { timeoutMs = 20 * 60_000, initialDelayMs = 2000, maxDelayMs = 30_000 } = {}) {
  if (typeof href !== 'string') {
    throw new DiskError(`Некорректный href операции: ${safeUrl(href)}`);
  }
  // Хост проверяет apiRequest → assertApiUrl: с href уходит OAuth-токен.
  const deadline = Date.now() + timeoutMs;
  let delay = initialDelayMs;

  for (;;) {
    const { body } = await apiRequest('GET', href, { context: 'Проверка статуса операции' });
    const status = body && typeof body === 'object' ? body.status : null;

    if (status === 'success') return body;
    if (status === 'failed') {
      // Причину отказа объект Operation не содержит вообще — отличить «источник недоступен»
      // от «кончилось место» можно только внешними проверками, поэтому подсказываем их.
      throw new DiskError(
        'Яндекс.Диск не смог выполнить операцию (status=failed). Причину API не сообщает — вероятно, не хватает места или ссылка-источник недоступна',
        { code: 'failed' },
      );
    }
    if (status !== 'in-progress') {
      throw new DiskError(`Неизвестный статус операции: ${JSON.stringify(status)}`);
    }
    if (Date.now() + delay >= deadline) {
      // code='timeout' — бот отличает «ещё идёт» от настоящего отказа и ждёт дальше в фоне.
      throw new DiskError(
        `Операция не завершилась за ${Math.round(timeoutMs / 1000)} с. Файл может долиться позже`,
        { code: 'timeout' },
      );
    }
    await sleep(delay);
    delay = Math.min(delay * 2, maxDelayMs);
  }
}

// Ссылка на заливку ведёт на отдельный uploader-хост, а не на cloud-api. Authorization туда
// не шлём: документация его не показывает, ссылка сама по себе одноразовая и живёт 30 минут.
// Но https обязателен — иначе видео приёмки уйдёт открытым текстом.
function assertUploaderUrl(href) {
  let parsed;
  try {
    parsed = new URL(String(href));
  } catch {
    throw new DiskError('Диск вернул нечитаемую ссылку для загрузки');
  }
  if (parsed.protocol !== 'https:') {
    throw new DiskError(`Ссылка для загрузки не https (${parsed.protocol}) — видео открытым текстом не льём`);
  }
  return parsed;
}

async function requestUploadLink(target, overwrite) {
  const { body: link } = await apiRequest('GET', buildUrl('/disk/resources/upload', { path: target, overwrite: String(overwrite) }), {
    expect: [200],
    context: `Запрос ссылки на загрузку ${target}`,
    path: target,
  });
  const href = link && typeof link === 'object' ? link.href : null;
  if (!href) {
    throw new DiskError(`Диск не вернул ссылку для загрузки ${target}`, { status: 200, path: target });
  }
  if (link.templated === true) {
    throw new DiskError(`Ссылка для загрузки ${target} шаблонная (templated) — какие переменные подставлять, документация не говорит`, { status: 200, path: target });
  }
  assertUploaderUrl(href);
  return link;
}

/**
 * Запасной путь: получить upload-ссылку и залить содержимое PUT-ом.
 * Здесь трафик идёт через наш процесс, поэтому это фолбэк, а не основной приём.
 * @param {Uint8Array|Buffer|ArrayBuffer|Blob} buffer содержимое файла (Blob из fs.openAsBlob
 *   не держит гигабайтное видео в памяти и переживает повтор запроса)
 * @returns {Promise<{path: string, status: number}>}
 */
export async function uploadBuffer(buffer, path, { overwrite = false, timeoutMs = UPLOAD_TIMEOUT_MS } = {}) {
  const target = normalizePath(path);
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  if (!(bytes instanceof Uint8Array) && !(bytes instanceof Blob)) {
    throw new DiskError('uploadBuffer ждёт Buffer, Uint8Array, ArrayBuffer или Blob', { path: target });
  }
  // Пустой файл Диск примет молча, и в папке приёмки окажется «видео» на 0 байт.
  const size = bytes instanceof Blob ? bytes.size : bytes.byteLength;
  if (size === 0) {
    throw new DiskError(`Пустой файл (0 байт) для ${target} — заливать нечего`, { path: target });
  }

  return withPathLock(target, async () => {
    let link = await requestUploadLink(target, overwrite);

    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetch(link.href, {
          method: link.method || 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (attempt < 2) {
          await sleep(backoffMs(attempt));
          // Ссылка одноразовая: повторять на тот же href после обрыва нельзя, берём новую.
          link = await requestUploadLink(target, overwrite);
          continue;
        }
        const timedOut = error?.name === 'TimeoutError';
        const reason = timedOut ? `не уложились в ${Math.round(timeoutMs / 1000)} с` : `сеть не ответила — ${redact(error?.message)}`;
        throw new DiskError(`Заливка ${target}: ${reason}`, { path: target, cause: error });
      }

      // 201 — файл на Диске; 202 — принят, но ещё переносится.
      if (response.status === 201 || response.status === 202) {
        return { path: target, status: response.status };
      }

      const raw = await response.text().catch(() => '');
      let parsed = raw;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        // не-JSON от uploader-хоста нормален, оставляем текстом
      }

      // 500/503 документация прямо велит повторять; 423 — временная блокировка.
      if ((response.status === 500 || response.status === 503 || response.status === 423) && attempt < 2) {
        const asked = retryAfterMs(response);
        if (asked === null || asked <= RETRY_AFTER_MAX_MS) {
          await sleep(asked ?? backoffMs(attempt));
          link = await requestUploadLink(target, overwrite);
          continue;
        }
      }

      throw formatApiError(response.status, parsed, `Заливка ${target}`, target);
    }
  });
}

/**
 * Свободное место в байтах — предполётная проверка, чтобы не поймать 507 в середине загрузки.
 * @returns {Promise<number>}
 */
export async function freeSpace() {
  const { body } = await apiRequest('GET', buildUrl('/disk', { fields: 'total_space,used_space' }), {
    expect: [200],
    context: 'Запрос свободного места на Диске',
  });
  const total = Number(body?.total_space);
  const used = Number(body?.used_space);
  if (!Number.isFinite(total) || !Number.isFinite(used)) {
    throw new DiskError('В ответе GET /disk нет total_space/used_space — считать свободное место нечем', { status: 200 });
  }
  return Math.max(0, total - used);
}

/* Обзор, поиск, перемещение. */

/**
 * Содержимое папки: подпапки и файлы отдельно. На этом стоит весь опросник —
 * бот спускается по дереву, пока внизу есть папки, и не знает заранее, сколько уровней.
 */
export async function listFolder(folder) {
  const path = normalizePath(folder);
  /* Постранично: одна страница — не больше PAGE элементов, и раньше всё, что дальше
   * двухсотого, в опросник просто не попадало. Читаем, пока страница полная. */
  const PAGE = 200;
  const items = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = buildUrl('/disk/resources', {
      path,
      limit: PAGE,
      offset,
      sort: 'name',
      fields: '_embedded.items.name,_embedded.items.type,_embedded.items.path,_embedded.items.size,_embedded.items.created,_embedded.items.public_url',
    });
    const { body } = await apiRequest('GET', url, { expect: [200], context: `Список ${folder}`, path });
    const page = body?._embedded?.items ?? [];
    items.push(...page);
    if (page.length < PAGE) break;
  }
  return {
    dirs: items.filter((i) => i.type === 'dir').map((i) => ({ name: i.name, path: i.path })),
    files: items
      .filter((i) => i.type === 'file')
      .map((i) => ({ name: i.name, path: i.path, size: i.size ?? 0, created: i.created ?? null, public_url: i.public_url ?? null })),
  };
}

/**
 * Поиск файла по подстроке имени. Обхода дерева НЕ делаем: /resources/files отдаёт
 * плоский список всех файлов Диска сразу с путями — замерено 07.09.2026.
 * Дисковый список постраничный, поэтому идём по offset, пока не кончится.
 * Верхнего предела по умолчанию нет: раньше он стоял на 1000 файлов всего Диска,
 * и всё, что дальше, поиск не видел — «записи нет» на существующий номер.
 */
export async function findFiles(substring, { limit = Infinity } = {}) {
  const needle = String(substring).toLowerCase();
  const found = [];
  const PAGE = 200;
  for (let offset = 0; offset < limit; offset += PAGE) {
    const url = buildUrl('/disk/resources/files', {
      limit: PAGE,
      offset,
      fields: 'items.name,items.path,items.size,items.created,items.type,items.public_url',
    });
    const { body } = await apiRequest('GET', url, { expect: [200], context: 'Поиск файла по имени' });
    const items = body?.items ?? [];
    for (const it of items) {
      if (String(it.name).toLowerCase().includes(needle)) {
        found.push({ name: it.name, path: it.path, size: it.size ?? 0, created: it.created ?? null, public_url: it.public_url ?? null });
      }
    }
    if (items.length < PAGE) break;   // страница неполная — дальше ничего нет
  }
  return found;
}

/**
 * Перемещение внутри Диска. Важное свойство: месячную квоту загрузки НЕ тратит —
 * поэтому бэкап при замене ничего не стоит, файл не перезаливается.
 * Родительскую папку назначения создаём сами: Диск сам её не создаёт и отдаёт 409.
 */
export async function move(from, to, { overwrite = false } = {}) {
  const src = normalizePath(from);
  const dst = normalizePath(to);
  const parent = dst.slice(0, dst.lastIndexOf('/')) || '/';
  if (parent !== '/') await ensureFolder(parent);

  const url = buildUrl('/disk/resources/move', { from: src, path: dst, overwrite });
  const { status, body } = await apiRequest('POST', url, {
    expect: [201, 202],
    context: `Перемещение ${from} → ${to}`,
    path: dst,
    idempotent: false,
  });
  // 202 — операция асинхронная (крупный файл), надо дождаться
  if (status === 202 && body?.href) {
    await waitOperation(body.href, { timeoutMs: 5 * 60_000 });
  }
  return dst;
}

/**
 * Копия внутри Диска — для восстановления версии: архивная копия остаётся в BackUp,
 * на место записи встаёт её дубликат. Устроено как move: родителя создаём сами,
 * крупный файл копируется асинхронно (202) — дожидаемся.
 */
export async function copy(from, to, { overwrite = false } = {}) {
  const src = normalizePath(from);
  const dst = normalizePath(to);
  const parent = dst.slice(0, dst.lastIndexOf('/')) || '/';
  if (parent !== '/') await ensureFolder(parent);

  const url = buildUrl('/disk/resources/copy', { from: src, path: dst, overwrite });
  const { status, body } = await apiRequest('POST', url, {
    expect: [201, 202],
    context: `Копирование ${from} → ${to}`,
    path: dst,
    idempotent: false,
  });
  if (status === 202 && body?.href) {
    await waitOperation(body.href, { timeoutMs: 15 * 60_000 });
  }
  return dst;
}

/**
 * Прочитать небольшой текстовый файл с Диска (журнал, служебные данные).
 * Пустая строка — только когда Диск прямо ответил «файла нет». Любой другой сбой —
 * исключение: тот, кто потом перезапишет файл, не должен затереть его пустотой.
 */
export async function readText(path) {
  const meta = await stat(path, { fields: 'name,size,file' });
  if (!meta) return '';
  if (!meta.file) throw new DiskError(`Диск не дал ссылку на чтение ${path}`, { path });
  const r = await fetch(meta.file, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new DiskError(`чтение ${path}: HTTP ${r.status}`, { status: r.status, path });
  const text = await r.text();
  if (!text.replace(/^﻿/, '').trim() && meta.size > 3) {
    throw new DiskError(`чтение ${path}: пусто при размере ${meta.size} байт`, { path });
  }
  return text;
}

/**
 * Опубликовать файл и вернуть публичную ссылку (https://disk.yandex.ru/d/…): по ней видео
 * открывается у любого, без входа в Яндекс. Повторная публикация уже открытого файла
 * возвращает ту же ссылку. Лимит числа публикаций у Диска есть (403), но он не назван.
 */
export async function publish(path) {
  const target = normalizePath(path);
  await apiRequest('PUT', buildUrl('/disk/resources/publish', { path: target }), {
    expect: [200], context: `Публикация ${target}`, path: target,
  });
  // public_url появляется в метаданных не всегда мгновенно — даём пару заходов.
  for (let attempt = 0; attempt < 3; attempt++) {
    const meta = await stat(target, { fields: 'public_url' });
    if (meta?.public_url) return meta.public_url;
    await sleep(1000);
  }
  throw new DiskError(`Файл ${target} опубликован, но публичная ссылка так и не появилась`, { path: target });
}

/** Закрыть публичную ссылку. Ничего не удаляет: файл остаётся на Диске. */
export async function unpublish(path) {
  const target = normalizePath(path);
  await apiRequest('PUT', buildUrl('/disk/resources/unpublish', { path: target }), {
    expect: [200], context: `Снятие публикации ${target}`, path: target,
  });
}
