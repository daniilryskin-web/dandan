// ============================================================================
//  Вкладка Prepare — Advanced-чарт: столбчатый стек с суммой в итогах,
//  оформление в палитре дизайн-системы Госуслуг / Минцифры.
//
//  Код вне Editor.wrapFn исполняется на сервере: здесь готовим данные.
//  Код внутри Editor.wrapFn исполняется в браузере: там рисуем SVG.
//  Замыкания через границу wrapFn не работают — всё, что нужно рендеру,
//  передаётся через args.
// ============================================================================

// --- Палитра Минцифры / дизайн-системы Госуслуг -----------------------------
const BRAND = {
    // Фирменная фиолетовая гамма: одна гамма, три ступени по светлоте.
    violet: '#4B2DE8',        // основная ступень
    violetLight: '#8E7CF2',   // светлая
    violetDeep: '#4A38AD',    // глубокая
    // Акценты — на случай, если серий окажется больше трёх.
    magenta: '#C0397E',
    ochre: '#8A6A00',
    teal: '#0A7D9E',
    ink: '#17123B',           // основной текст
    muted: '#6B6690',         // вторичный текст
    grid: '#E7E3F5',
    axis: '#CFC9E8',
    bg: '#FAF9FE',            // холст, едва тонированный в лиловый
};

// Ubuntu — гарнитура дизайн-системы Госуслуг, дальше системный запас.
const FONT = "Ubuntu, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

// Порядок = порядок укладки стека снизу вверх.
const SERIES_SPEC = [
    {field: 'Рефакторинг', color: BRAND.violet},
    {field: 'Проактив', color: BRAND.violetLight},
    {field: 'Онлайн', color: BRAND.violetDeep},
];

const FALLBACK_COLORS = [
    BRAND.violet, BRAND.violetLight, BRAND.violetDeep,
    BRAND.magenta, BRAND.ochre, BRAND.teal,
];

const X_FIELD = 'Год';
const SOURCE_KEY = 'services';   // ключ источника из вкладки Sources
const TITLE = 'Услуги по годам';
// Пустая строка — подзаголовок не рисуется, шапка становится компактнее.
const SUBTITLE = '';

// --- Демо-режим -------------------------------------------------------------
// true  — рисуем на зашитых цифрах (проверить оформление без датасета);
// false — берём данные из вкладки Sources.
const DEMO = true;

const DEMO_ROWS = [
    {'Год': '2025', 'Рефакторинг': 82, 'Проактив': 40, 'Онлайн': 9},
    {'Год': '2026', 'Рефакторинг': 159, 'Проактив': 45, 'Онлайн': 31},
    {'Год': '2027', 'Рефакторинг': 74, 'Проактив': 5, 'Онлайн': 19},
];

// ---------------------------------------------------------------------------
//  Серверная часть: данные → модель чарта
// ---------------------------------------------------------------------------
function toNumber(value) {
    if (value === null || value === undefined || value === '') return 0;
    const n = Number(String(value).replace(/\s/g, '').replace(',', '.'));
    return isNaN(n) ? 0 : n;
}

