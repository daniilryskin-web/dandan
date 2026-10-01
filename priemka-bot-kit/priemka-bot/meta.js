/**
 * Служебные сведения о записях — на Диске, в «<корень>/_Служебное/записи.json»:
 *   comments — комментарий к записи (дата показа, примечание), по номеру SCR:
 *              переживает и перенос, и замену записи;
 *   origins  — откуда версия уехала в архив: по ней удалённая запись восстанавливается
 *              на прежнее место.
 *
 * Почему свой файл, а не свойства файла на Диске: сохраняются ли они при переносе,
 * не задокументировано, а свой файл предсказуем и лежит рядом с журналом.
 * Папка начинается с «_» — в опроснике и обзоре её не видно.
 *
 * Этот файл ни на что главное не влияет: если он не прочитался, комментарии просто не
 * показываются, а загрузка, поиск и замена работают как обычно.
 */

import * as disk from './yandex-disk.js';
import { ROOT } from './config.js';

const FOLDER = [ROOT, '_Служебное'];
const FILE = 'записи.json';
const path = () => disk.joinPath(...FOLDER, FILE);

let data = null;
let loading = null;
let chain = Promise.resolve();

async function load() {
  if (data) return data;
  loading ||= (async () => {
    const text = await disk.readText(path());
    let j = {};
    if (text.trim()) {
      // Повреждённый файл не затираем: иначе следующая запись стёрла бы все комментарии.
      try { j = JSON.parse(text.replace(/^﻿/, '')); }
      catch { throw new Error(`служебный файл ${FILE} повреждён — его нужно поправить или удалить на Диске`); }
    }
    j.comments ||= {};
    j.origins ||= {};
    data = j;
    return data;
  })().finally(() => { loading = null; });
  return loading;
}

/** Перечитать с Диска при следующем обращении — если файл правили руками. */
export function reload() { data = null; }

/** Изменить и записать. Очередь — как у журнала: две правки подряд не затрут друг друга. */
function update(fn) {
  const run = chain.then(async () => {
    const d = await load();
    fn(d);
    await disk.ensureFolder(disk.joinPath(...FOLDER));
    await disk.uploadBuffer(Buffer.from(JSON.stringify(d, null, 1), 'utf8'), path(), { overwrite: true });
  });
  chain = run.catch(() => {});
  return run;
}

const key = (p) => String(p).replace(/^disk:/i, '');

/** Комментарий к записи или null. Никогда не бросает: без комментария бот работает как раньше. */
export async function getComment(scr) {
  try { return (await load()).comments[scr] || null; }
  catch (e) { console.error('   комментарии не прочитаны:', e.message); return null; }
}

/** text = null — убрать комментарий. Бросает при сбое записи: человеку надо сказать. */
export function setComment(scr, text, by) {
  return update((d) => {
    if (text) d.comments[scr] = { text, by, at: new Date().toISOString() };
    else delete d.comments[scr];
  });
}

/** Запомнить, откуда версия ушла в архив. Сбой не критичен — только в журнал работы. */
export function setOrigin(backupPath, originalPath) {
  return update((d) => { d.origins[key(backupPath)] = key(originalPath); })
    .catch((e) => console.error('   не запомнил исходную папку версии:', e.message));
}

export async function getOrigin(backupPath) {
  try { return (await load()).origins[key(backupPath)] || null; }
  catch { return null; }
}
