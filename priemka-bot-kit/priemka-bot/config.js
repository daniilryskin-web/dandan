/**
 * Настройки бота из .env. У каждой есть значение по умолчанию, поэтому старый .env
 * (только MAX_TOKEN и YANDEX_DISK_TOKEN) продолжает работать без правок.
 *
 *   DISK_ROOT=Видеопоказы          корневая папка на Диске; для тестового контура —
 *                                  например «Видеопоказы-тест»
 *   ADMINS=90235418                основные администраторы через запятую
 *   YANDEX_TOKEN_ISSUED=2026-09-07 когда выдан токен Диска — для напоминания о продлении
 *   YANDEX_TOKEN_DAYS=365          сколько дней живёт токен
 *   LOW_SPACE_GB=10                ниже этого свободного места — оповещение администратору
 *   PRIEMKA_DATA_DIR=…             где лежат access.json, state.json, marker.json (по умолчанию —
 *                                  папка бота); нужно тестам и тестовому контуру
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const env = process.env;

/* Основной администратор на случай, если в .env ничего не задано или задано с ошибкой:
 * бот не должен остаться вовсе без администратора. */
const DEFAULT_ADMINS = [90235418];   // Даниил Рыскин, МЦ

function parseAdmins(raw) {
  const ids = String(raw || '').split(/[,;\s]+/).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  return ids.length ? ids : DEFAULT_ADMINS;
}

export const ROOT = (env.DISK_ROOT || '').trim() || 'Видеопоказы';
export const ADMINS = parseAdmins(env.ADMINS);
export const YANDEX_TOKEN_ISSUED = (env.YANDEX_TOKEN_ISSUED || '').trim() || null;
export const YANDEX_TOKEN_DAYS = Number(env.YANDEX_TOKEN_DAYS) > 0 ? Number(env.YANDEX_TOKEN_DAYS) : 365;
export const LOW_SPACE_BYTES = (Number(env.LOW_SPACE_GB) > 0 ? Number(env.LOW_SPACE_GB) : 10) * 1024 ** 3;

export const BOT_DIR = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = (env.PRIEMKA_DATA_DIR || '').trim() || BOT_DIR;

/** Файл в папке данных — как URL, чтобы fs работал с ним одинаково на Windows и Linux. */
export const dataFile = (name) => pathToFileURL(join(DATA_DIR, name));
