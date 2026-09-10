// ============================================================================
//  Вкладка Prepare — Advanced-чарт: сгруппированные горизонтальные полосы.
//  Статусы по вертикали, внутри каждого — полоса ОЦС и полоса ДК.
//
//  Код вне Editor.wrapFn исполняется на сервере: здесь готовим данные.
//  Код внутри Editor.wrapFn исполняется в браузере: там рисуем SVG.
//  Замыкания через границу wrapFn не работают — всё, что нужно рендеру,
//  передаётся через args.
// ============================================================================

// --- Палитра ----------------------------------------------------------------
// Внимание: набор отличается от стековых чартов не по прихоти. В стеке
// #4B2DE8 и #4A38AD никогда не соприкасаются — между ними светлая ступень.
// Здесь полосы группы идут вплотную, и эта пара различается всего на ΔE 9.3,
// то есть читается как один цвет. Третья ступень заменена на маджентовый
// акцент: набор проходит проверку по всем парам, а не только по соседним.
const BRAND = {
    violetLight: '#8E7CF2',
    violet: '#4B2DE8',
    magenta: '#C0397E',
    ochre: '#8A6A00',
    teal: '#0A7D9E',
    violetDeep: '#4A38AD',
    ink: '#17123B',
    muted: '#6B6690',
    grid: '#E7E3F5',
    axis: '#CFC9E8',
    bg: '#FAF9FE',
};

const FONT = "Ubuntu, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

// Порядок = порядок полос в группе сверху вниз.
// aliases — запасные имена поля: в датасете они называются «ОЦС2
// (индикатор)», в визарде те же меры были «ОЦС» и «ДК». Берём то имя, которое
// реально пришло, чтобы переименование поля не роняло чарт молча.
// label — подпись серии в легенде: суффикс «(индикатор)» там не нужен.
const SERIES_SPEC = [
    {field: 'ОЦС2 (индикатор)', aliases: ['ОЦС'], label: 'ОЦС', color: BRAND.violet},
    {field: 'ДК2 (индикатор)', aliases: ['ДК'], label: 'ДК', color: BRAND.violetLight},
];

const FALLBACK_COLORS = [
    BRAND.violetLight, BRAND.violet, BRAND.magenta,
    BRAND.teal, BRAND.ochre, BRAND.violetDeep,
];

const CATEGORY_FIELD = 'Статус';
const SOURCE_KEY = 'status';

// Фильтр «Статус не принадлежит множеству» из вашего визарда. Сравнение
// мягкое: неразрывный пробел, двойные пробелы и регистр совпадению не мешают.
const EXCLUDE_CATEGORIES = ['Уровень достижения, %'];

// Сортировка по номеру в начале подписи: 0., 1., 2., 3., 4., 5.
// Сортировка строк тут не годится — «10.» встало бы перед «2.».
const SORT_BY_NUMBER = true;

const TITLE = 'ОЦС и ДК по статусам';
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

// Мягкое сравнение: неразрывный пробел, двойные пробелы и регистр — самая
// частая причина, по которой глазами значения одинаковые, а строкой нет.
function norm(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

const excluded = EXCLUDE_CATEGORIES.map(norm);

const rows = normalizeRows(Editor.getLoadedData()).filter(function (row) {
    return excluded.indexOf(norm(row[CATEGORY_FIELD])) === -1;
});

function numericPrefix(text) {
    const found = String(text).match(/^\s*(\d+(?:\.\d+)*)/);
    return found ? found[1].split('.').map(Number) : null;
}

function compareCategories(a, b) {
    const pa = numericPrefix(a);
    const pb = numericPrefix(b);

    if (!pa && !pb) return String(a).localeCompare(String(b), 'ru');
    if (!pa) return 1;
    if (!pb) return -1;

    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const da = pa[i] === undefined ? -1 : pa[i];
        const db = pb[i] === undefined ? -1 : pb[i];
        if (da !== db) return da - db;
    }
    return 0;
}

const categories = [];
rows.forEach(function (row) {
    const key = String(row[CATEGORY_FIELD]);
    if (categories.indexOf(key) === -1) categories.push(key);
});

if (SORT_BY_NUMBER) categories.sort(compareCategories);

const present = [];
rows.forEach(function (row) {
    Object.keys(row).forEach(function (field) {
        if (field !== CATEGORY_FIELD && present.indexOf(field) === -1) present.push(field);
    });
});

// Каждая серия берёт первое из своих имён, которое реально пришло.
const resolved = [];
SERIES_SPEC.forEach(function (spec) {
    const names = [spec.field].concat(spec.aliases || []);
    let found = null;
    for (let i = 0; i < names.length; i++) {
        if (present.indexOf(names[i]) !== -1) { found = names[i]; break; }
    }
    if (found) {
        resolved.push({field: found, name: spec.label || spec.field, color: spec.color});
    }
});

// Всё остальное, что пришло сверх описанного.
present.forEach(function (field) {
    const already = resolved.filter(function (r) { return r.field === field; }).length;
    if (already) return;
    resolved.push({
        field: field,
        name: field,
        color: FALLBACK_COLORS[resolved.length % FALLBACK_COLORS.length],
    });
});

