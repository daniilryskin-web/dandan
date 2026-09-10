// ============================================================================
//  Вкладка Prepare — Advanced-чарт: одна полоса-состав.
//  Измерения нет: три меры складываются в одну полосу во всю ширину,
//  итог стоит в шапке справа.
//
//  Код вне Editor.wrapFn исполняется на сервере: здесь готовим данные.
//  Код внутри Editor.wrapFn исполняется в браузере: там рисуем SVG.
//  Замыкания через границу wrapFn не работают — всё, что нужно рендеру,
//  передаётся через args.
// ============================================================================

// --- Палитра ----------------------------------------------------------------
const BRAND = {
    violet: '#4B2DE8',
    violetLight: '#8E7CF2',
    violetDeep: '#4A38AD',
    magenta: '#C0397E',
    ochre: '#8A6A00',
    teal: '#0A7D9E',
    ink: '#17123B',
    muted: '#6B6690',
    grid: '#E7E3F5',
    bg: '#FAF9FE',
};

const FONT = "Ubuntu, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

// Порядок = порядок сегментов слева направо.
const SERIES_SPEC = [
    {field: 'ЛиР (ниже не приводятся)', color: BRAND.violet},
    {field: 'Не требуется ДК', color: BRAND.violetLight},
    {field: 'Оставшиеся', color: BRAND.violetDeep},
];

const FALLBACK_COLORS = [
    BRAND.violet, BRAND.violetLight, BRAND.violetDeep,
    BRAND.magenta, BRAND.ochre, BRAND.teal,
];

const SOURCE_KEY = 'composition';
const TITLE = 'Состав услуг';
const SUBTITLE = '';

// Подпись к итогу в шапке справа. Пустая строка — только число.
const TOTAL_LABEL = 'ВСЕГО';
const SHOW_TOTAL = true;

// ---------------------------------------------------------------------------
//  Серверная часть: данные → модель
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

const rows = normalizeRows(Editor.getLoadedData());

// Меры: сначала описанные в SERIES_SPEC, затем всё остальное, что пришло.
const known = SERIES_SPEC.map(function (s) { return s.field; });
const present = [];
rows.forEach(function (row) {
    Object.keys(row).forEach(function (field) {
        if (present.indexOf(field) === -1) present.push(field);
    });
});
const measures = known.filter(function (f) { return present.indexOf(f) !== -1; })
    .concat(present.filter(function (f) { return known.indexOf(f) === -1; }));

// Строк обычно одна, но если источник вернёт несколько — складываем: иначе
// чарт молча показал бы только первую.
const series = measures.map(function (field, i) {
    const spec = SERIES_SPEC.filter(function (s) { return s.field === field; })[0];
    return {
        name: field,
        color: spec ? spec.color : FALLBACK_COLORS[i % FALLBACK_COLORS.length],
        value: rows.reduce(function (sum, row) { return sum + toNumber(row[field]); }, 0),
    };
}).filter(function (s) { return s.value > 0; });

const total = series.reduce(function (sum, s) { return sum + s.value; }, 0);

// Диагностика: пустая полоса без объяснения читается как поломка вёрстки.
let problem = null;
const keys = rows.length ? Object.keys(rows[0]) : [];
if (!rows.length) {
    problem = 'Источник не вернул ни одной строки';
} else if (!series.length) {
    problem = 'Ни одна из мер не пришла со значением больше нуля. Пришли поля: ' +
        keys.join(', ');
}

