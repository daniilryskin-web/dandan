// ============================================================================
//  Вкладка Prepare — Advanced-чарт: горизонтальный стек по направлениям
//  с суммой в конце полосы, оформление в палитре Минцифры / Госуслуг.
//
//  Отличия от mincifry_bar_chart (тот же рендер, другие константы):
//  подписи категорий длинные, поэтому левое поле считается по самой длинной
//  из них, а слишком длинные усекаются с многоточием; и из подписи убирается
//  хвост «— 76», потому что итог чарт рисует сам.
//
//  Код вне Editor.wrapFn исполняется на сервере: здесь готовим данные.
//  Код внутри Editor.wrapFn исполняется в браузере: там рисуем SVG.
//  Замыкания через границу wrapFn не работают — всё, что нужно рендеру,
//  передаётся через args.
// ============================================================================

// --- Палитра ----------------------------------------------------------------
// Держите в синхроне с вертикальным чартом (mincifry_stacked_chart): это
// отдельная сущность в DataLens, общего модуля у вкладок нет.
const BRAND = {
    violet: '#4B2DE8',        // основная ступень
    violetLight: '#8E7CF2',   // светлая
    violetDeep: '#4A38AD',    // глубокая
    magenta: '#C0397E',       // акцент для четвёртой серии
    ochre: '#8A6A00',
    teal: '#0A7D9E',
    ink: '#17123B',
    muted: '#6B6690',
    grid: '#E7E3F5',
    axis: '#CFC9E8',
    bg: '#FAF9FE',
};

const FONT = "Ubuntu, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

// Порядок = порядок укладки полосы слева направо.
const SERIES_SPEC = [
    {field: 'Рефакторинг', color: BRAND.violet},
    {field: 'Онлайн', color: BRAND.violetLight},
    {field: 'Проактив', color: BRAND.violetDeep},
];

const FALLBACK_COLORS = [
    BRAND.violet, BRAND.violetLight, BRAND.violetDeep,
    BRAND.magenta, BRAND.ochre, BRAND.teal,
];

// Поле категории — вычисляемое поле с CONCAT из визарда.
const X_FIELD = 'Направление';
const SOURCE_KEY = 'directions';
const TITLE = 'Услуги по направлениям';

// Подпись категории приходит с уже приклеенным итогом: «1. ИЭП — 76».
// Итог чарт рисует сам в конце полосы, поэтому хвост из подписи убираем —
// иначе одно и то же число стоит дважды. Убирается только хвост вида
// «— <число>»: если в подписи нет такого окончания, она остаётся как есть.
const STRIP_TOTAL_SUFFIX = true;
// Пустая строка — подзаголовок не рисуется, шапка компактнее.
const SUBTITLE = '';

// ---------------------------------------------------------------------------
//  Серверная часть: данные → модель чарта
// ---------------------------------------------------------------------------
function toNumber(value) {
    if (value === null || value === undefined || value === '') return 0;
    const n = Number(String(value).replace(/\s/g, '').replace(',', '.'));
    return isNaN(n) ? 0 : n;
}

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

const rows = normalizeRows(Editor.getLoadedData());

// Порядок категорий — как пришёл из источника: нумерация «1., 1.1, 1.2, 2.»
// уже задаёт нужный порядок, а сортировка строк его бы сломала.
const categories = [];
rows.forEach(function (row) {
    const key = String(row[X_FIELD]);
    if (categories.indexOf(key) === -1) categories.push(key);
});