const index = {};
rows.forEach(function (row) {
    const key = String(row[CATEGORY_FIELD]);
    index[key] = index[key] || {};
    resolved.forEach(function (r) {
        if (row[r.field] !== undefined) {
            index[key][r.field] = (index[key][r.field] || 0) + toNumber(row[r.field]);
        }
    });
});

const series = resolved.map(function (r) {
    return {
        name: r.name,
        color: r.color,
        data: categories.map(function (key) {
            return (index[key] && index[key][r.field]) || 0;
        }),
    };
});

const model = {
    title: TITLE,
    subtitle: SUBTITLE,
    categories: categories,
    series: series,
    brand: BRAND,
    font: FONT,
    // Отступ шапки от левого края холста.
    titleX: 16,
    // Предел ширины колонки с подписями категорий: длиннее — усечём.
    maxLabelWidth: 220,
    // Геометрия группы.
    groupRatio: 0.78,      // какую долю слота занимает группа полос
    maxBarThickness: 34,   // предел толщины одной полосы
    barGap: 4,             // просвет между полосами внутри группы
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

            const textW = function (text, size) {
                return String(text).length * (size || 12) * 0.6;
            };

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

            // Колонка подписей — по самой длинной из них, но не шире предела и
            // не шире трети холста: статусы вроде «0. Не разработано» в
            // фиксированное поле не помещаются, а на узком дашборде такая
            // колонка съела бы всю область построения.
            let labelW = 0;
            m.categories.forEach(function (t) { labelW = Math.max(labelW, textW(t, 13)); });
            const labelColW = Math.min(m.maxLabelWidth, Math.max(60, W * 0.34),
                Math.ceil(labelW) + 4);

            // Справа — место под подпись, вынесенную за короткую полосу.
            const pad = {top: headerH, right: 56, bottom: 38 + legendRows.length * ROW_H,
                left: labelColW + 24};
            const plotW = Math.max(40, W - pad.left - pad.right);
            const plotH = Math.max(40, H - pad.top - pad.bottom);
            const x0 = pad.left;

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
            m.series.forEach(function (s) {
                s.data.forEach(function (v) { peak = Math.max(peak, v || 0); });
            });
            const xMax = niceMax(peak);
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
                    '" font-size="12" text-anchor="middle">' + fmt(v) + '</text>');
            }

            // Группы полос
            const n = m.series.length;
            const slot = plotH / m.categories.length;
            const groupH = Math.min(slot * m.groupRatio, n * m.maxBarThickness + (n - 1) * m.barGap);
            const barH = Math.max(4, (groupH - (n - 1) * m.barGap) / n);

            for (let ci = 0; ci < m.categories.length; ci++) {
                const groupTop = pad.top + slot * ci + (slot - groupH) / 2;

                // Подпись категории — по центру группы; полный текст в подсказке.
                svg.push('<g><title>' + esc(m.categories[ci]) + '</title>' +
                    '<text x="' + (x0 - 12) + '" y="' + (groupTop + groupH / 2 + 4) +
                    '" fill="' + B.ink + '" font-size="13" font-weight="600" text-anchor="end">' +
                    esc(fitLabel(m.categories[ci], labelColW)) + '</text></g>');

                for (let si = 0; si < n; si++) {
                    const v = m.series[si].data[ci] || 0;
                    const y = groupTop + si * (barH + m.barGap);
                    const color = m.series[si].color;
                    const text = fmt(v);
                    const hint = m.categories[ci] + ' · ' + m.series[si].name + ': ' + text;

                    // Нулевое значение полосой не нарисовать — ставим цифру у оси,
                    // иначе год молча исчезает из группы.
                    if (v <= 0) {
                        svg.push('<text x="' + (x0 + 6) + '" y="' + (y + barH / 2 + 4) +
                            '" fill="' + B.muted + '" font-size="12">' + text + '</text>');
                        continue;
                    }

                    const w = scale(v);
                    const r = Math.min(4, w / 2, barH / 2);
                    svg.push('<g><title>' + esc(hint) + '</title>' +
                        '<path d="M' + x0 + ' ' + y + ' L' + (x0 + w - r) + ' ' + y +
                        ' Q' + (x0 + w) + ' ' + y + ' ' + (x0 + w) + ' ' + (y + r) +
                        ' L' + (x0 + w) + ' ' + (y + barH - r) +
                        ' Q' + (x0 + w) + ' ' + (y + barH) + ' ' + (x0 + w - r) + ' ' + (y + barH) +
                        ' L' + x0 + ' ' + (y + barH) + ' Z" fill="' + color + '"/></g>');

                    // Цифра внутри полосы, если помещается; иначе сразу за её концом.
                    // Стек здесь не при чём, поэтому вынос ничего не искажает.
                    const fitsInside = w >= textW(text, 12) + 16 && barH >= 14;
                    if (fitsInside) {
                        svg.push('<text x="' + (x0 + w - 8) + '" y="' + (y + barH / 2 + 4) +
                            '" fill="' + labelColor(color) + '" font-size="12" font-weight="600" ' +
                            'text-anchor="end" pointer-events="none">' + text + '</text>');
                    } else {
                        svg.push('<text x="' + (x0 + w + 6) + '" y="' + (y + barH / 2 + 4) +
                            '" fill="' + B.ink + '" font-size="12" font-weight="600" ' +
                            'text-anchor="start" pointer-events="none">' + text + '</text>');
                    }
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
