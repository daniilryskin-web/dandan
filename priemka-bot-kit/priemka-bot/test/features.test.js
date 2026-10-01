/**
 * Автотесты новых функций (4.1–4.20) — тоже на эмуляторе Диска и MAX, без сети.
 * Отдельный файл — отдельный процесс: своё состояние бота и своя временная папка данных.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFake } from './fake.js';

const ADMIN = 90235418, ADMIN_CHAT = 9001;
const EDITOR = 111, EDITOR_CHAT = 9111;
const VIEWER = 222, VIEWER_CHAT = 9222;
const ROOT = 'Видеопоказы-тест';

const dataDir = mkdtempSync(join(tmpdir(), 'priemka-feat-'));
writeFileSync(join(dataDir, 'access.json'), JSON.stringify({ allowed: [
  { id: ADMIN, name: 'Даниил Рыскин', role: 'admin' },
  { id: EDITOR, name: 'Руководитель Один', role: 'editor' },
  { id: VIEWER, name: 'Гость Первый', role: 'viewer' },
] }));
Object.assign(process.env, {
  PRIEMKA_NO_START: '1', PRIEMKA_DATA_DIR: dataDir, DISK_ROOT: ROOT,
  MAX_TOKEN: 'test-max-token', YANDEX_DISK_TOKEN: 'test-disk-token',
  PRIEMKA_TEST_UPLOAD_WAIT_MS: '60000', PRIEMKA_TEST_BG_POLL_MS: '100', PRIEMKA_TEST_PROGRESS_MS: '100',
});
delete process.env.ADMINS;
delete process.env.YANDEX_TOKEN_ISSUED;

const fake = createFake();
globalThis.fetch = fake.fetch;
const origError = console.error, origLog = console.log;
console.log = () => {}; console.error = () => {};

const SYS_A = `/${ROOT}/ГК-1/ОП-1/Код-направления 01/Система А`;
const SYS_B = `/${ROOT}/ГК-1/ОП-1/Код-направления 01/Система Б`;
const SYS_C = `/${ROOT}/ГК-2/ОП-1/Код-направления 02/Система В`;
for (const p of [SYS_A, SYS_B, SYS_C]) fake.mkdir(p);
for (let i = 2; i <= 15; i++) fake.mkdir(`/${ROOT}/ГК-2/ОП-${String(i).padStart(2, '0')}/Код-направления 02/Система В`);
fake.put(`${SYS_A}/SCR#1111111.mp4`, 1000);
fake.put(`${SYS_A}/SCR#2222222.mp4`, 2000);

const { _test: bot } = await import('../bot.js');
const journal = await import('../journal.js');
const { readXlsxCells, writeXlsx } = await import('../xlsx.js');
await bot.warmTree();

let seq = 0;
const cb = (chat, user, payload, extra = {}) => ({ update_type: 'message_callback', timestamp: Date.now(),
  callback: { payload, user: { user_id: user, ...extra } }, message: { recipient: { chat_id: chat } } });
const msg = (chat, user, text, attachments = []) => ({ update_type: 'message_created', timestamp: Date.now(),
  message: { recipient: { chat_id: chat }, sender: { user_id: user }, body: { text, attachments } } });
const fileAtt = (name, size) => {
  const url = `https://max.files.test/f${++seq}`;
  fake.sources.set(url, size);
  return { type: 'file', filename: name, size, payload: { url } };
};
const blobAtt = (name, buf) => {
  const url = `https://max.files.test/b${++seq}`;
  fake.blobs.set(url, buf);
  return { type: 'file', filename: name, size: buf.length, payload: { url } };
};
async function press(chat, user, payload, extra) { bot.dispatch(cb(chat, user, payload, extra)); await bot.idle({ withBackground: false }); }
async function say(chat, user, text, att) { bot.dispatch(msg(chat, user, text, att)); await bot.idle({ withBackground: false }); }
async function click(chat, user, label) { await press(chat, user, fake.button(chat, label)); }
const lastText = (chat) => fake.last(chat)?.text || '';
const lastFilePost = (chat) => fake.sent.filter((m) => m.chatId === chat && m.op === 'post' &&
  (m.attachments || []).some((a) => a.type === 'file')).at(-1);
const buttons = (chat) => (fake.last(chat)?.buttons || []).flat().map((b) => b.text);
/** xlsx из последней отправки файла в MAX: вынимаем zip из multipart-тела. */
function lastXlsx() {
  const body = fake.uploads.at(-1).body;
  const start = body.indexOf(Buffer.from('PK\x03\x04', 'binary'));
  const end = body.lastIndexOf(Buffer.from('\r\n--'));
  return body.subarray(start, end);
}
async function upload(chat, user, folders, scr, name, size = 3000) {
  await press(chat, user, 'cmd:upload');
  for (const f of folders) await click(chat, user, '📁 ' + f);
  await say(chat, user, scr);
  await say(chat, user, '', [fileAtt(name, size)]);
}