// Ответ источника приводим к массиву плоских объектов {Год: '2025', ...}.
// Поддержаны обе формы: ответ BI API (result_data + fields) и готовый массив.
function normalizeRows(loaded) {
    if (!loaded) return [];

    const src = loaded[SOURCE_KEY] || loaded[Object.keys(loaded)[0]];
    if (!src) return [];

    if (Array.isArray(src)) return src;

    const block = src.result_data && src.result_data[0];
    if (block) {
        const titles = (src.fields || []).map(function (f, i) {
            return f.title || f.legend_item_id || ('col_' + i);
        });
        return (block.rows || []).map(function (row) {
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

const params = Editor.getParams();
const mode = (params.stacking && params.stacking[0]) === 'percent' ? 'percent' : 'abs';
const showTotals = (params.totals && params.totals[0]) !== 'off';

const rows = DEMO ? DEMO_ROWS : normalizeRows(Editor.getLoadedData());

// Категории оси X по возрастанию.
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

// Меры: сначала описанные в SERIES_SPEC, затем всё остальное, что пришло.
const known = SERIES_SPEC.map(function (s) { return s.field; });
const present = [];
rows.forEach(function (row) {
    Object.keys(row).forEach(function (field) {
        if (field !== X_FIELD && present.indexOf(field) === -1) present.push(field);
    });
});
const measures = known.filter(function (f) { return present.indexOf(f) !== -1; })
    .concat(present.filter(function (f) { return known.indexOf(f) === -1; }));

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

const series = measures.map(function (field, i) {
    const spec = SERIES_SPEC.filter(function (s) { return s.field === field; })[0];
    return {
        name: field,
        color: spec ? spec.color : FALLBACK_COLORS[i % FALLBACK_COLORS.length],
        data: categories.map(function (key) {
            return (index[key] && index[key][field]) || 0;
        }),
    };
});

const totals = categories.map(function (key) {
    return measures.reduce(function (sum, field) {
        return sum + ((index[key] && index[key][field]) || 0);
    }, 0);
});

const model = {
    title: TITLE,
    subtitle: SUBTITLE,
    categories: categories,
    series: series,
    totals: totals,
    mode: mode,
    showTotals: showTotals,
    brand: BRAND,
    font: FONT,
    // Отступ шапки от левого края холста. Заголовок ставится по краю
    // виджета, а не по оси: подписи шкалы уходят левее оси, и заголовок,
    // выровненный по ней, выглядит утопленным.
    titleX: 16,
    // Ширина столбца: доля слота и жёсткий максимум в пикселях.
    barWidthRatio: 0.62,
    maxBarWidth: 96,
    // Мелкий сегмент растягивается до этой высоты, чтобы цифра помещалась
    // внутри блока. Недостающие пиксели снимаются с крупных сегментов, так
    // что общая высота столбца остаётся верной. 0 — выключить растягивание.
    minSegmentHeight: 20,
    // Страховка: если столбец настолько низкий, что минимум не выдержать,
    // цифра ниже этого порога не рисуется — она осталась бы нечитаемой.
    insideLabelMinHeight: 13,
};

// ---------------------------------------------------------------------------
//  Клиентская часть: модель → SVG
// ---------------------------------------------------------------------------
module.exports = {
    render: Editor.wrapFn({
        args: [model],

        fn: function (options, m) {
            const B = m.brand;
            const F = m.font;

            const W = Math.max(320, parseInt(options && options.width, 10) || 960);
            const H = Math.max(280, parseInt(options && options.height, 10) || 540);

            const esc = function (value) {
                return String(value)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
            };

            // Формат «1 234,5» — узкий разделитель разрядов, запятая в дробной части.
            const fmt = function (value, digits) {
                const d = digits === undefined ? 0 : digits;
                const fixed = Math.abs(Number(value)).toFixed(d);
                const parts = fixed.split('.');
                parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
                return (Number(value) < 0 ? '−' : '') + parts.join(',');
            };

            // Цвет подписи внутри сегмента выбираем по контрасту с заливкой:
            // белым по тёмной ступени, чернильным — по светлой.
            const relLum = function (hex) {
                const c = String(hex).replace('#', '');
                const ch = [0, 2, 4].map(function (i) {
                    const v = parseInt(c.substr(i, 2), 16) / 255;
                    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
                });
                return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
            };
            const labelColor = function (fill) {
                const l = relLum(fill);
                const onWhite = 1.05 / (l + 0.05);
                const onInk = (l + 0.05) / (relLum(B.ink) + 0.05);
                return onWhite >= onInk ? '#FFFFFF' : B.ink;
            };

            if (!m.categories.length || !m.series.length) {
                return Editor.generateHtml(
                    '<div style="font-family:' + F + ';color:' + B.muted +
                    ';padding:24px">Нет данных для отображения</div>'
                );
            }

            const headerH = m.title ? (m.subtitle ? 78 : 58) : 28;
            const pad = {top: headerH, right: 24, bottom: 78, left: 60};
            const plotW = Math.max(40, W - pad.left - pad.right);
            const plotH = Math.max(40, H - pad.top - pad.bottom);

            // Значения с учётом режима: в процентах нормируем каждый стек к 100.
            const value = function (si, ci) {
                const raw = m.series[si].data[ci] || 0;
                if (m.mode !== 'percent') return raw;
                const total = m.totals[ci] || 0;
                return total ? (raw / total) * 100 : 0;
            };
            const stackTotal = function (ci) {
                return m.mode === 'percent' ? (m.totals[ci] ? 100 : 0) : (m.totals[ci] || 0);
            };

            // «Круглый» максимум оси, с запасом под подпись итога.
            const niceMax = function (v) {
                if (!(v > 0)) return 10;
                const pow = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
                const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
                for (let i = 0; i < steps.length; i++) {
                    if (steps[i] * pow >= v) return steps[i] * pow;
                }
                return 10 * pow;
            };

            let peak = 0;
            for (let ci = 0; ci < m.categories.length; ci++) {
                peak = Math.max(peak, stackTotal(ci));
            }
            const yMax = m.mode === 'percent' ? 100 : niceMax(peak * 1.1);
            const y0 = pad.top + plotH;
            const scale = function (v) { return yMax ? (v / yMax) * plotH : 0; };

            const svg = [];

            svg.push('<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H +
                '" xmlns="http://www.w3.org/2000/svg" font-family="' + esc(F) + '" role="img">');
            svg.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + B.bg + '"/>');

            // Заголовки
            if (m.title) {
                svg.push('<text x="' + m.titleX + '" y="34" fill="' + B.ink +
                    '" font-size="20" font-weight="700">' + esc(m.title) + '</text>');
            }
            if (m.subtitle) {
                svg.push('<text x="' + m.titleX + '" y="56" fill="' + B.muted +
                    '" font-size="13">' + esc(m.subtitle) + '</text>');
            }

            // Сетка и подписи оси Y
            const tickCount = 5;
            for (let t = 0; t <= tickCount; t++) {
                const v = (yMax / tickCount) * t;
                const y = y0 - scale(v);
                svg.push('<line x1="' + pad.left + '" y1="' + y + '" x2="' + (pad.left + plotW) +
                    '" y2="' + y + '" stroke="' + (t === 0 ? B.axis : B.grid) +
                    '" stroke-width="1"' + (t === 0 ? '' : ' stroke-dasharray="4 4"') + '/>');
                svg.push('<text x="' + (pad.left - 12) + '" y="' + (y + 4) + '" fill="' + B.muted +
                    '" font-size="12" text-anchor="end">' +
                    (m.mode === 'percent' ? fmt(v) + ' %' : fmt(v)) + '</text>');
            }

            // Столбцы
            const slot = plotW / m.categories.length;
            const barW = Math.max(8, Math.min(m.maxBarWidth, slot * m.barWidthRatio));

            for (let ci = 0; ci < m.categories.length; ci++) {
                const cx = pad.left + slot * ci + slot / 2;
                const x = cx - barW / 2;
                const total = stackTotal(ci);

                // Подпись категории
                svg.push('<text x="' + cx + '" y="' + (y0 + 26) + '" fill="' + B.muted +
                    '" font-size="13" text-anchor="middle">' + esc(m.categories[ci]) + '</text>');

                // Видимые сегменты столбца снизу вверх.
                const parts = [];
                for (let si = 0; si < m.series.length; si++) {
                    const v = value(si, ci);
                    if (v > 0) parts.push({si: si, v: v, h: scale(v)});
                }

                // Мелкие сегменты поднимаем до минимальной высоты, чтобы цифра
                // помещалась внутри блока, а недостающие пиксели снимаем с
                // крупных — общая высота столбца при этом не меняется.
                const MIN_SEG = m.minSegmentHeight;
                const small = parts.filter(function (p) { return p.h < MIN_SEG; });

                if (MIN_SEG > 0 && small.length) {
                    const deficit = small.reduce(function (a, p) { return a + (MIN_SEG - p.h); }, 0);
                    const donors = parts.filter(function (p) { return p.h > MIN_SEG; });
                    const surplus = donors.reduce(function (a, p) { return a + (p.h - MIN_SEG); }, 0);

                    if (surplus >= deficit) {
                        const shares = donors.map(function (p) { return (p.h - MIN_SEG) / surplus; });
                        small.forEach(function (p) { p.h = MIN_SEG; });
                        donors.forEach(function (p, k) { p.h -= shares[k] * deficit; });
                    }
                    // Иначе столбец слишком низкий, чтобы вместить все цифры:
                    // оставляем честные пропорции и не растягиваем ничего.
                }

                const topPart = parts.length ? parts[parts.length - 1] : null;
                const GAP = 2;   // просвет между сегментами, чтобы стек читался
                let cursor = y0;
                let firstDrawn = true;

                parts.forEach(function (p) {
                    const y = cursor - p.h;
                    cursor = y;

                    // Зазор срезается снизу сегмента, поэтому верх стека не «плывёт».
                    const drawH = Math.max(1, firstDrawn ? p.h : p.h - GAP);
                    firstDrawn = false;

                    const color = m.series[p.si].color;
                    const r = Math.min(4, drawH / 2);
                    const shape = (p === topPart)
                        ? '<path d="M' + x + ' ' + (y + drawH) + ' L' + x + ' ' + (y + r) +
                          ' Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y +
                          ' L' + (x + barW - r) + ' ' + y +
                          ' Q' + (x + barW) + ' ' + y + ' ' + (x + barW) + ' ' + (y + r) +
                          ' L' + (x + barW) + ' ' + (y + drawH) + ' Z" fill="' + color + '"/>'
                        : '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + drawH +
                          '" fill="' + color + '"/>';

                    const raw = m.series[p.si].data[ci] || 0;
                    const share = m.totals[ci] ? (raw / m.totals[ci]) * 100 : 0;
                    const hint = m.categories[ci] + ' · ' + m.series[p.si].name + ': ' +
                        fmt(raw) + ' (' + fmt(share, 1) + ' %)';

                    svg.push('<g><title>' + esc(hint) + '</title>' + shape + '</g>');

                    if (drawH >= m.insideLabelMinHeight) {
                        svg.push('<text x="' + cx + '" y="' + (y + drawH / 2 + 4) +
                            '" fill="' + labelColor(color) + '" font-size="12" font-weight="600" ' +
                            'text-anchor="middle" pointer-events="none">' +
                            (m.mode === 'percent' ? fmt(p.v) + ' %' : fmt(raw)) + '</text>');
                    }
                });

                // ⬇ Сумма в итогах — над столбцом.
                // В режиме долей столбец упирается в верх шкалы, поэтому
                // подпись прижимаем к границе области построения.
                if (m.showTotals && total > 0) {
                    const totalY = Math.max(pad.top - 8, cursor - 10);
                    svg.push('<text x="' + cx + '" y="' + totalY + '" fill="' + B.ink +
                        '" font-size="13" font-weight="700" text-anchor="middle">' +
                        (m.mode === 'percent' ? fmt(m.totals[ci]) : fmt(total)) + '</text>');
                }
            }

            // Легенда по центру снизу; при нехватке ширины переносится по рядам.
            const itemW = m.series.map(function (s) {
                return 14 + 8 + s.name.length * 7.2 + 24;   // маркер + зазор + текст + отступ
            });
            const maxRowW = W - 2 * 16;
            const rows = [[]];
            let rowW = 0;
            m.series.forEach(function (s, i) {
                if (rows[rows.length - 1].length && rowW + itemW[i] - 24 > maxRowW) {
                    rows.push([]);
                    rowW = 0;
                }
                rows[rows.length - 1].push({series: s, w: itemW[i]});
                rowW += itemW[i];
            });

            const ROW_H = 18;
            const legendY0 = H - 26 - (rows.length - 1) * ROW_H;

            rows.forEach(function (row, ri) {
                const rw = row.reduce(function (a, it) { return a + it.w; }, 0) - 24;
                let lx = Math.max(16, (W - rw) / 2);
                const ly = legendY0 + ri * ROW_H;

                row.forEach(function (it) {
                    svg.push('<rect x="' + lx + '" y="' + (ly - 9) +
                        '" width="10" height="10" rx="2" fill="' + it.series.color + '"/>');
                    svg.push('<text x="' + (lx + 18) + '" y="' + ly + '" fill="' + B.ink +
                        '" font-size="13">' + esc(it.series.name) + '</text>');
                    lx += it.w;
                });
            });

            svg.push('</svg>');

            return Editor.generateHtml(
                '<div style="width:100%;background:' + B.bg + ';font-family:' + F + '">' +
                svg.join('') + '</div>'
            );
        },
    }),
};
