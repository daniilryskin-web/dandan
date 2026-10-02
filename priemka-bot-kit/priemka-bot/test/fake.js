/**
 * Эмулятор Яндекс.Диска и MAX для автотестов: подменяет глобальный fetch, в сеть
 * ничего не уходит. Повторяет ровно то поведение API, на которое опирается бот:
 * коды ответов, форму JSON, постраничность, асинхронные операции загрузки.
 */

const DISK = 'https://cloud-api.yandex.net/v1';
const MAX = 'https://platform-api2.max.ru';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const norm = (p) => '/' + String(p).replace(/^disk:/i, '').split('/').filter(Boolean).join('/');
const parent = (p) => norm(p).slice(0, norm(p).lastIndexOf('/')) || '/';
const nameOf = (p) => norm(p).split('/').pop();

export function createFake() {
  const fake = {
    // ----- Диск -----
    nodes: new Map([['/', { type: 'dir' }]]),   // путь → { type, size, created, content }
    total: 1000 * 1024 ** 3,
    sources: new Map(),        // url вложения в MAX → размер файла
    ops: new Map(),            // id операции → { status, onDone, polls }
    holdOps: false,            // true — загрузки висят «in-progress», пока не release()
    authFail: false,           // true — Диск на всё отвечает 401
    calls: [],                 // журнал запросов: 'GET /disk/resources/files' и т. п.
    // ----- MAX -----
    sent: [],                  // { op: 'post'|'put'|'delete', chatId, mid, text, buttons, attachments }
    mids: new Map(),           // mid → chatId
    uploads: [],               // что пришло на сервер загрузки MAX
    rejectStream: false,       // true — сервер загрузки MAX отбивает потоковую отправку
    blobs: new Map(),          // url вложения в MAX → содержимое (реестр для сверки)
    commands: null,            // что бот прислал в PATCH /me
    published: 0,              // сколько публичных ссылок открыто
    publishLimit: null,        // число — Диск отбивает публикации сверх него (403)

    mkdir(path) {
      const segs = norm(path).split('/').filter(Boolean);
      let cur = '';
      for (const s of segs) { cur += '/' + s; if (!this.nodes.has(cur)) this.nodes.set(cur, { type: 'dir' }); }
    },
    put(path, size = 1000, content = null) {
      this.mkdir(parent(path));
      this.nodes.set(norm(path), { type: 'file', size, created: new Date().toISOString(), content });
    },
    exists: (path) => fake.nodes.has(norm(path)),
    files(prefix = '/') {
      return [...this.nodes].filter(([p, n]) => n.type === 'file' && p.startsWith(norm(prefix))).map(([p]) => p);
    },
    used() { let n = 0; for (const v of this.nodes.values()) if (v.type === 'file') n += v.size || 0; return n; },
    release() { this.holdOps = false; },
    count(prefix) { return this.calls.filter((c) => c.startsWith(prefix)).length; },

    /** Последнее, что бот показал в этом чате (новое сообщение или правка экрана). */
    last(chatId) { return [...this.sent].reverse().find((m) => m.chatId === chatId && m.op !== 'delete'); },
    texts(chatId) { return this.sent.filter((m) => m.chatId === chatId && m.op !== 'delete').map((m) => m.text); },
    /** Кнопка с таким текстом на последнем экране чата. */
    button(chatId, label) {
      const m = this.last(chatId);
      const all = (m?.buttons || []).flat();
      const b = all.find((x) => x.text.includes(label));
      if (!b) throw new Error(`Нет кнопки «${label}» на экране:\n${m?.text}\nкнопки: ${all.map((x) => x.text).join(' | ')}`);
      return b.payload;
    },
  };

  function resource(path, n) {
    const r = { name: nameOf(path) || 'disk', path: 'disk:' + path, type: n.type };
    if (n.type === 'file') { r.size = n.size; r.created = n.created; r.file = `https://downloader.disk.test/get?path=${encodeURIComponent(path)}`; }
    if (n.public_url) r.public_url = n.public_url;
    return r;
  }

  function children(path) {
    const pre = path === '/' ? '/' : path + '/';
    return [...fake.nodes.keys()]
      .filter((p) => p !== path && p.startsWith(pre) && !p.slice(pre.length).includes('/'))
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  }

  async function disk(method, url) {
    const q = url.searchParams;
    const ep = url.pathname.replace('/v1', '');
    fake.calls.push(`${method} ${ep}`);
    if (fake.authFail) return json({ error: 'UnauthorizedError', message: 'Unauthorized' }, 401);

    if (ep === '/disk' && method === 'GET') return json({ total_space: fake.total, used_space: fake.used() });

    if (ep === '/disk/resources' && method === 'GET') {
      const path = norm(q.get('path'));
      const n = fake.nodes.get(path);
      if (!n) return json({ error: 'DiskNotFoundError' }, 404);
      const r = resource(path, n);
      if (n.type === 'dir') {
        const limit = Number(q.get('limit') || 20);
        const offset = Number(q.get('offset') || 0);
        r._embedded = { items: children(path).slice(offset, offset + limit).map((p) => resource(p, fake.nodes.get(p))) };
      }
      return json(r);
    }

    if (ep === '/disk/resources' && method === 'PUT') {
      const path = norm(q.get('path'));
      if (fake.nodes.has(path)) return json({ error: 'DiskPathPointsToExistentDirectoryError' }, 409);
      if (!fake.nodes.has(parent(path))) return json({ error: 'DiskPathDoesntExistsError' }, 409);
      fake.nodes.set(path, { type: 'dir' });
      return json({ href: '' }, 201);
    }

    if (ep === '/disk/resources/upload' && method === 'POST') {
      const path = norm(q.get('path'));
      if (!fake.nodes.has(parent(path))) return json({ error: 'DiskPathDoesntExistsError' }, 409);
      if (fake.nodes.has(path)) return json({ error: 'DiskResourceAlreadyExistsError' }, 409);
      const size = fake.sources.get(q.get('url')) ?? 1234;
      const id = 'op' + (fake.ops.size + 1);
      fake.ops.set(id, { status: 'in-progress', onDone: () => fake.put(path, size) });
      return json({ href: `${DISK}/disk/operations/${id}`, method: 'GET' }, 202);
    }

    if (ep.startsWith('/disk/operations/') && method === 'GET') {
      const op = fake.ops.get(ep.split('/').pop());
      if (!op) return json({ error: 'DiskNotFoundError' }, 404);
      if (op.status === 'in-progress' && !fake.holdOps) { op.onDone(); op.status = 'success'; }
      return json({ status: op.status });
    }

    if (ep === '/disk/resources/upload' && method === 'GET') {
      const path = norm(q.get('path'));
      return json({ href: `https://uploader.disk.test/put?path=${encodeURIComponent(path)}`, method: 'PUT', templated: false });
    }

    if (ep === '/disk/resources/move' && method === 'POST') {
      const from = norm(q.get('from'));
      const to = norm(q.get('path'));
      if (!fake.nodes.has(from)) return json({ error: 'DiskNotFoundError' }, 404);
      if (!fake.nodes.has(parent(to))) return json({ error: 'DiskPathDoesntExistsError' }, 409);
      if (fake.nodes.has(to) && q.get('overwrite') !== 'true') return json({ error: 'DiskResourceAlreadyExistsError' }, 409);
      for (const [p, n] of [...fake.nodes]) {
        if (p === from || p.startsWith(from + '/')) { fake.nodes.delete(p); fake.nodes.set(to + p.slice(from.length), n); }
      }
      return json({ href: '' }, 201);
    }

    if (ep === '/disk/resources/copy' && method === 'POST') {
      const from = norm(q.get('from'));
      const to = norm(q.get('path'));
      if (!fake.nodes.has(from)) return json({ error: 'DiskNotFoundError' }, 404);
      if (!fake.nodes.has(parent(to))) return json({ error: 'DiskPathDoesntExistsError' }, 409);
      if (fake.nodes.has(to) && q.get('overwrite') !== 'true') return json({ error: 'DiskResourceAlreadyExistsError' }, 409);
      fake.nodes.set(to, { ...fake.nodes.get(from) });
      return json({ href: '' }, 201);
    }

    if ((ep === '/disk/resources/publish' || ep === '/disk/resources/unpublish') && method === 'PUT') {
      const path = norm(q.get('path'));
      const n = fake.nodes.get(path);
      if (!n) return json({ error: 'DiskNotFoundError' }, 404);
      if (ep.endsWith('/publish')) {
        if (fake.publishLimit !== null && fake.published >= fake.publishLimit) return json({ error: 'DiskPublishLimitError' }, 403);
        if (!n.public_url) { fake.published++; n.public_url = `https://disk.yandex.ru/d/pub${fake.published}`; }
      } else delete n.public_url;
      return json({ href: `${DISK}/disk/resources?path=${encodeURIComponent(path)}`, method: 'GET', templated: false });
    }

    if (ep === '/disk/resources/files' && method === 'GET') {
      const limit = Number(q.get('limit') || 20);
      const offset = Number(q.get('offset') || 0);
      const all = fake.files().sort();
      return json({ items: all.slice(offset, offset + limit).map((p) => resource(p, fake.nodes.get(p))) });
    }

    if (ep === '/disk/resources/download' && method === 'GET') {
      const path = norm(q.get('path'));
      if (!fake.nodes.has(path)) return json({ error: 'DiskNotFoundError' }, 404);
      return json({ href: `https://downloader.disk.test/get?path=${encodeURIComponent(path)}` });
    }

    return json({ error: 'NotImplemented', message: `${method} ${ep}` }, 501);
  }

  async function readBody(body) {
    if (body == null) return Buffer.alloc(0);
    if (typeof body === 'string') return Buffer.from(body);
    if (body instanceof Uint8Array) return Buffer.from(body);
    return Buffer.from(await new Response(body).arrayBuffer());   // поток, Blob, FormData
  }

  async function max(method, url, opt) {
    const q = url.searchParams;
    const body = opt.body ? JSON.parse(opt.body) : null;
    const kb = (b) => b?.attachments?.find((a) => a.type === 'inline_keyboard')?.payload?.buttons || null;
    if (url.pathname === '/me' && method === 'PATCH') { fake.commands = body?.commands || null; return json({ name: 'Тестовый бот' }); }
    if (url.pathname === '/me') return json({ name: 'Тестовый бот', username: 'test_bot' });
    if (url.pathname === '/messages' && method === 'POST') {
      const chatId = Number(q.get('chat_id'));
      const mid = 'm' + (fake.mids.size + 1);
      fake.mids.set(mid, chatId);
      fake.sent.push({ op: 'post', chatId, mid, text: body?.text, buttons: kb(body), attachments: body?.attachments || [] });
      return json({ message: { body: { mid } } });
    }
    if (url.pathname === '/messages' && method === 'PUT') {
      const mid = q.get('message_id');
      if (!fake.mids.has(mid)) return json({ code: 'not.found' }, 404);
      fake.sent.push({ op: 'put', chatId: fake.mids.get(mid), mid, text: body?.text, buttons: kb(body) });
      return json({ success: true });
    }
    if (url.pathname === '/messages' && method === 'DELETE') {
      const mid = q.get('message_id');
      fake.sent.push({ op: 'delete', chatId: fake.mids.get(mid), mid });
      fake.mids.delete(mid);
      return json({ success: true });
    }
    if (url.pathname === '/uploads' && method === 'POST') {
      return json({ url: `https://fu.max.test/upload?n=${fake.uploads.length + 1}` });
    }
    return json({ code: 'not.implemented' }, 501);
  }

  fake.fetch = async (input, opt = {}) => {
    const url = new URL(String(input));
    const method = (opt.method || 'GET').toUpperCase();
    const headers = new Headers(opt.headers || {});
    if (url.origin === new URL(DISK).origin) return disk(method, url);
    if (url.origin === MAX) return max(method, url, opt);

    if (url.hostname === 'uploader.disk.test') {           // заливка журнала и выгрузок
      const buf = await readBody(opt.body);
      fake.put(url.searchParams.get('path'), buf.length, buf.toString('utf8'));
      return new Response('', { status: 201 });
    }
    if (url.hostname === 'downloader.disk.test') {         // скачивание записи или журнала
      const n = fake.nodes.get(norm(url.searchParams.get('path')));
      if (!n) return new Response('', { status: 404 });
      const buf = n.content != null ? Buffer.from(n.content, 'utf8') : Buffer.alloc(n.size, 7);
      return new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } });
    }
    if (url.hostname === 'max.files.test') {               // файл, присланный человеком в чат
      const b = fake.blobs.get(url.href);
      return b ? new Response(b, { status: 200 }) : new Response('', { status: 404 });
    }
    if (url.hostname === 'fu.max.test') {                  // сервер загрузки файлов MAX
      const ct = headers.get('content-type') || '';
      const streamed = ct.includes('----priemka');
      if (streamed && fake.rejectStream) { await readBody(opt.body).catch(() => {}); return new Response('stream rejected', { status: 500 }); }
      const buf = await readBody(opt.body);
      fake.uploads.push({ streamed, bytes: buf.length, contentLength: Number(headers.get('content-length')) || null, body: buf });
      return json({ token: 'tok' + fake.uploads.length });
    }
    return new Response('unknown host ' + url.hostname, { status: 599 });
  };

  return fake;
}
