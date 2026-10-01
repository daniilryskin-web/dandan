// Отправка медиа В MAX.
//
// Схема из документации: POST /uploads?type=… отдаёт временный url, на него льётся файл,
// в ответ приходит токен, и уже он подставляется в attachments при POST /messages.
//
// Своя механика здесь — скачивание с Диска и ожидание готовности вложения.

const API = 'https://platform-api2.max.ru';

// Потолок POST /uploads?type=file, дословно из документации MAX.
const FILE_LIMIT = 4 * 1024 * 1024 * 1024;

export class SendError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = 'SendError';
    this.status = status;
    this.code = code;
  }
}

function token() {
  const t = process.env.MAX_TOKEN;
  if (!t) throw new SendError('Не задан MAX_TOKEN');
  return t;
}

// Токен уходит в текст ошибки только через это сито.
function redact(text) {
  const t = process.env.MAX_TOKEN;
  let out = String(text ?? '');
  if (t && t.length >= 8) out = out.split(t).join('«MAX_TOKEN»');
  return out.replace(/([?&][\w.-]*(?:rq|token|sig|signature)=)[^&\s'"]+/gi, '$1***');
}

async function api(method, path, { query = {}, body = null } = {}) {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  const url = `${API}${path}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: token(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* не JSON — оставим как есть */ }
  if (!res.ok) {
    throw new SendError(
      `MAX ${method} ${path}: HTTP ${res.status} ${redact(text).slice(0, 300)}`,
      { status: res.status, code: json?.code ?? null },
    );
  }
  return json;
}

/* Выдача записи раньше скачивала файл с Диска ЦЕЛИКОМ в память и только потом отдавала
 * в MAX: видео на 2 ГБ занимало 2 ГБ оперативной памяти. Теперь байты идут потоком —
 * кусок пришёл с Диска, кусок ушёл в MAX, — и память от размера видео не зависит.
 *
 * Тело multipart собираем сами, а длину считаем заранее и шлём в Content-Length: для сервера
 * загрузки MAX запрос выглядит так же, как раньше из FormData (проверено: без chunked).
 *
 * Если потоковая отправка всё же не удалась, файлы до FALLBACK_MAX уходят старым способом,
 * через память. Крупнее — честная ошибка: старый способ на них всё равно уронил бы бота. */
const FALLBACK_MAX = 300 * 1024 * 1024;

// Имя в заголовке части экранируем так же, как это делает FormData.
const quoteName = (name) => String(name).replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');

async function startUpload(kind) {
  // Замерено 07.09.2026: формы ответа для разных типов РАЗНЫЕ, в документации это не сказано.
  //   type=video → {url, token} — токен выдаётся сразу, ДО загрузки байтов;
  //   type=file  → {url}        — токен здесь не приходит, ищем его в ответе uploader'а
  //                              (там же может прийти «<retval>1</retval>», это просто «ок»).
  const started = await api('POST', '/uploads', { query: { type: kind } });
  if (!started?.url) throw new SendError('MAX не вернул url для загрузки');
  return { url: started.url, preToken: started.token ?? null };
}

async function openSource(source) {
  const src = await fetch(String(source), { signal: AbortSignal.timeout(15 * 60_000) });
  if (!src.ok) throw new SendError(`Источник отдал HTTP ${src.status} — файл скачать не удалось`);
  return src;
}

async function postStream(url, src, filename, size) {
  const boundary = '----priemka' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="${quoteName(filename)}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const reader = src.body.getReader();
  const body = new ReadableStream({
    start(c) { c.enqueue(head); },
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) { c.enqueue(tail); c.close(); } else c.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return fetch(url, {
    method: 'POST',
    body,
    duplex: 'half',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(head.length + size + tail.length),
    },
    signal: AbortSignal.timeout(30 * 60_000),
  });
}

async function postFromMemory(url, src, filename) {
  const form = new FormData();
  form.append('data', await src.blob(), filename);
  return fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(30 * 60_000) });
}

/** Один заход загрузки: новый url в MAX, свежее скачивание с Диска, отправка. */
async function uploadOnce(kind, filename, source, size, mode) {
  const { url, preToken } = await startUpload(kind);
  const src = await openSource(source);
  // Размер берём из ответа источника — он точнее метаданных, если файл успели заменить.
  const len = Number(src.headers.get('content-length')) || Number(size) || 0;
  const up = (mode === 'stream' && len > 0 && src.body)
    ? await postStream(url, src, filename, len)
    : await postFromMemory(url, src, filename);
  const text = await up.text();
  if (!up.ok) {
    throw new SendError(`Загрузка в MAX не удалась: HTTP ${up.status} ${redact(text).slice(0, 200)}`, { status: up.status });
  }
  return { text, preToken };
}

/** Залить файл в MAX по ссылке на источник и получить токен вложения. */
async function uploadMedia({ kind, filename, source, size }) {
  let res;
  try {
    res = await uploadOnce(kind, filename, source, size, 'stream');
  } catch (e) {
    if (!(Number(size) > 0 && Number(size) <= FALLBACK_MAX)) throw e;
    console.error(`   потоковая отправка ${filename} не удалась (${redact(e.message).slice(0, 160)}) — пробую через память`);
    res = await uploadOnce(kind, filename, source, size, 'memory');
  }
  const { text, preToken } = res;

  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* для видео приходит не JSON — это норма */ }

  const found = preToken
    ?? parsed?.token
    ?? parsed?.video?.token
    ?? parsed?.file?.token
    ?? parsed?.photo?.token
    ?? (parsed && typeof parsed === 'object'
      ? Object.values(parsed).find((v) => v && typeof v === 'object' && v.token)?.token
      : null);

  if (!found) {
    throw new SendError(
      `Загрузка прошла (${redact(text).slice(0, 80)}), но токен вложения взять неоткуда: ` +
      `в ответе /uploads?type=${kind} его не было и uploader тоже не вернул`,
    );
  }
  return found;
}

/**
 * Отправить сообщение с вложением. Вложение после загрузки готово не мгновенно:
 * MAX отвечает attachment.not.ready, и это нормальное состояние, а не ошибка — ждём и повторяем.
 */
async function sendMedia(chatId, { kind, attachToken, text = '', attempts = 12, buttons = null }) {
  // Кнопки едут ВМЕСТЕ с файлом: проверено на живом 08.09.2026 — MAX принимает
  // file и inline_keyboard в одном сообщении. Иначе после выдачи записи человек
  // оставался без меню и лез скроллить вверх за старой клавиатурой.
  const body = {
    text: text || '',
    attachments: [
      { type: kind, payload: { token: attachToken } },
      ...(buttons ? [{ type: 'inline_keyboard', payload: { buttons } }] : []),
    ],
    notify: true,
  };
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await api('POST', '/messages', { query: { chat_id: chatId }, body });
    } catch (e) {
      lastErr = e;
      const notReady = e.status === 400 && /not\.?ready|not ready/i.test(e.message);
      if (!notReady) throw e;
      await new Promise((r) => setTimeout(r, 1500 + i * 700));
    }
  }
  throw new SendError(`Вложение так и не подготовилось за ${attempts} попыток: ${lastErr?.message || ''}`);
}

/**
 * Весь путь: взять файл по ссылке и отправить его в чат.
 * Всегда ФАЙЛОМ, а не видео — решение Эмиля от 07.09.2026: видео-вложение MAX
 * перекодирует, а для показов работ важен оригинал, который скачивается байт в байт.
 */
export async function sendFileFromUrl(chatId, { url, filename, size, caption = '', buttons = null }) {
  if (Number(size) > FILE_LIMIT) {
    throw new SendError(`Файл ${filename} весит ${(size / 1024 ** 3).toFixed(2)} ГБ — это больше потолка MAX в 4 ГБ`);
  }
  const attachToken = await uploadMedia({ kind: 'file', filename, source: url, size });
  await sendMedia(chatId, { kind: 'file', attachToken, text: caption, buttons });
}
