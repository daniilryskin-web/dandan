// Компактный вариант Prepare: то же самое без строк-комментариев.
// Полная версия с пояснениями — Prepare.js.

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

const SOURCE_KEY = 'composition';
const TITLE = 'Состав услуг по ОЦС и ДК';
const SUBTITLE = '';

const TOTAL_LABEL = 'ВСЕГО';
const SHOW_TOTAL = true;

const BASE_FIELD = ['ВСЕГО услуг', 'ВСЕГО'];

const TRACKS = [
    {label: 'ОЦС'},
    {label: 'ДК'},
];

const SEGMENTS = [
    {
        label: 'ЛиР (ниже не приводятся)',
        common: ['ЛиР (ниже не приводятся)', 'ЛиР (ниже не приводятся) (индикатор)'],
        color: BRAND.violetLight,
    },
    {
        label: 'Не требуется',
        perTrack: {
            'ОЦС': ['Не требуется ОЦС', 'Не требуется ОЦС (индикатор)'],
            'ДК': ['Не требуется ДК', 'Не требуется ДК (индикатор)'],
        },
        color: BRAND.violetDeep,
    },
    {
        label: 'Перенос на 2027',
        perTrack: {
            'ОЦС': ['Перенос на 2027 ОЦС', 'Перенос на 2027 ОЦС (индикатор)'],
            'ДК': ['Перенос на 2027 ДК', 'Перенос на 2027 ДК (индикатор)'],
        },
        color: BRAND.magenta,
    },
    {
        label: 'Исключены работы в 2026',
        perTrack: {
            'ОЦС': ['Исключены работы в 2026 ОЦС', 'Исключены работы в 2026 ОЦС (индикатор)'],
            'ДК': ['Исключены работы в 2026 ДК', 'Исключены работы в 2026 ДК (индикатор)'],
        },
        color: BRAND.ochre,
    },
    {
        label: 'Оставшиеся',
        remainder: true,
        color: BRAND.violet,
    },
];

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

const keys = [];
rows.forEach(function (row) {
    if (!row) return;
    Object.keys(row).forEach(function (field) {
        if (keys.indexOf(field) === -1) keys.push(field);
    });
});

function valueOf(names) {
    for (let i = 0; i < names.length; i++) {
        if (keys.indexOf(names[i]) === -1) continue;
        return rows.reduce(function (sum, row) {
            return sum + (row ? toNumber(row[names[i]]) : 0);
        }, 0);
    }
    return null;
}

const missingFields = [];

function valueOrZero(names) {
    const value = valueOf(names);
    if (value === null && missingFields.indexOf(names[0]) === -1) {
        missingFields.push(names[0]);
    }
    return value === null ? 0 : value;
}

let problem = null;

if (!rows.length) {
    problem = 'Источник не вернул ни одной строки';
}

const base = problem ? null : valueOf(BASE_FIELD);

if (!problem && base === null) {
    problem = 'В ответе источника нет поля «' + BASE_FIELD[0] + '». Пришли поля: ' +
        keys.join(', ');
}

const tracks = [];
const usedSegments = {};

if (!problem) {
    TRACKS.forEach(function (track) {
        let spent = 0;
        const segments = [];

        SEGMENTS.forEach(function (spec) {
            let value;

            if (spec.remainder) {
                value = base - spent;
            } else if (spec.common) {
                value = valueOrZero(spec.common);
            } else {
                const names = spec.perTrack && spec.perTrack[track.label];
                value = names ? valueOrZero(names) : 0;
            }

            if (!spec.remainder) spent += value;
            if (value > 0) usedSegments[spec.label] = spec.color;

            segments.push({
                name: spec.label,
                color: spec.color,
                value: value,
                share: base ? (value / base) * 100 : 0,
            });
        });

        tracks.push({
            label: track.label,
            segments: segments,
            total: segments.reduce(function (sum, s) { return sum + Math.max(0, s.value); }, 0),
            negative: segments.some(function (s) { return s.value < 0; }),
        });
    });
}

const legend = SEGMENTS
    .filter(function (spec) { return usedSegments[spec.label]; })
    .map(function (spec) { return {name: spec.label, color: spec.color}; });

if (!problem && tracks.some(function (t) { return t.negative; })) {
    problem = 'Сумма вычитаемых больше, чем «' + BASE_FIELD[0] +
        '»: проверьте поля формулы';
}

const model = {
    title: TITLE,
    subtitle: SUBTITLE,
    tracks: tracks,
    legend: legend,
    total: base || 0,
    totalLabel: TOTAL_LABEL,
    showTotal: SHOW_TOTAL,
    problem: problem,
    missingFields: missingFields,
    brand: BRAND,
    font: FONT,
    titleX: 16,
    barThickness: 44,
    maxLabelWidth: 160,
    fitLabels: true,
};

