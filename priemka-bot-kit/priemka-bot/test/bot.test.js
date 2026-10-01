/**
 * Автотесты бота: все сценарии прогоняются против эмулятора Диска и MAX (test/fake.js).
 * Запуск из папки бота:  node --test test/
 * Ни к настоящему MAX, ни к Диску тесты не обращаются, файлы бота не трогают:
 * access.json и state.json живут во временной папке.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFake } from './fake.js';

const ADMIN = 90235418, ADMIN_CHAT = 9001;
const EDITOR = 111, EDITOR_CHAT = 9111;
const EDITOR2 = 112, EDITOR2_CHAT = 9112;
const VIEWER = 222, VIEWER_CHAT = 9222;
const ROOT = 'Видеопоказы-тест';

// ----- окружение до загрузки бота: настройки читаются при импорте -----
const dataDir = mkdtempSync(join(tmpdir(), 'priemka-test-'));
writeFileSync(join(dataDir, 'access.json'), JSON.stringify({ allowed: [
  { id: ADMIN, name: 'Даниил Рыскин', role: 'admin' },
  { id: EDITOR, name: 'Руководитель Один', role: 'editor' },
  { id: EDITOR2, name: 'Руководитель Два', role: 'editor' },
  { id: VIEWER, name: 'Гость', role: 'viewer' },
] }));
const issued = new Date(Date.now() - 350 * 24 * 60 * 60_000).toISOString().slice(0, 10);
Object.assign(process.env, {
  PRIEMKA_NO_START: '1',
  PRIEMKA_DATA_DIR: dataDir,
  DISK_ROOT: ROOT,
  MAX_TOKEN: 'test-max-token',
  YANDEX_DISK_TOKEN: 'test-disk-token',
  YANDEX_TOKEN_ISSUED: issued,
  PRIEMKA_TEST_UPLOAD_WAIT_MS: '1000',
  PRIEMKA_TEST_BG_POLL_MS: '100',
});
delete process.env.ADMINS;

const fake = createFake();
globalThis.fetch = fake.fetch;
const origError = console.error, origLog = console.log;
console.log = () => {}; console.error = () => {};   // журнал работы бота в тестах не нужен

// Дерево папок, как на настоящем Диске: ГК → ОП → направление → система
const SYS_A = `/${ROOT}/ГК-1/ОП-1/Код-направления 01/Система А`;
const SYS_B = `/${ROOT}/ГК-1/ОП-1/Код-направления 01/Система Б`;
const SYS_C = `/${ROOT}/ГК-2/ОП-2/Код-направления 02/Система В`;
for (const p of [SYS_A, SYS_B, SYS_C]) fake.mkdir(p);
fake.put(`${SYS_A}/SCR#1000001.mp4`, 5000);

const { _test: bot } = await import('../bot.js');
const journal = await import('../journal.js');
const disk = await import('../yandex-disk.js');

// ----- помощники -----
let seq = 0;
const cb = (chat, user, payload) => ({ update_type: 'message_callback', timestamp: Date.now(),
  callback: { payload, user: { user_id: user } }, message: { recipient: { chat_id: chat } } });
const msg = (chat, user, text, attachments = []) => ({ update_type: 'message_created', timestamp: Date.now(),
  message: { recipient: { chat_id: chat }, sender: { user_id: user }, body: { text, attachments } } });
const fileAtt = (name, size) => {
  const url = `https://max.files.test/f${++seq}`;
  fake.sources.set(url, size);
  return { type: 'file', filename: name, size, payload: { url } };
};
// Ждём только очереди чатов: фоновая доливка (3.6) может по сценарию теста «висеть».
async function press(chat, user, payload) { bot.dispatch(cb(chat, user, payload)); await bot.idle({ withBackground: false }); }
async function say(chat, user, text, att) { bot.dispatch(msg(chat, user, text, att)); await bot.idle({ withBackground: false }); }
async function click(chat, user, label) { await press(chat, user, fake.button(chat, label)); }
const lastText = (chat) => fake.last(chat)?.text || '';
const lastFile = (chat) => fake.sent.filter((m) => m.chatId === chat && m.op === 'post' &&
  (m.attachments || []).some((a) => a.type === 'file')).at(-1);

/** Пройти опросник «Загрузить» до вопроса о номере. */
async function walkUpload(chat, user, folders) {
  await press(chat, user, 'cmd:upload');
  for (const f of folders) await click(chat, user, '📁 ' + f);
  assert.match(lastText(chat), /Введите номер SCR/);
}