const model = {
    title: TITLE,
    subtitle: SUBTITLE,
    series: series,
    total: total,
    totalLabel: TOTAL_LABEL,
    showTotal: SHOW_TOTAL,
    problem: problem,
    brand: BRAND,
    font: FONT,
    titleX: 16,
    // Толщина полосы и её предел по доле высоты холста.
    barThickness: 56,
    // Узкий сегмент расширяется ровно настолько, чтобы цифра поместилась
    // внутри; недостающие пиксели снимаются с крупных, длина полосы не
    // меняется. false — выключить подгонку.
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
            const H = Math.max(140, parseInt(options && options.height, 10) || 220);

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

            // Итог — в шапке справа: полоса занимает всю ширину, за её концом
            // места для подписи не остаётся.
            if (m.showTotal && m.total > 0) {
                const totalText = (m.totalLabel ? m.totalLabel + ' ' : '') + fmt(m.total);
                svg.push('<text x="' + (W - 16) + '" y="34" fill="' + B.ink +
                    '" font-size="18" font-weight="700" text-anchor="end">' +
                    esc(totalText) + '</text>');
            }

            if (m.problem) {
                svg.push('<text x="' + m.titleX + '" y="70" fill="' + B.muted +
                    '" font-size="13">' + esc(m.problem) + '</text>');
                svg.push('</svg>');
                return Editor.generateHtml(
                    '<div style="width:100%;background:' + B.bg + ';font-family:' + F + '">' +
                    svg.join('') + '</div>'
                );
            }

            const headerH = m.title ? (m.subtitle ? 74 : 54) : 20;
            const legendH = 34;
            const PAD = 16;
            const plotW = Math.max(40, W - PAD * 2);
            const barH = Math.min(m.barThickness, Math.max(20, H - headerH - legendH - 16));
            const y = headerH + Math.max(0, (H - headerH - legendH - barH) / 2);

            // Ширины сегментов; узкие расширяем до размера подписи, недостающее
            // снимаем с крупных пропорционально их запасу.
            const parts = m.series.map(function (s) {
                const text = fmt(s.value);
                return {
                    s: s,
                    text: text,
                    w: m.total ? (s.value / m.total) * plotW : 0,
                    need: textW(text, 12) + 12,
                };
            });

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
                }
            }

            const GAP = 2;
            const R = 4;
            let cursor = PAD;

            parts.forEach(function (p, i) {
                const first = i === 0;
                const last = i === parts.length - 1;

                const x = cursor + (first ? 0 : GAP);
                const w = Math.max(1, p.w - (first ? 0 : GAP));
                cursor += p.w;

                // Скругляем только внешние концы полосы.
                const rl = first ? Math.min(R, w / 2) : 0;
                const rr = last ? Math.min(R, w / 2) : 0;

                svg.push('<g><title>' + esc(p.s.name + ': ' + p.text + ' (' +
                    fmt(m.total ? (p.s.value / m.total) * 100 : 0, 1) + ' %)') + '</title>' +
                    '<path d="M' + (x + rl) + ' ' + y +
                    ' L' + (x + w - rr) + ' ' + y +
                    (rr ? ' Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + rr) : '') +
                    ' L' + (x + w) + ' ' + (y + barH - rr) +
                    (rr ? ' Q' + (x + w) + ' ' + (y + barH) + ' ' + (x + w - rr) + ' ' + (y + barH) : '') +
                    ' L' + (x + rl) + ' ' + (y + barH) +
                    (rl ? ' Q' + x + ' ' + (y + barH) + ' ' + x + ' ' + (y + barH - rl) : '') +
                    ' L' + x + ' ' + (y + rl) +
                    (rl ? ' Q' + x + ' ' + y + ' ' + (x + rl) + ' ' + y : '') +
                    ' Z" fill="' + p.s.color + '"/></g>');

                if (w >= textW(p.text, 12) + 6) {
                    svg.push('<text x="' + (x + w / 2) + '" y="' + (y + barH / 2 + 4) +
                        '" fill="' + labelColor(p.s.color) + '" font-size="12" font-weight="600" ' +
                        'text-anchor="middle" pointer-events="none">' + p.text + '</text>');
                }
            });

            // Легенда по центру снизу; при нехватке ширины переносится по рядам.
            const itemW = m.series.map(function (s) {
                return 14 + 8 + s.name.length * 7.2 + 24;
            });
            const maxRowW = W - 2 * PAD;
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
            const legendY0 = H - 14 - (legendRows.length - 1) * ROW_H;

            legendRows.forEach(function (row, ri) {
                const rw = row.reduce(function (a, it) { return a + it.w; }, 0) - 24;
                let lx = Math.max(PAD, (W - rw) / 2);
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