module.exports = {
    render: Editor.wrapFn({
        args: [model],

        fn: function (options, m) {
            const B = m.brand;
            const F = m.font;

            const W = Math.max(320, parseInt(options && options.width, 10) || 960);
            const H = Math.max(160, parseInt(options && options.height, 10) || 280);

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

            const PAD = 16;
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

            if (m.showTotal && m.total > 0) {
                const totalText = (m.totalLabel ? m.totalLabel + ' ' : '') + fmt(m.total);
                svg.push('<text x="' + (W - PAD) + '" y="34" fill="' + B.ink +
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

            let headerH = m.title ? (m.subtitle ? 74 : 54) : 20;

            if (m.missingFields && m.missingFields.length) {
                svg.push('<text x="' + m.titleX + '" y="' + (headerH - 4) + '" fill="' + B.muted +
                    '" font-size="12">' +
                    esc('Нет полей: ' + m.missingFields.join(', ')) + '</text>');
                headerH += 18;
            }

            const itemW = m.legend.map(function (it) {
                return 14 + 8 + it.name.length * 7.2 + 24;
            });
            const maxRowW = W - 2 * PAD;
            const legendRows = [[]];
            let rowW = 0;
            m.legend.forEach(function (it, i) {
                if (legendRows[legendRows.length - 1].length && rowW + itemW[i] - 24 > maxRowW) {
                    legendRows.push([]);
                    rowW = 0;
                }
                legendRows[legendRows.length - 1].push({item: it, w: itemW[i]});
                rowW += itemW[i];
            });

            const ROW_H = 18;
            const legendH = 16 + legendRows.length * ROW_H;

            let labelW = 0;
            m.tracks.forEach(function (t) { labelW = Math.max(labelW, textW(t.label, 13)); });
            const labelColW = Math.min(m.maxLabelWidth, Math.max(30, W * 0.25),
                Math.ceil(labelW) + 4);

            const x0 = PAD + labelColW + 12;
            const plotW = Math.max(40, W - x0 - PAD);
            const plotH = Math.max(30, H - headerH - legendH);

            let maxTotal = 0;
            m.tracks.forEach(function (t) { maxTotal = Math.max(maxTotal, t.total); });
            const scale = function (v) { return maxTotal ? (v / maxTotal) * plotW : 0; };

            const slot = plotH / Math.max(1, m.tracks.length);
            const barH = Math.min(m.barThickness, Math.max(16, slot * 0.62));

            m.tracks.forEach(function (track, ti) {
                const cy = headerH + slot * ti + slot / 2;
                const y = cy - barH / 2;

                svg.push('<text x="' + (x0 - 12) + '" y="' + (cy + 4) + '" fill="' + B.ink +
                    '" font-size="13" font-weight="600" text-anchor="end">' +
                    esc(track.label) + '</text>');

                const parts = track.segments
                    .filter(function (s) { return s.value > 0; })
                    .map(function (s) {
                        const text = fmt(s.value);
                        return {
                            s: s,
                            text: text,
                            w: scale(s.value),
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
                let cursor = x0;

                parts.forEach(function (p, i) {
                    const first = i === 0;
                    const last = i === parts.length - 1;

                    const x = cursor + (first ? 0 : GAP);
                    const w = Math.max(1, p.w - (first ? 0 : GAP));
                    cursor += p.w;

                    const rl = first ? Math.min(R, w / 2) : 0;
                    const rr = last ? Math.min(R, w / 2) : 0;

                    svg.push('<g><title>' + esc(track.label + ' · ' + p.s.name + ': ' +
                        p.text + ' (' + fmt(p.s.share, 1) + ' %)') + '</title>' +
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
                            '" fill="' + labelColor(p.s.color) + '" font-size="12" ' +
                            'font-weight="600" text-anchor="middle" pointer-events="none">' +
                            p.text + '</text>');
                    }
                });

                if (m.total && track.total !== m.total) {
                    svg.push('<text x="' + (cursor + 8) + '" y="' + (cy + 4) + '" fill="' +
                        B.muted + '" font-size="12">' + fmt(track.total) + '</text>');
                }
            });

            const legendY0 = H - 14 - (legendRows.length - 1) * ROW_H;

            legendRows.forEach(function (row, ri) {
                const rw = row.reduce(function (a, it) { return a + it.w; }, 0) - 24;
                let lx = Math.max(PAD, (W - rw) / 2);
                const ly = legendY0 + ri * ROW_H;

                row.forEach(function (it) {
                    svg.push('<rect x="' + lx + '" y="' + (ly - 9) +
                        '" width="10" height="10" rx="2" fill="' + it.item.color + '"/>');
                    svg.push('<text x="' + (lx + 18) + '" y="' + ly + '" fill="' + B.ink +
                        '" font-size="13">' + esc(it.item.name) + '</text>');
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
