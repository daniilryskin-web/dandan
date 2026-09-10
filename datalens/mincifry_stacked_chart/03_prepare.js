// ============================================================================
//  Вкладка «JavaScript» (Prepare) — DataLens Editor, тип чарта: Графики / graph
//  Задача вкладки: только данные. Всё оформление — во вкладке «Оформление»
//  (05_highcharts.js), потому что там разрешены функции-форматтеры.
// ============================================================================

// --- Палитра Минцифры / дизайн-системы Госуслуг -----------------------------
// Держите в синхроне с 05_highcharts.js (вкладки редактора не видят друг друга).
const BRAND = {
    blue: '#0D4CD3',      // основной синий
    blueDark: '#0B3D9E',
    blueLight: '#5B8DEF',
    red: '#EE3F58',       // акцент / внимание
    green: '#0FA958',     // успех
    orange: '#F2A200',
    violet: '#7B61FF',
    cyan: '#00A0C6',
    ink: '#0B1F33',       // основной текст
    muted: '#5A7196',     // вторичный текст
};

// Порядок = порядок укладки снизу вверх в стеке.
const SERIES_SPEC = [
    {field: 'Рефакторинг', color: BRAND.green},
    {field: 'Проактив', color: BRAND.red},
    {field: 'Онлайн', color: BRAND.blue},
];

const X_FIELD = 'Год';
const TOTAL_NAME = 'Всего услуг';

// Запасная палитра, если полей окажется больше, чем описано в SERIES_SPEC.
const FALLBACK_COLORS = [
    BRAND.blue, BRAND.red, BRAND.green, BRAND.orange,
    BRAND.violet, BRAND.cyan, BRAND.blueLight, BRAND.muted,
];

// --- Демо-режим -------------------------------------------------------------
// true  — чарт рисуется на зашитых данных (удобно проверить оформление сразу,
//         не настраивая источник);
// false — данные берутся из вкладки «Источники» (02_sources.js).
const DEMO = true;

const DEMO_ROWS = [
    {'Год': '2025', 'Рефакторинг': 82, 'Проактив': 40, 'Онлайн': 9},
    {'Год': '2026', 'Рефакторинг': 159, 'Проактив': 45, 'Онлайн': 31},
    {'Год': '2027', 'Рефакторинг': 74, 'Проактив': 5, 'Онлайн': 19},
];

// ---------------------------------------------------------------------------
//  Нормализация ответа источника в массив плоских объектов
//  {Год: '2025', Онлайн: 9, ...}
//  Поддерживаются два формата: ответ BI API (result_data) и готовый массив.
// ---------------------------------------------------------------------------
function normalizeRows(loaded) {
    if (!loaded) return [];

    const src = loaded.data || loaded[Object.keys(loaded)[0]];
    if (!src) return [];

    if (Array.isArray(src)) return src;

    if (src.result_data && src.result_data[0]) {
        const titles = (src.fields || []).map(function (f, i) {
            return f.title || f.legend_item_id || ('col_' + i);
        });
        const rows = src.result_data[0].rows || [];

        return rows.map(function (row) {
            const cells = row.data || row;
            const obj = {};
            cells.forEach(function (value, i) {
                obj[titles[i]] = value;
            });
            return obj;
        });
    }

    return [];
}

function toNumber(value) {
    if (value === null || value === undefined || value === '') return 0;
    const n = Number(String(value).replace(/\s/g, '').replace(',', '.'));
    return isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
//  Сборка
// ---------------------------------------------------------------------------
const params = (typeof ChartEditor !== 'undefined' && ChartEditor.getParams)
    ? ChartEditor.getParams()
    : {};

// Параметр из вкладки «Элементы управления»: 'normal' | 'percent'.
const stacking = (params.stacking && params.stacking[0]) || 'normal';
// Показывать ли линию суммарного значения поверх стека.
const showTotalLine = ((params.total_line && params.total_line[0]) || 'off') === 'on';

const rows = DEMO
    ? DEMO_ROWS
    : normalizeRows(typeof ChartEditor !== 'undefined' ? ChartEditor.getLoadedData() : null);

// Категории оси X в порядке появления (по возрастанию, если это годы/числа).
const categories = [];
rows.forEach(function (row) {
    const key = String(row[X_FIELD]);
    if (categories.indexOf(key) === -1) categories.push(key);
});
categories.sort(function (a, b) {
    const na = Number(a);
    const nb = Number(b);
    return (isNaN(na) || isNaN(nb)) ? String(a).localeCompare(String(b)) : na - nb;
});

// Какие меры реально пришли: сначала описанные в SERIES_SPEC, потом остальные.
const known = SERIES_SPEC.map(function (s) { return s.field; });
const present = [];
rows.forEach(function (row) {
    Object.keys(row).forEach(function (field) {
        if (field !== X_FIELD && field !== TOTAL_NAME && present.indexOf(field) === -1) {
            present.push(field);
        }
    });
});
const measures = known.filter(function (f) { return present.indexOf(f) !== -1; })
    .concat(present.filter(function (f) { return known.indexOf(f) === -1; }));

// Быстрый доступ: значение меры по категории.
const index = {};
rows.forEach(function (row) {
    const key = String(row[X_FIELD]);
    index[key] = index[key] || {};
    measures.forEach(function (field) {
        if (row[field] !== undefined) {
            index[key][field] = (index[key][field] || 0) + toNumber(row[field]);
        }
    });
});

const graphs = measures.map(function (field, i) {
    const spec = SERIES_SPEC.filter(function (s) { return s.field === field; })[0];

    return {
        id: 'm_' + i,
        title: field,
        name: field,
        type: 'column',
        color: spec ? spec.color : FALLBACK_COLORS[i % FALLBACK_COLORS.length],
        stack: 'services',
        stacking: stacking,
        yAxis: 0,
        legendIndex: i,
        data: categories.map(function (key) {
            return (index[key] && index[key][field]) || 0;
        }),
    };
});

// Линия итогов поверх стека (по желанию — переключатель в контролах).
if (showTotalLine && stacking !== 'percent') {
    graphs.push({
        id: 'total',
        title: TOTAL_NAME,
        name: TOTAL_NAME,
        type: 'line',
        color: BRAND.ink,
        yAxis: 0,
        zIndex: 5,
        lineWidth: 2,
        dashStyle: 'ShortDash',
        marker: {enabled: true, radius: 4, symbol: 'circle', lineWidth: 2, lineColor: '#FFFFFF'},
        dataLabels: {enabled: false},
        data: categories.map(function (key) {
            return measures.reduce(function (sum, field) {
                return sum + ((index[key] && index[key][field]) || 0);
            }, 0);
        }),
    });
}

// Имя файла при экспорте в XLSX/CSV.
if (typeof ChartEditor !== 'undefined' && ChartEditor.setExtra) {
    ChartEditor.setExtra('exportFilename', 'Услуги по годам');
}

module.exports = {
    graphs: graphs,
    categories: categories,
};