// Подпись для показа: без хвоста «— 76».
const labels = categories.map(function (key) {
    return STRIP_TOTAL_SUFFIX ? key.replace(/\s*[—–-]\s*\d[\d\s]*$/, '') : key;
});

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
    labels: labels,
    series: series,
    totals: totals,
    mode: mode,
    brand: BRAND,
    font: FONT,
    // Отступ шапки от левого края холста.
    titleX: 16,
    // Предел ширины колонки с подписями категорий: длиннее — усечём.
    maxLabelWidth: 220,
    // Толщина полосы: доля слота и жёсткий максимум в пикселях.
    barThicknessRatio: 0.5,
    maxBarThickness: 56,
    // Узкий сегмент расширяется ровно настолько, чтобы цифра поместилась
    // внутри блока; недостающие пиксели снимаются с крупных сегментов, так
    // что общая длина полосы остаётся верной. false — выключить.
    fitLabels: true,
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
            const H = Math.max(240, parseInt(options && options.height, 10) || 480);

            const esc = function (value) {
                return String(value)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
            };

            const fmt = function (value, digits) {
                const d = digits === undefined ? 0 : digits;
                const fixed = Math.abs(Number(value)).toFixed(d);
                const parts = fixed.split('.');
                parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
                return (Number(value) < 0 ? '−' : '') + parts.join(',');
            };

            // Ширина строки на глаз: цифры в 12 px ≈ 7,2 px на знак.
            const textW = function (text, size) {
                return String(text).length * (size || 12) * 0.6;
            };

            // Цвет подписи внутри сегмента — по контрасту с заливкой.
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

            // Легенда считается заранее: от числа рядов зависит высота подвала.
            const itemW = m.series.map(function (s) {
                return 14 + 8 + s.name.length * 7.2 + 24;
            });
            const maxRowW = W - 2 * 16;
            const legendRows = [[]];
            let rowW = 0;
            m.series.forEach(function (s, i) {
                if (legendRows[legendRows.length - 1].length && rowW + itemW[i] - 24 > maxRowW) {
                    legendRows.push([]);
                    rowW = 0;
                }
                legendRows[legendRows.length - 1].push({series: s, w: itemW[i]});
                rowW += itemW[i];
            });
            const ROW_H = 18;

            // Подпись длиннее колонки усекается многоточием; целиком её видно
            // при наведении.
            const fitLabel = function (text, maxW) {
                if (textW(text, 13) <= maxW) return String(text);
                let t = String(text);
                while (t.length > 1 && textW(t + '…', 13) > maxW) t = t.slice(0, -1);
                return t + '…';
            };

            const headerH = m.title ? (m.subtitle ? 78 : 58) : 24;

            // Левое поле — по самой длинной подписи, но не шире предела:
            // фиксированное поле либо резало бы «3. Нет работ МЦ (платных)»,
            // либо съедало полширины на коротких названиях.
            let labelW = 0;
            m.labels.forEach(function (t) { labelW = Math.max(labelW, textW(t, 13)); });
            // Второй предел — от ширины холста: на узком дашборде колонка
            // подписей иначе съедает всю область построения.
            const labelColW = Math.min(m.maxLabelWidth, Math.max(60, W * 0.34),
                Math.ceil(labelW) + 4);

            // Справа оставляем место под подпись итога, снизу — под шкалу и
            // столько рядов легенды, сколько получилось.
            const pad = {top: headerH, right: 76, bottom: 38 + legendRows.length * ROW_H,
                left: labelColW + 24};
            const plotW = Math.max(40, W - pad.left - pad.right);
            const plotH = Math.max(40, H - pad.top - pad.bottom);
            const x0 = pad.left;

            const value = function (si, ci) {
                const raw = m.series[si].data[ci] || 0;
                if (m.mode !== 'percent') return raw;
                const total = m.totals[ci] || 0;
                return total ? (raw / total) * 100 : 0;
            };
            const stackTotal = function (ci) {
                return m.mode === 'percent' ? (m.totals[ci] ? 100 : 0) : (m.totals[ci] || 0);
            };

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
            const xMax = m.mode === 'percent' ? 100 : niceMax(peak);
            const scale = function (v) { return xMax ? (v / xMax) * plotW : 0; };

            const svg = [];

            svg.push('<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H +
                '" xmlns="http://www.w3.org/2000/svg" font-family="' + esc(F) + '" role="img">');
            svg.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + B.bg + '"/>');

            if (m.title) {
                svg.push('<text x="' + m.titleX + '" y="34" fill="' + B.ink +
                    '" font-size="20" font-weight="700">' + esc(m.title) + '</text>');
            }
            if (m.subtitle) {
                svg.push('<text x="' + m.titleX + '" y="56" fill="' + B.muted +
                    '" font-size="13">' + esc(m.subtitle) + '</text>');
            }

            // Сетка: вертикальные линии, подписи шкалы снизу.
            const tickCount = 5;
            for (let t = 0; t <= tickCount; t++) {
                const v = (xMax / tickCount) * t;
                const x = x0 + scale(v);
                svg.push('<line x1="' + x + '" y1="' + pad.top + '" x2="' + x +
                    '" y2="' + (pad.top + plotH) + '" stroke="' + (t === 0 ? B.axis : B.grid) +
                    '" stroke-width="1"' + (t === 0 ? '' : ' stroke-dasharray="4 4"') + '/>');
                svg.push('<text x="' + x + '" y="' + (pad.top + plotH + 20) + '" fill="' + B.muted +
                    '" font-size="12" text-anchor="middle">' +
                    (m.mode === 'percent' ? fmt(v) + ' %' : fmt(v)) + '</text>');
            }

            // Полосы
            const slot = plotH / m.categories.length;
            const barH = Math.max(10, Math.min(m.maxBarThickness, slot * m.barThicknessRatio));

            for (let ci = 0; ci < m.categories.length; ci++) {
                const cy = pad.top + slot * ci + slot / 2;
                const y = cy - barH / 2;
                const total = stackTotal(ci);

                // Подпись категории слева от оси; полный текст — в подсказке.
                const label = fitLabel(m.labels[ci], labelColW);
                svg.push('<g><title>' + esc(m.categories[ci]) + '</title>' +
                    '<text x="' + (x0 - 12) + '" y="' + (cy + 4) + '" fill="' + B.ink +
                    '" font-size="13" text-anchor="end">' + esc(label) + '</text></g>');

                // Видимые сегменты слева направо.
                const parts = [];
                for (let si = 0; si < m.series.length; si++) {
                    const v = value(si, ci);
                    if (v <= 0) continue;
                    const raw = m.series[si].data[ci] || 0;
                    const text = m.mode === 'percent' ? fmt(v) + ' %' : fmt(raw);
                    parts.push({
                        si: si,
                        v: v,
                        raw: raw,
                        text: text,
                        w: scale(v),
                        need: textW(text, 12) + 12,   // цифра плюс поля внутри блока
                    });
                }

                // Узкие сегменты расширяем ровно до размера подписи, недостающие
                // пиксели снимаем с крупных пропорционально их запасу.
                if (m.fitLabels) {
                    const tight = parts.filter(function (p) { return p.w < p.need; });
                    if (tight.length) {
                        const deficit = tight.reduce(function (a, p) { return a + (p.need - p.w); }, 0);
                        const donors = parts.filter(function (p) { return p.w > p.need; });
                        const surplus = donors.reduce(function (a, p) { return a + (p.w - p.need); }, 0);

                        if (surplus >= deficit) {
                            const shares = donors.map(function (p) { return (p.w - p.need) / surplus; });
                            tight.forEach(function (p) { p.w = p.need; });
                            donors.forEach(function (p, k) { p.w -= shares[k] * deficit; });
                        }
                        // Иначе полоса слишком коротка, чтобы вместить все цифры:
                        // оставляем честные пропорции.
                    }
                }

                const lastPart = parts.length ? parts[parts.length - 1] : null;
                const GAP = 2;
                let cursor = x0;
                let firstDrawn = true;

                parts.forEach(function (p) {
                    const x = cursor;
                    cursor = x + p.w;

                    // Зазор срезается слева сегмента, поэтому конец полосы не «плывёт».
                    const off = firstDrawn ? 0 : GAP;
                    const drawX = x + off;
                    const drawW = Math.max(1, p.w - off);
                    firstDrawn = false;

                    const color = m.series[p.si].color;
                    const r = Math.min(4, drawW / 2);
                    const shape = (p === lastPart)
                        ? '<path d="M' + drawX + ' ' + y + ' L' + (drawX + drawW - r) + ' ' + y +
                          ' Q' + (drawX + drawW) + ' ' + y + ' ' + (drawX + drawW) + ' ' + (y + r) +
                          ' L' + (drawX + drawW) + ' ' + (y + barH - r) +
                          ' Q' + (drawX + drawW) + ' ' + (y + barH) + ' ' + (drawX + drawW - r) + ' ' + (y + barH) +
                          ' L' + drawX + ' ' + (y + barH) + ' Z" fill="' + color + '"/>'
                        : '<rect x="' + drawX + '" y="' + y + '" width="' + drawW +
                          '" height="' + barH + '" fill="' + color + '"/>';

                    const share = m.totals[ci] ? (p.raw / m.totals[ci]) * 100 : 0;
                    const hint = m.labels[ci] + ' · ' + m.series[p.si].name + ': ' +
                        fmt(p.raw) + ' (' + fmt(share, 1) + ' %)';

                    svg.push('<g><title>' + esc(hint) + '</title>' + shape + '</g>');

                    if (drawW >= textW(p.text, 12) + 6) {
                        svg.push('<text x="' + (drawX + drawW / 2) + '" y="' + (cy + 4) +
                            '" fill="' + labelColor(color) + '" font-size="12" font-weight="600" ' +
                            'text-anchor="middle" pointer-events="none">' + p.text + '</text>');
                    }
                });

                // ⬇ Сумма в итогах — в конце полосы.
                if (total > 0) {
                    svg.push('<text x="' + (cursor + 10) + '" y="' + (cy + 4) + '" fill="' + B.ink +
                        '" font-size="13" font-weight="700" text-anchor="start">' +
                        (m.mode === 'percent' ? fmt(m.totals[ci]) : fmt(total)) + '</text>');
                }
            }

            // Отрисовка легенды.
            const legendY0 = H - 14 - (legendRows.length - 1) * ROW_H;

            legendRows.forEach(function (row, ri) {
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