test.after(() => { console.log = origLog; console.error = origError; });

test('администратор и руководитель пишут боту — чаты известны', async () => {
  await say(ADMIN_CHAT, ADMIN, '/start');
  await say(EDITOR_CHAT, EDITOR, '/start');
  assert.match(lastText(ADMIN_CHAT), /Выберите действие/);
});

test('4.15 и 4.20 шаги загрузки и единая карточка результата', async () => {
  await press(EDITOR_CHAT, EDITOR, 'cmd:upload');
  assert.match(lastText(EDITOR_CHAT), /📤 Загрузка · шаг 1 из 6/);
  await click(EDITOR_CHAT, EDITOR, '📁 ГК-1');
  assert.match(lastText(EDITOR_CHAT), /шаг 2 из 6\nГК-1/);
  for (const f of ['ОП-1', 'Код-направления 01', 'Система Б']) await click(EDITOR_CHAT, EDITOR, '📁 ' + f);
  assert.match(lastText(EDITOR_CHAT), /шаг 5 из 6\nГК-1 → ОП-1 → 01 → Система Б/);
  await say(EDITOR_CHAT, EDITOR, '3333333');
  assert.match(lastText(EDITOR_CHAT), /шаг 6 из 6/);
  await say(EDITOR_CHAT, EDITOR, '', [fileAtt('показ.mp4', 3000)]);
  assert.match(lastText(EDITOR_CHAT), /^✅ Видеозапись загружена\n\nНомер: SCR#3333333\nГК: ГК-1\nОП: ОП-1\nНаправление: 01\nСистема: Система Б\nРазмер: /);
});

test('4.6 «Ещё запись сюда» и «В прошлую папку» ведут сразу к номеру', async () => {
  assert.ok(buttons(EDITOR_CHAT).some((t) => t.includes('Ещё запись сюда')));
  await click(EDITOR_CHAT, EDITOR, 'Ещё запись сюда');
  assert.match(lastText(EDITOR_CHAT), /Введите номер SCR[\s\S]*/);
  assert.match(lastText(EDITOR_CHAT), /Система Б/);
  await press(EDITOR_CHAT, EDITOR, 'cmd:upload');
  assert.ok(buttons(EDITOR_CHAT).some((t) => t.startsWith('↩️ В прошлую папку: ГК-1 → ОП-1')), buttons(EDITOR_CHAT).join(' | '));
  await click(EDITOR_CHAT, EDITOR, 'В прошлую папку');
  assert.match(lastText(EDITOR_CHAT), /Введите номер SCR/);
});

test('4.7 сверка номера с именем файла: предупреждение и исправление без повторной отправки', async () => {
  await say(EDITOR_CHAT, EDITOR, '4444444');
  await say(EDITOR_CHAT, EDITOR, '', [fileAtt('SCR#4444445.mp4', 3000)]);
  assert.match(lastText(EDITOR_CHAT), /Проверьте номер[\s\S]*SCR#4444444[\s\S]*4444445/);
  await click(EDITOR_CHAT, EDITOR, 'Ввести другой номер');
  await say(EDITOR_CHAT, EDITOR, '4444445');
  assert.match(lastText(EDITOR_CHAT), /Видеозапись загружена[\s\S]*SCR#4444445/);
  assert.ok(fake.exists(`${SYS_B}/SCR#4444445.mp4`));
  // Совпадает — ничего не спрашивает
  await press(EDITOR_CHAT, EDITOR, 'again');
  await say(EDITOR_CHAT, EDITOR, '5555555');
  await say(EDITOR_CHAT, EDITOR, '', [fileAtt('SCR#5555555.mp4', 3000)]);
  assert.match(lastText(EDITOR_CHAT), /Видеозапись загружена/);
});

test('4.18 ход загрузки: сообщение «прошло …» обновляется и потом убирается', async () => {
  fake.holdOps = true;
  await press(EDITOR_CHAT, EDITOR, 'again');
  await say(EDITOR_CHAT, EDITOR, '6666666');
  const before = fake.sent.length;
  bot.dispatch(msg(EDITOR_CHAT, EDITOR, '', [fileAtt('long.mp4', 3000)]));
  await new Promise((r) => setTimeout(r, 450));
  const edits = fake.sent.slice(before).filter((m) => m.op === 'put' && /Загружаю SCR#6666666 · прошло/.test(m.text));
  assert.ok(edits.length >= 2, `правок «прошло»: ${edits.length}`);
  fake.release();
  await bot.idle();
  const progMid = edits[0].mid;
  assert.ok(fake.sent.some((m) => m.op === 'delete' && m.mid === progMid), 'сообщение хода загрузки убрано');
  assert.match(lastText(EDITOR_CHAT), /Видеозапись загружена/);
});

test('4.17 замена — только после подтверждения «было → станет»; «В начало» отменяет', async () => {
  await press(EDITOR_CHAT, EDITOR, 'cmd:replace');
  assert.match(lastText(EDITOR_CHAT), /Замена · шаг 1 из 3/);
  await say(EDITOR_CHAT, EDITOR, '1111111');
  await say(EDITOR_CHAT, EDITOR, '', [fileAtt('новая.mov', 1500)]);
  assert.match(lastText(EDITOR_CHAT), /шаг 3 из 3[\s\S]*БЫЛО: SCR#1111111\.mp4[\s\S]*СТАНЕТ: новая\.mov/);
  await press(EDITOR_CHAT, EDITOR, 'cmd:menu');
  assert.ok(fake.exists(`${SYS_A}/SCR#1111111.mp4`), 'отмена — ничего не заменилось');
  await press(EDITOR_CHAT, EDITOR, 'cmd:replace');
  await say(EDITOR_CHAT, EDITOR, '1111111');
  await say(EDITOR_CHAT, EDITOR, '', [fileAtt('новая.mov', 1500)]);
  await click(EDITOR_CHAT, EDITOR, 'Заменить');
  assert.match(lastText(EDITOR_CHAT), /Видеозапись заменена/);
  assert.ok(fake.exists(`${SYS_A}/SCR#1111111.mov`));
  assert.ok(!fake.exists(`${SYS_A}/SCR#1111111.mp4`));
});

test('4.3 обзор: папки и записи, карточка с действиями; гостю обзор не положен', async () => {
  await press(EDITOR_CHAT, EDITOR, 'cmd:browse');
  for (const f of ['ГК-1', 'ОП-1', 'Код-направления 01', 'Система А']) await click(EDITOR_CHAT, EDITOR, '📁 ' + f);
  assert.match(lastText(EDITOR_CHAT), /Видео в папке: 2/);
  await click(EDITOR_CHAT, EDITOR, '🎞 SCR#2222222');
  assert.match(lastText(EDITOR_CHAT), /🎞 Видеозапись[\s\S]*SCR#2222222/);
  const b = buttons(EDITOR_CHAT);
  for (const want of ['Получить файл', 'Заменить', 'Переместить', 'Версии', 'Добавить комментарий', 'К папке']) {
    assert.ok(b.some((t) => t.includes(want)), `нет «${want}»: ${b.join(' | ')}`);
  }
  assert.ok(!b.some((t) => t.includes('Удалить запись')), 'руководителю удаление не положено');
  await click(EDITOR_CHAT, EDITOR, 'К папке');
  assert.match(lastText(EDITOR_CHAT), /Видео в папке: 2/);

  await say(VIEWER_CHAT, VIEWER, '/start');
  assert.ok(!buttons(VIEWER_CHAT).some((t) => t.includes('Обзор')));
  await press(VIEWER_CHAT, VIEWER, 'cmd:browse');
  assert.match(lastText(VIEWER_CHAT), /недоступно/);
});

test('обзор: на каждом уровне — сколько видео внутри, со всеми вложенными папками', async () => {
  await bot.warmTree();
  await press(EDITOR_CHAT, EDITOR, 'cmd:browse');
  // Всего видео на корневом уровне — столько, сколько записей в индексе (всё дерево).
  const root = lastText(EDITOR_CHAT);
  const total = [...bot.state().scrIndex.values()].flat().length;
  assert.match(root, new RegExp(`Папок: 2 · всего видео: ${total}`));
  const b = buttons(EDITOR_CHAT);
  const gk1 = b.find((t) => t.startsWith('📁 ГК-1'));
  assert.match(gk1, /^📁 ГК-1 — \d+ видео$/);
  await click(EDITOR_CHAT, EDITOR, '📁 ГК-1');
  await click(EDITOR_CHAT, EDITOR, '📁 ОП-1');
  await click(EDITOR_CHAT, EDITOR, '📁 Код-направления 01');
  assert.ok(buttons(EDITOR_CHAT).includes('📁 Система А — 2 видео'), buttons(EDITOR_CHAT).join(' | '));
  assert.ok(buttons(EDITOR_CHAT).some((t) => t.startsWith('📁 Система Б — ')));
  await press(EDITOR_CHAT, EDITOR, 'cmd:browse');
  await click(EDITOR_CHAT, EDITOR, '📁 ГК-2');
  assert.ok(buttons(EDITOR_CHAT).some((t) => t === '📁 ОП-02 — пусто'));
  await press(EDITOR_CHAT, EDITOR, 'cmd:menu');
});

test('4.16 страницы: 15 периодов — по 10 кнопок с переключателем', async () => {
  await press(EDITOR_CHAT, EDITOR, 'cmd:upload');
  await click(EDITOR_CHAT, EDITOR, '📁 ГК-2');
  const first = buttons(EDITOR_CHAT).filter((t) => t.startsWith('📁'));
  assert.equal(first.length, 10);
  assert.ok(buttons(EDITOR_CHAT).includes('1 / 2'));
  assert.match(lastText(EDITOR_CHAT), /Страница 1 из 2/);
  await click(EDITOR_CHAT, EDITOR, 'Дальше');
  const second = buttons(EDITOR_CHAT).filter((t) => t.startsWith('📁'));
  assert.equal(second.length, 5);
  await click(EDITOR_CHAT, EDITOR, '📁 ОП-15');
  assert.match(lastText(EDITOR_CHAT), /ГК-2 → ОП-15/);
  await press(EDITOR_CHAT, EDITOR, 'cmd:menu');
});

test('4.10 комментарий: сохраняется на Диске, виден в карточке и при поиске, убирается', async () => {
  await press(EDITOR_CHAT, EDITOR, 'cmd:browse');
  for (const f of ['ГК-1', 'ОП-1', 'Код-направления 01', 'Система А']) await click(EDITOR_CHAT, EDITOR, '📁 ' + f);
  await click(EDITOR_CHAT, EDITOR, '🎞 SCR#2222222');
  await click(EDITOR_CHAT, EDITOR, 'Добавить комментарий');
  await say(EDITOR_CHAT, EDITOR, 'Показ 12.09, принимал Иванов');
  assert.match(lastText(EDITOR_CHAT), /💬 Показ 12\.09, принимал Иванов[\s\S]*Комментарий сохранён/);
  const metaFile = fake.nodes.get(`/${ROOT}/_Служебное/записи.json`);
  assert.match(metaFile.content, /Показ 12\.09/);
  // При поиске комментарий — в подписи к файлу
  await press(VIEWER_CHAT, VIEWER, 'cmd:find');
  await say(VIEWER_CHAT, VIEWER, '2222222');
  const sentFile = fake.sent.filter((m) => m.chatId === VIEWER_CHAT && m.op === 'post').at(-1);
  assert.match(sentFile.text, /💬 Показ 12\.09/);
  // Убрать
  await press(EDITOR_CHAT, EDITOR, 'ra:open');
  await click(EDITOR_CHAT, EDITOR, 'Убрать комментарий');
  assert.doesNotMatch(lastText(EDITOR_CHAT), /💬 Показ/);
});

test('4.4 версии: список после замен и восстановление; архивная копия остаётся', async () => {
  for (const size of [2100, 2200]) {
    await press(EDITOR_CHAT, EDITOR, 'cmd:replace');
    await say(EDITOR_CHAT, EDITOR, '2222222');
    await say(EDITOR_CHAT, EDITOR, '', [fileAtt('v.mp4', size)]);
    await click(EDITOR_CHAT, EDITOR, 'Заменить');
    await new Promise((r) => setTimeout(r, 1100));   // разное время в именах версий
  }
  assert.equal(fake.nodes.get(`${SYS_A}/SCR#2222222.mp4`).size, 2200);
  await press(EDITOR_CHAT, EDITOR, 'cmd:browse');
  for (const f of ['ГК-1', 'ОП-1', 'Код-направления 01', 'Система А']) await click(EDITOR_CHAT, EDITOR, '📁 ' + f);
  await click(EDITOR_CHAT, EDITOR, '🎞 SCR#2222222');
  await click(EDITOR_CHAT, EDITOR, 'Версии');
  const t = lastText(EDITOR_CHAT);
  assert.match(t, /Версии SCR#2222222/);
  assert.match(t, /1\) .* заменил: Руководитель Один · 0,0 МБ/);
  assert.match(t, /2\) /);
  const backupsBefore = fake.files(`/${ROOT}/BackUp`).filter((p) => p.includes('2222222')).length;
  await click(EDITOR_CHAT, EDITOR, 'Восстановить 2)');                  // самая старая — 2000 байт
  assert.match(lastText(EDITOR_CHAT), /Восстановить версию SCR#2222222\?/);
  await click(EDITOR_CHAT, EDITOR, '✅ Восстановить');
  assert.match(lastText(EDITOR_CHAT), /Версия восстановлена/);
  assert.equal(fake.nodes.get(`${SYS_A}/SCR#2222222.mp4`).size, 2000);
  const backupsAfter = fake.files(`/${ROOT}/BackUp`).filter((p) => p.includes('2222222')).length;
  assert.equal(backupsAfter, backupsBefore + 1, 'текущая ушла в архив, а архивная копия осталась');
});

test('4.8 удаление — только в архив; найти → «в архиве» → вернуть на прежнее место', async () => {
  await press(ADMIN_CHAT, ADMIN, 'cmd:browse');
  for (const f of ['ГК-1', 'ОП-1', 'Код-направления 01', 'Система Б']) await click(ADMIN_CHAT, ADMIN, '📁 ' + f);
  await click(ADMIN_CHAT, ADMIN, '🎞 SCR#3333333');
  await click(ADMIN_CHAT, ADMIN, 'Удалить запись');
  assert.match(lastText(ADMIN_CHAT), /Удалить запись SCR#3333333\?[\s\S]*уйдёт в архив/);
  await click(ADMIN_CHAT, ADMIN, 'Да, удалить');
  assert.match(lastText(ADMIN_CHAT), /Запись удалена/);
  assert.ok(!fake.exists(`${SYS_B}/SCR#3333333.mp4`));
  assert.ok(fake.files(`/${ROOT}/BackUp`).some((p) => p.includes('удалено SCR#3333333')));
  // Найти — записи нет, но есть архив
  await press(EDITOR_CHAT, EDITOR, 'cmd:find');
  await say(EDITOR_CHAT, EDITOR, '3333333');
  assert.match(lastText(EDITOR_CHAT), /Записи SCR#3333333 нет[\s\S]*В архиве есть прежние версии/);
  await click(EDITOR_CHAT, EDITOR, 'В архиве версий');
  assert.match(lastText(EDITOR_CHAT), /Сейчас записи нет — она удалена[\s\S]*удалил: Даниил Рыскин/);
  await click(EDITOR_CHAT, EDITOR, 'Восстановить 1)');
  assert.match(lastText(EDITOR_CHAT), /вернётся в папку, где лежала до удаления/);
  await click(EDITOR_CHAT, EDITOR, '✅ Восстановить');
  assert.ok(fake.exists(`${SYS_B}/SCR#3333333.mp4`), 'вернулась на прежнее место');
});

test('4.1 заявка на доступ: кнопка у отказа → карточка администратору → доступ выдан', async () => {
  const STR = 777001, STR_CHAT = 9777;
  await say(STR_CHAT, STR, 'привет');
  assert.ok(buttons(STR_CHAT).includes('🙋 Запросить доступ'));
  await press(STR_CHAT, STR, 'req:access', { first_name: 'Пётр', last_name: 'Новиков' });
  assert.match(lastText(STR_CHAT), /Заявка отправлена/);
  assert.match(lastText(ADMIN_CHAT), /Заявка на доступ[\s\S]*Пётр Новиков[\s\S]*777001/);
  await press(STR_CHAT, STR, 'req:access');
  assert.match(lastText(STR_CHAT), /уже отправлена/);
  await click(ADMIN_CHAT, ADMIN, 'Руководитель проекта');
  assert.match(lastText(ADMIN_CHAT), /доступ выдан — Руководитель проекта/);
  assert.match(lastText(STR_CHAT), /Доступ выдан: Руководитель проекта/);
  await say(STR_CHAT, STR, '/start');
  assert.ok(buttons(STR_CHAT).some((t) => t.includes('Загрузить')), 'новый руководитель видит загрузку');
  // Повторное нажатие старой кнопки администратором — без последствий
  await press(ADMIN_CHAT, ADMIN, `areq:viewer:${STR}`);
  assert.match(lastText(ADMIN_CHAT), /уже рассмотрели/);
});

test('4.1 отклонённая заявка; повторная — не чаще раза в сутки', async () => {
  const STR = 777002, STR_CHAT = 9778;
  await press(STR_CHAT, STR, 'req:access', { name: 'Аноним' });
  await click(ADMIN_CHAT, ADMIN, 'Отклонить');
  assert.match(lastText(STR_CHAT), /отклонена/);
  await press(STR_CHAT, STR, 'req:access');
  assert.match(lastText(STR_CHAT), /не чаще раза в сутки/);
});

test('4.2 смена роли: без удаления, с записью в журнал и сообщением человеку', async () => {
  await press(ADMIN_CHAT, ADMIN, 'adm:people');
  await click(ADMIN_CHAT, ADMIN, 'Изменить роль');
  await click(ADMIN_CHAT, ADMIN, 'Руководитель Один');
  assert.match(lastText(ADMIN_CHAT), /Сейчас: Руководитель проекта/);
  await click(ADMIN_CHAT, ADMIN, 'Гость —');
  assert.ok(fake.texts(ADMIN_CHAT).some((t) => /Руководитель проекта → Гость/.test(t)));
  assert.match(lastText(EDITOR_CHAT), /Ваша роль в боте изменена: Гость/);
  await press(EDITOR_CHAT, EDITOR, 'cmd:upload');
  assert.match(lastText(EDITOR_CHAT), /Загрузка недоступна/);
  // вернуть как было
  await press(ADMIN_CHAT, ADMIN, 'adm:chg');
  await click(ADMIN_CHAT, ADMIN, 'Руководитель Один');
  await click(ADMIN_CHAT, ADMIN, 'Руководитель проекта —');
  await journal.flushed();
  const month = fake.files(`/${ROOT}/_Журнал`).find((p) => /\d{4}-\d{2}\.csv$/.test(p));
  assert.match(fake.nodes.get(month).content, /Смена роли/);
});

test('4.12 последние действия — прямо в чате', async () => {
  await journal.flushed();
  await press(ADMIN_CHAT, ADMIN, 'adm:recent');
  const t = lastText(ADMIN_CHAT);
  assert.match(t, /🕒 Последние \d+ действий/);
  assert.match(t, /Смена роли/);
});

test('4.14 журнал и список доступа — в Excel', async () => {
  await journal.flushed();
  const d = new Date();
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  await press(ADMIN_CHAT, ADMIN, 'admlog:' + ym);
  const cells = readXlsxCells(lastXlsx());
  assert.ok(cells.includes('Действие'));
  assert.ok(cells.includes('Загрузка видеозаписи'));
  await press(ADMIN_CHAT, ADMIN, 'adm:export');
  const people = readXlsxCells(lastXlsx());
  assert.ok(people.includes('Даниил Рыскин'));
  assert.ok(people.includes('Пётр Новиков'));
});

test('4.9 сверка с реестром: есть / нет на Диске / нет в реестре', async () => {
  await bot.warmTree();
  await press(ADMIN_CHAT, ADMIN, 'adm:registry');
  const reg = writeXlsx([{ name: 'Реестр', header: ['№', 'Номер', 'Примечание'],
    rows: [[1, 2222222, 'показ'], [2, 'SCR#9999999', 'не загружен'], [3, '', 'пусто']] }]);
  await say(ADMIN_CHAT, ADMIN, '', [blobAtt('реестр.xlsx', reg)]);
  const post = lastFilePost(ADMIN_CHAT);
  assert.match(post.text, /Номеров в реестре: 2\nЕсть на Диске: 1\nНет на Диске: 1\nНа Диске, но не в реестре: \d+/);
  const cells = readXlsxCells(lastXlsx());
  assert.ok(cells.includes('SCR#2222222') && cells.includes('есть'));
  assert.ok(cells.includes('SCR#9999999') && cells.includes('нет на Диске'));
  assert.ok(cells.includes('нет в реестре'));
  // CSV тоже понимает, а .xls — нет
  await press(ADMIN_CHAT, ADMIN, 'adm:registry');
  await say(ADMIN_CHAT, ADMIN, '', [blobAtt('реестр.csv', Buffer.from('Номер;x\n1111111;a\n', 'utf8'))]);
  assert.match(lastFilePost(ADMIN_CHAT).text, /Номеров в реестре: 1\nЕсть на Диске: 1/);
  await press(ADMIN_CHAT, ADMIN, 'adm:registry');
  await say(ADMIN_CHAT, ADMIN, '', [blobAtt('старый.xls', Buffer.from('x'))]);
  assert.match(lastText(ADMIN_CHAT), /\.xls не подходит/);
});

test('4.11 утренняя сводка: один раз в день, с ошибками и заявками', async () => {
  bot.resetSummary();
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(10, 0, 0, 0);
  const early = new Date(tomorrow); early.setHours(7);
  const before = fake.texts(ADMIN_CHAT).filter((t) => /☀️ Сводка/.test(t)).length;
  await bot.summaryTick(early);
  assert.equal(fake.texts(ADMIN_CHAT).filter((t) => /☀️ Сводка/.test(t)).length, before, 'до 9:00 — не шлёт');
  await bot.summaryTick(tomorrow);
  const all = fake.texts(ADMIN_CHAT).filter((t) => /☀️ Сводка/.test(t));
  assert.equal(all.length, before + 1);
  assert.match(all.at(-1), new RegExp(`Сводка за ${new Date().toLocaleDateString('ru-RU').replace(/\./g, '\\.')}`));
  assert.match(all.at(-1), /Загружено: \d+/);
  assert.match(all.at(-1), /Записей на Диске: \d+/);
  await bot.summaryTick(tomorrow);
  assert.equal(fake.texts(ADMIN_CHAT).filter((t) => /☀️ Сводка/.test(t)).length, before + 1, 'второй раз за день — нет');
});

test('4.19 список команд отправляется в MAX; сбой не мешает', async () => {
  await bot.registerCommands();
  assert.ok(fake.commands.some((c) => c.name === 'find'));
  assert.ok(fake.commands.some((c) => c.name === 'browse'));
});

test('ревизия: папка с точкой в имени не пропадает из отчёта; файл записи — отрезается', async () => {
  const ui = await import('../ui.js');
  assert.equal(ui.crumbs(['ГК-1', 'ОП 01.2026', 'Код-направления 01', 'Система А']), 'ГК-1 → ОП 01.2026 → 01 → Система А');
  assert.equal(ui.reportInline(`disk:/${ROOT}/ГК-1/ОП 01.2026/Н/С/SCR#1234567.mp4`), 'ГК: ГК-1 · ОП: ОП 01.2026 · Направление: Н · Система: С');
  assert.equal(ui.reportInline(`/${ROOT}/ГК-1/ОП 01.2026`), 'ГК: ГК-1 · ОП: ОП 01.2026');
});

test('ревизия: кнопка папки из старого сообщения после «В начало» — «кнопка устарела»', async () => {
  await press(EDITOR_CHAT, EDITOR, 'cmd:upload');
  const stale = fake.button(EDITOR_CHAT, '📁 ГК-1');
  await press(EDITOR_CHAT, EDITOR, 'cmd:menu');
  await press(EDITOR_CHAT, EDITOR, stale);
  assert.match(lastText(EDITOR_CHAT), /Кнопка устарела/);
});

test('ревизия: сводка не дошла — повторится при следующей проверке', async () => {
  bot.resetSummary();
  const day = new Date(); day.setDate(day.getDate() + 2); day.setHours(11, 0, 0, 0);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => (String(u).includes('/messages') && (o?.method || 'GET') === 'POST'
    ? new Response('{"code":"fail"}', { status: 500 }) : realFetch(u, o));
  await bot.summaryTick(day);
  globalThis.fetch = realFetch;
  const before = fake.texts(ADMIN_CHAT).filter((t) => /☀️ Сводка/.test(t)).length;
  await bot.summaryTick(day);
  assert.equal(fake.texts(ADMIN_CHAT).filter((t) => /☀️ Сводка/.test(t)).length, before + 1);
});

test('журнал за период: весь журнал одним файлом, свои даты, итоги по действиям и людям', async () => {
  await journal.flushed();
  // Прошлый месяц — положим файл журнала прямо на Диск, как будто бот писал его тогда
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const ym = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  const dd = prev.toLocaleDateString('ru-RU');
  fake.put(`/${ROOT}/_Журнал/${ym}.csv`, 0,
    '﻿Дата;Время;Кто (номер);Кто (имя);Действие;SCR;Где;Результат\r\n' +
    `${dd};10:00:00;111;Руководитель Один;Загрузка видеозаписи;SCR#7000001;ГК: ГК-1;успешно\r\n` +
    `${dd};11:00:00;111;Руководитель Один;Загрузка видеозаписи;SCR#7000002;ГК: ГК-1;ОШИБКА: тест\r\n`);
  fake.nodes.get(`/${ROOT}/_Журнал/${ym}.csv`).size = 300;

  await press(ADMIN_CHAT, ADMIN, 'adm:reports');
  const b = buttons(ADMIN_CHAT);
  for (const want of ['Весь журнал одним файлом', 'Указать период', 'Этот месяц', 'Прошлый месяц']) {
    assert.ok(b.some((t) => t.includes(want)), `нет «${want}»: ${b.join(' | ')}`);
  }
  assert.ok(!b.some((t) => t.startsWith('🗒 Журнал за')), 'кнопок отдельных месяцев больше нет');
  await click(ADMIN_CHAT, ADMIN, 'Весь журнал одним файлом');
  const all = lastFilePost(ADMIN_CHAT);
  assert.match(all.text, /Журнал действий за 01\.\d{2}\.\d{4} – /);
  assert.match(all.text, /ошибок: 1/);
  const cells = readXlsxCells(lastXlsx());
  assert.ok(cells.includes('SCR#7000001'), 'прошлый месяц в файле');
  assert.ok(cells.includes('Смена роли'), 'текущий месяц в файле');
  assert.ok(cells.includes('Количество'), 'есть листы итогов');
  assert.ok(cells.indexOf('SCR#7000001') < cells.indexOf('Смена роли'), 'строки по порядку дат');

  // Свои даты: только прошлый месяц
  await press(ADMIN_CHAT, ADMIN, 'adm:period');
  await say(ADMIN_CHAT, ADMIN, `${String(prev.getMonth() + 1).padStart(2, '0')}.${prev.getFullYear()}`);
  const only = readXlsxCells(lastXlsx());
  assert.ok(only.includes('SCR#7000001'));
  assert.ok(!only.includes('Смена роли'), 'текущий месяц не попал');
  assert.match(lastFilePost(ADMIN_CHAT).text, /Записей: 2 · ошибок: 1/);

  // Период без действий и непонятный текст
  await press(ADMIN_CHAT, ADMIN, 'adm:period');
  await say(ADMIN_CHAT, ADMIN, '01.01.2020-02.01.2020');
  assert.match(lastText(ADMIN_CHAT), /действий в журнале нет/);
  await press(ADMIN_CHAT, ADMIN, 'adm:period');
  await say(ADMIN_CHAT, ADMIN, 'вчера');
  assert.match(lastText(ADMIN_CHAT), /Не разобрал период/);
});