test.after(() => { console.log = origLog; console.error = origError; });

// Администратор пишет боту — бот запоминает его чат для оповещений.
test('бот запоминает чат администратора для оповещений', async () => {
  await say(ADMIN_CHAT, ADMIN, '/start');
  assert.match(lastText(ADMIN_CHAT), /Выберите действие/);
  assert.equal(bot.state().adminChats.get(ADMIN), ADMIN_CHAT);
});

test('3.15 загрузка: опросник → номер → файл → запись на месте, журнал записан', async () => {
  await bot.warmTree();
  await walkUpload(EDITOR_CHAT, EDITOR, ['ГК-1', 'ОП-1', 'Код-направления 01', 'Система Б']);
  await say(EDITOR_CHAT, EDITOR, '2000002');
  assert.match(lastText(EDITOR_CHAT), /Пришлите видеозапись файлом/);
  await say(EDITOR_CHAT, EDITOR, '', [fileAtt('показ.mp4', 7000)]);
  assert.match(lastText(EDITOR_CHAT), /Видеозапись загружена/);
  assert.ok(fake.exists(`${SYS_B}/SCR#2000002.mp4`));
  await journal.flushed();
  const month = fake.files(`/${ROOT}/_Журнал`).find((p) => /\d{4}-\d{2}\.csv$/.test(p));
  assert.match(fake.nodes.get(month).content, /Загрузка видеозаписи;SCR#2000002/);
  assert.ok(bot.state().scrIndex.has('2000002'), 'новая запись попала в индекс');
});

test('3.15 повторная загрузка того же номера запрещена', async () => {
  await walkUpload(EDITOR_CHAT, EDITOR, ['ГК-2', 'ОП-2', 'Код-направления 02', 'Система В']);
  await say(EDITOR_CHAT, EDITOR, '1000001');
  assert.match(lastText(EDITOR_CHAT), /уже загружена/);
});

test('3.15 гость не может загружать', async () => {
  await press(VIEWER_CHAT, VIEWER, 'cmd:upload');
  assert.match(lastText(VIEWER_CHAT), /Загрузка недоступна/);
});

test('3.15 посторонний получает отказ со своим номером', async () => {
  await say(7777, 555555, '/start');
  assert.match(lastText(7777), /Доступ к боту не выдан[\s\S]*555555/);
});

test('3.2 поиск видит запись за пределами первой тысячи файлов Диска', async () => {
  for (let i = 0; i < 1300; i++) fake.put(`/Прочее/файл-${String(i).padStart(4, '0')}.txt`, 1);
  fake.put(`/${ROOT}/ГК-2/ОП-2/Код-направления 02/Система В/SCR#3000003.mp4`, 4000);   // мимо индекса
  const found = await bot.findByScr('3000003');
  assert.equal(found.length, 1);
  assert.match(found[0].path, /Система В\/SCR#3000003\.mp4$/);
});

test('3.2 после прогрева поиск идёт по индексу, без перебора всего Диска', async () => {
  await bot.warmTree();
  const before = fake.count('GET /disk/resources/files');
  const found = await bot.findByScr('1000001');
  assert.equal(found.length, 1);
  assert.equal(fake.count('GET /disk/resources/files'), before, 'полный перебор не понадобился');
});

test('3.2 устаревший индекс не даёт неверного ответа: запись перенесли вручную', async () => {
  fake.mkdir(`/${ROOT}/ГК-2/ОП-2/Код-направления 02/Система Г`);
  const from = `${SYS_C}/SCR#3000003.mp4`, to = `/${ROOT}/ГК-2/ОП-2/Код-направления 02/Система Г/SCR#3000003.mp4`;
  fake.nodes.set(to, fake.nodes.get(from)); fake.nodes.delete(from);
  const found = await bot.findByScr('3000003');
  assert.equal(found.length, 1);
  assert.match(found[0].path, /Система Г/);
});

test('3.3 папка больше 200 элементов читается целиком', async () => {
  for (let i = 0; i < 250; i++) fake.mkdir(`/Много/п${String(i).padStart(3, '0')}`);
  const { dirs } = await disk.listFolder('/Много');
  assert.equal(dirs.length, 250);
});

test('3.4 выдача записи идёт потоком, с точным размером', async () => {
  fake.uploads.length = 0;
  await press(VIEWER_CHAT, VIEWER, 'cmd:find');
  await say(VIEWER_CHAT, VIEWER, '1000001');
  const up = fake.uploads.at(-1);
  assert.ok(up?.streamed, 'отправлено потоком');
  assert.equal(up.contentLength, up.bytes, 'Content-Length совпадает с телом');
  assert.ok(up.body.includes(Buffer.alloc(5000, 7)), 'байты записи дошли целиком');
  assert.ok(lastFile(VIEWER_CHAT), 'в чат ушёл файл');
});

test('3.4 если поток не принят — небольшой файл уходит старым способом', async () => {
  fake.rejectStream = true;
  fake.uploads.length = 0;
  await press(VIEWER_CHAT, VIEWER, 'cmd:find');
  await say(VIEWER_CHAT, VIEWER, '1000001');
  fake.rejectStream = false;
  assert.equal(fake.uploads.length, 1);
  assert.equal(fake.uploads[0].streamed, false);
  assert.ok(lastFile(VIEWER_CHAT), 'в чат ушёл файл');
});

test('3.5 после загрузки дерево не перечитывается целиком', async () => {
  await bot.warmTree();
  const before = fake.count('GET /disk/resources');
  await walkUpload(EDITOR_CHAT, EDITOR, ['ГК-1', 'ОП-1', 'Код-направления 01', 'Система А']);
  await say(EDITOR_CHAT, EDITOR, '4000004');
  await say(EDITOR_CHAT, EDITOR, '', [fileAtt('x.mov', 3000)]);
  assert.match(lastText(EDITOR_CHAT), /загружена/);
  const spent = fake.count('GET /disk/resources') - before;
  assert.ok(spent < 25, `на загрузку ушло ${spent} запросов чтения — без полного прогрева`);
});

test('3.1 долгая загрузка в одном чате не держит другие чаты', async () => {
  fake.holdOps = true;
  await walkUpload(EDITOR_CHAT, EDITOR, ['ГК-2', 'ОП-2', 'Код-направления 02', 'Система В']);
  await say(EDITOR_CHAT, EDITOR, '5000005');
  bot.dispatch(msg(EDITOR_CHAT, EDITOR, '', [fileAtt('long.mp4', 2000)]));   // не ждём
  await new Promise((r) => setTimeout(r, 200));
  // Пока загрузка висит, другой человек спокойно работает
  bot.dispatch(cb(VIEWER_CHAT, VIEWER, 'cmd:find'));
  await new Promise((r) => setTimeout(r, 200));
  assert.match(lastText(VIEWER_CHAT), /Какую запись найти/);
  assert.match(lastText(EDITOR_CHAT), /Загружаю|ещё идёт/);
  fake.release();
  await bot.idle();
});

test('3.1 и 3.6 замок на номер; долгая загрузка доливается в фоне и присылает итог', async () => {
  fake.holdOps = true;
  await press(EDITOR_CHAT, EDITOR, 'cmd:replace');
  await say(EDITOR_CHAT, EDITOR, '1000001');
  await say(EDITOR_CHAT, EDITOR, '', [fileAtt('новая.mp4', 6000)]);
  assert.match(lastText(EDITOR_CHAT), /Проверьте перед заменой[\s\S]*БЫЛО[\s\S]*СТАНЕТ/);   // 4.17
  bot.dispatch(cb(EDITOR_CHAT, EDITOR, fake.button(EDITOR_CHAT, 'Заменить')));
  await new Promise((r) => setTimeout(r, 300));
  // Второй руководитель пытается заменить ту же запись — получает «занята», а не гонку
  await press(EDITOR2_CHAT, EDITOR2, 'cmd:replace');
  await say(EDITOR2_CHAT, EDITOR2, '1000001');
  await say(EDITOR2_CHAT, EDITOR2, '', [fileAtt('другая.mp4', 6000)]);
  await click(EDITOR2_CHAT, EDITOR2, 'Заменить');
  assert.match(lastText(EDITOR2_CHAT), /сейчас идёт другое действие/);
  // У первого истекает время ожидания в чате → «ещё идёт», бот отпускает человека
  await new Promise((r) => setTimeout(r, 1500));
  assert.match(lastText(EDITOR_CHAT), /ещё идёт/);
  assert.ok(fake.exists(`${SYS_A}/SCR#1000001.mp4`), 'пока новая не легла, старая на месте');
  fake.release();
  await bot.idle();
  assert.match(lastText(EDITOR_CHAT), /Видеозапись заменена/);
  assert.equal(fake.nodes.get(`${SYS_A}/SCR#1000001.mp4`).size, 6000, 'на месте новая версия');
  assert.ok(!fake.exists(`${SYS_A}/SCR#1000001.mp4.new`), 'временного файла не осталось');
  assert.equal(bot.state().scrBusy.size, 0, 'замок снят');
});

test('3.11 версия в архиве лежит в папке по местной дате', async () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const backups = fake.files(`/${ROOT}/BackUp`);
  assert.ok(backups.some((b) => b.startsWith(`/${ROOT}/BackUp/${today}/${EDITOR}/`) && b.endsWith('SCR#1000001.mp4')),
    backups.join('\n'));
});

test('3.6 незавершённая замена: администратор видит карточку и может завершить', async () => {
  fake.put(`${SYS_B}/SCR#6000006.mp4`, 100);
  fake.put(`${SYS_B}/SCR#6000006.mp4.new`, 200);
  await bot.warmTree();
  await new Promise((r) => setTimeout(r, 50));
  assert.match(lastText(ADMIN_CHAT), /незавершённая замена[\s\S]*SCR#6000006/i);
  // Поиск временный файл записью не считает
  const found = await bot.findByScr('6000006');
  assert.equal(found.length, 1);
  assert.match(found[0].name, /\.mp4$/);
  await click(ADMIN_CHAT, ADMIN, 'Завершить замену');
  assert.match(lastText(ADMIN_CHAT), /Замена SCR#6000006 завершена/);
  assert.equal(fake.nodes.get(`${SYS_B}/SCR#6000006.mp4`).size, 200);
  assert.ok(!fake.exists(`${SYS_B}/SCR#6000006.mp4.new`));
});

test('3.7 не хватает места — загрузка не начинается', async () => {
  const opsBefore = fake.ops.size;
  fake.total = fake.used() + 1000;
  await walkUpload(EDITOR_CHAT, EDITOR, ['ГК-1', 'ОП-1', 'Код-направления 01', 'Система А']);
  await say(EDITOR_CHAT, EDITOR, '7000007');
  await say(EDITOR_CHAT, EDITOR, '', [fileAtt('big.mp4', 50_000)]);
  fake.total = 1000 * 1024 ** 3;
  assert.match(lastText(EDITOR_CHAT), /не хватает места/);
  assert.equal(fake.ops.size, opsBefore, 'загрузка на Диск не запускалась');
});

test('3.12 два файла с одним номером — бот показывает оба и даёт выбрать', async () => {
  fake.put(`${SYS_A}/SCR#8000008.mp4`, 111);
  fake.put(`${SYS_C}/SCR#8000008.mp4`, 222);
  await bot.warmTree();
  fake.uploads.length = 0;
  await press(VIEWER_CHAT, VIEWER, 'cmd:find');
  await say(VIEWER_CHAT, VIEWER, '8000008');
  assert.match(lastText(VIEWER_CHAT), /несколько: 2/);
  await click(VIEWER_CHAT, VIEWER, '2)');
  assert.equal(fake.uploads.length, 1, 'выбранная запись отправлена');
});

test('3.12 перенос: запись переезжает, индекс обновлён', async () => {
  await press(EDITOR_CHAT, EDITOR, 'cmd:move');
  await say(EDITOR_CHAT, EDITOR, '4000004');
  for (const f of ['ГК-2', 'ОП-2', 'Код-направления 02', 'Система В']) await click(EDITOR_CHAT, EDITOR, '📁 ' + f);
  await click(EDITOR_CHAT, EDITOR, 'Переместить');
  assert.match(lastText(EDITOR_CHAT), /Видеозапись перемещена/);
  assert.ok(fake.exists(`${SYS_C}/SCR#4000004.mov`));
  assert.match(bot.state().scrIndex.get('4000004')[0].path, /Система В/);
});

test('3.14 права перепроверяются на шаге, который меняет Диск', async () => {
  await walkUpload(EDITOR2_CHAT, EDITOR2, ['ГК-1', 'ОП-1', 'Код-направления 01', 'Система А']);
  await say(EDITOR2_CHAT, EDITOR2, '9000009');
  bot.setAccess([{ id: ADMIN, role: 'admin' }, { id: EDITOR, role: 'editor' }, { id: EDITOR2, role: 'viewer' }, { id: VIEWER, role: 'viewer' }]);
  await say(EDITOR2_CHAT, EDITOR2, '', [fileAtt('a.mp4', 100)]);
  assert.match(lastText(EDITOR2_CHAT), /больше недоступно/);
  assert.ok(!fake.exists(`${SYS_A}/SCR#9000009.mp4`));
});

test('3.8 нет доступа к Диску — администратору приходит оповещение, но не чаще раза в час', async () => {
  fake.authFail = true;
  const before = fake.texts(ADMIN_CHAT).filter((t) => /нет доступа к Яндекс\.Диску/.test(t)).length;
  await press(VIEWER_CHAT, VIEWER, 'cmd:find');
  await say(VIEWER_CHAT, VIEWER, '1234567');
  await press(VIEWER_CHAT, VIEWER, 'cmd:find');
  await say(VIEWER_CHAT, VIEWER, '1234567');
  fake.authFail = false;
  const after = fake.texts(ADMIN_CHAT).filter((t) => /нет доступа к Яндекс\.Диску/.test(t)).length;
  assert.equal(after - before, 1);
  assert.match(lastText(VIEWER_CHAT), /нет доступа к Диску/);
});

test('3.8 и 3.10 проверка здоровья: мало места и скорое истечение токена', async () => {
  fake.total = fake.used() + 1024;   // свободно почти ноль
  await bot.healthTick();
  fake.total = 1000 * 1024 ** 3;
  const texts = fake.texts(ADMIN_CHAT).join('\n');
  assert.match(texts, /осталось мало места/);
  assert.match(texts, /Токен Яндекс\.Диска истекает примерно через \d+ дн/);
});

test('3.9 основные администраторы берутся из .env, при ошибке — значение по умолчанию', () => {
  const run = (admins) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `const c = await import(${JSON.stringify(new URL('../config.js', import.meta.url).href)}); console.log(JSON.stringify(c.ADMINS));`],
  { env: { ...process.env, ADMINS: admins }, encoding: 'utf8' }).stdout.trim();
  assert.equal(run('111, 222'), '[111,222]');
  assert.equal(run(''), '[90235418]');
  assert.equal(run('abc'), '[90235418]');
});

test('3.13 ротация журнала: вне start-bot.cmd бот сам не перезапускается', () => {
  delete process.env.PRIEMKA_SUPERVISED;
  bot.rotateLogIfNeeded();   // если бы сработало — process.exit, и тест бы оборвался
  assert.ok(true);
});

test('состояние пишется в папку данных, а не в папку бота', async () => {
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(existsSync(join(dataDir, 'state.json')));
  const st = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
  assert.equal(st.adminChats[ADMIN], ADMIN_CHAT);
});
