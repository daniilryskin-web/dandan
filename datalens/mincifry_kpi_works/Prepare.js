// ============================================================================
//  Вкладка Prepare — Advanced-чарт: индикатор (одно число крупно).
//
//  Один код на три чарта: в каждом чарте DataLens меняется только строка
//  ACTIVE. Заводить три почти одинаковые копии смысла нет — расходились бы
//  при первой же правке.
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
    ink: '#17123B',
    muted: '#6B6690',
    grid: '#E7E3F5',
    bg: '#FAF9FE',
};

const FONT = "Ubuntu, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

const SOURCE_KEY = 'works';

// ⬇ ЕДИНСТВЕННОЕ, что меняется между тремя чартами.
const ACTIVE = 'inWork';   // 'inWork' | 'notStarted' | 'done' | 'total'

const INDICATORS = {
    inWork: {
        title: 'Всего услуг в работе',
        field: '2. В работе (индикатор)',
        aliases: ['2. В работе'],
    },
    notStarted: {
        title: 'Работы не начаты',
        field: '1. Работы не начаты (индикатор)',
        aliases: ['1. Работы не начаты'],
    },
    done: {
        title: 'Реализовано услуг',
        field: '3. Реализовано (индикатор)',
        aliases: ['3. Реализовано'],
    },
    // Итог: отдельного поля с ним в запросе нет, поэтому складываем стадии —
    // те же, из которых считается знаменатель. Полоса тут не нужна: это и
    // есть целое, она была бы всегда полной.
    total: {
        title: 'Всего услуг',
        fromDenominator: true,
    },
};

// Поле, по которому фильтруем, и строка, из которой берём число.
const FILTER_FIELD = 'Тип';
const FILTER_VALUES = ['ВСЕГО'];

// Знаменатель для полосы: сумма всех стадий в той же строке. Пустой список —
// полосы не будет, останется одно число.
const DENOMINATOR_FIELDS = [
    ['0. Данные уточняются (индикатор)', '0. Данные уточняются'],
    ['1. Работы не начаты (индикатор)', '1. Работы не начаты'],
    ['2. В работе (индикатор)', '2. В работе'],
    ['3. Реализовано (индикатор)', '3. Реализовано'],
];

// Здесь считаются штуки, а не проценты — единицу не дописываем.
const VALUE_SUFFIX = '';

// Полоса выполнения под числом. false — только число.
const SHOW_PROGRESS = true;

// ---------------------------------------------------------------------------
//  Серверная часть: данные → модель
// ---------------------------------------------------------------------------
function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    // «45 %», «45,5» и «1 234» приводим к числу; всё остальное — не число.
    const cleaned = String(value).replace(/[%\s ]/g, '').replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    return Number(cleaned);
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

// Значение из параметра перекрывает список в коде — это позволяет включить
// селектор во вкладке Controls, ничего не меняя здесь.
const wanted = (params.filter && params.filter[0])
    ? [params.filter[0]]
    : FILTER_VALUES;

const rows = normalizeRows(Editor.getLoadedData());

// Сравниваем «мягко»: неразрывный пробел, двойные пробелы и регистр —
// самая частая причина, по которой глазами значения одинаковые, а строкой
// не совпадают.
function norm(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

// Диагностика: пустой индикатор должен объяснять, что именно не сложилось.
// Раньше здесь было одно сообщение на все случаи, и оно вводило в
// заблуждение — писало «строка не найдена» даже когда строка была, а пустым
// оказалось значение.
let problem = null;
const keys = rows.length ? Object.keys(rows[0]) : [];

if (!rows.length) {
    problem = 'Источник не вернул ни одной строки';
} else if (keys.indexOf(FILTER_FIELD) === -1) {
    // Ответ разобран, но колонки названы иначе, чем ожидает код.
    // Поле со значением проверяется ниже: у него есть запасные имена.
    problem = 'В ответе источника нет поля «' + FILTER_FIELD +
        '». Пришли поля: ' + keys.join(', ');
}

const wantedNorm = wanted.map(norm);

const matched = problem ? [] : rows.filter(function (row) {
    if (!wanted.length) return true;
    return wantedNorm.indexOf(norm(row[FILTER_FIELD])) !== -1;
});

if (!problem && !matched.length) {
    // Показываем, какие значения в поле реально пришли: разница обычно в
    // написании, и увидеть её можно только так.
    const seen = [];
    rows.forEach(function (row) {
        const v = String(row[FILTER_FIELD]);
        if (seen.indexOf(v) === -1 && seen.length < 6) seen.push(v);
    });
    problem = 'В поле «' + FILTER_FIELD + '» нет значения «' + wanted.join('», «') +
        '». Пришли: «' + seen.join('», «') + '»';
}

const active = INDICATORS[ACTIVE];

if (!active) {
    throw new Error('Неизвестное значение ACTIVE: «' + ACTIVE + '». Допустимы: ' +
        Object.keys(INDICATORS).join(', '));
}

// Имя поля берём первое из списка, которое реально пришло: те же меры
// встречаются и без суффикса «(индикатор)».
function pickField(names) {
    for (let i = 0; i < names.length; i++) {
        if (keys.indexOf(names[i]) !== -1) return names[i];
    }
    return null;
}

const valueField = active.fromDenominator
    ? null
    : pickField([active.field].concat(active.aliases || []));

if (!problem && !active.fromDenominator && !valueField) {
    problem = 'В ответе источника нет поля «' + active.field + '». Пришли поля: ' +
        keys.join(', ');
}

// Строка: для итога — первая подходящая, для остальных — первая, где нужное
// значение непустое.
let raw = null;
let sourceRow = null;
for (let i = 0; i < matched.length; i++) {
    if (active.fromDenominator) { sourceRow = matched[i]; break; }
    if (!valueField) break;

    const v = matched[i][valueField];
    if (v !== null && v !== undefined && String(v).trim() !== '') {
        raw = v;
        sourceRow = matched[i];
        break;
    }
}

if (!problem && !active.fromDenominator && raw === null) {
    problem = 'Строка «' + wanted.join('», «') + '» найдена, но поле «' +
        (valueField || active.field) + '» в ней пустое';
}

// Знаменатель — сумма стадий в той же строке.
let denominator = 0;
if (sourceRow && DENOMINATOR_FIELDS.length) {
    DENOMINATOR_FIELDS.forEach(function (names) {
        const field = pickField(names);
        if (!field) return;
        const n = toNumber(sourceRow[field]);
        if (n !== null) denominator += n;
    });
}

if (active.fromDenominator) {
    raw = denominator > 0 ? denominator : null;
    if (!problem && raw === null) {
        problem = 'Сумма стадий в строке «' + wanted.join('», «') + '» равна нулю';
    }
}

// У итога полосы нет: она была бы всегда полной и ничего не сообщала.
const withBar = SHOW_PROGRESS && denominator > 0 && !active.fromDenominator;

const numeric = toNumber(raw);

// Формат «1 234,5»: узкий разделитель разрядов, запятая в дробной части.
function formatNumber(value) {
    const parts = String(value).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return parts.join(',');
}

const model = {
    title: active.title,
    // Число показываем как есть, если поле уже отдало строку с единицей.
    text: raw === null ? '—'
        : (numeric === null ? String(raw)
            : formatNumber(numeric) + VALUE_SUFFIX),
    value: numeric,
    hasData: raw !== null,
    // Подсказка, когда значения нет: пустой индикатор без объяснения выглядит
    // как поломка, а односложное «нет данных» не даёт что-либо починить.
    emptyHint: problem || 'Нет данных',
    showProgress: withBar,
    progressMax: denominator,
    // Подпись под полосой: без знаменателя число «70» ни о чём не говорит.
    caption: withBar ? 'из ' + String(denominator) : '',
    brand: BRAND,
    font: FONT,
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

            const W = Math.max(200, parseInt(options && options.width, 10) || 420);
            const H = Math.max(120, parseInt(options && options.height, 10) || 200);

            const esc = function (value) {
                return String(value)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
            };

            const PAD = 20;
            const availW = W - PAD * 2;

            const svg = [];
            svg.push('<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H +
                '" xmlns="http://www.w3.org/2000/svg" font-family="' + esc(F) + '" role="img">');
            svg.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + B.bg + '"/>');

            svg.push('<text x="' + PAD + '" y="' + (PAD + 12) + '" fill="' + B.ink +
                '" font-size="15" font-weight="600">' + esc(m.title) + '</text>');

            const barH = 8;
            const hasBar = m.showProgress && m.value !== null;
            // Под полосой ещё строка «из 235»: без знаменателя число «70» ни о
            // чём не говорит.
            const progressBlock = hasBar ? barH + 22 + (m.caption ? 16 : 0) : 0;

            // Кегль числа подбираем под холст: и по высоте, и по ширине строки,
            // иначе длинное значение вроде «1 234,5 %» вылезет за край.
            const room = H - (PAD + 20) - PAD - progressBlock;
            let size = Math.min(room * 0.92, availW / Math.max(1, m.text.length * 0.6), 96);
            size = Math.max(20, size);

            // В пустом состоянии прочерк во весь холст читается как поломка —
            // уменьшаем его и оставляем место для пояснения.
            if (!m.hasData) size = Math.min(size, 40);

            const valueY = PAD + 24 + size * 0.78;

            svg.push('<text x="' + PAD + '" y="' + valueY + '" fill="' +
                (m.hasData ? B.violet : B.muted) + '" font-size="' + size +
                '" font-weight="700">' + esc(m.text) + '</text>');

            if (!m.hasData) {
                // Диагностика бывает длинной — переносим по словам, иначе она
                // уезжает за край холста и пользы от неё ноль.
                const maxChars = Math.max(16, Math.floor((W - PAD * 2) / 6.6));
                const lines = [];
                let line = '';
                String(m.emptyHint).split(' ').forEach(function (word) {
                    if (!line.length) { line = word; return; }
                    if ((line + ' ' + word).length <= maxChars) {
                        line += ' ' + word;
                    } else {
                        lines.push(line);
                        line = word;
                    }
                });
                if (line.length) lines.push(line);

                lines.slice(0, 6).forEach(function (text, i) {
                    svg.push('<text x="' + PAD + '" y="' + (valueY + 22 + i * 17) +
                        '" fill="' + B.muted + '" font-size="13">' + esc(text) + '</text>');
                });
            } else if (hasBar) {
                const trackY = valueY + 18;
                const done = Math.max(0, Math.min(1, m.value / m.progressMax));

                svg.push('<rect x="' + PAD + '" y="' + trackY + '" width="' + availW +
                    '" height="' + barH + '" rx="' + (barH / 2) + '" fill="' + B.grid + '"/>');

                if (done > 0) {
                    // Ширина не меньше высоты полосы: иначе при 1–2 % скруглённый
                    // прямоугольник вырождается в точку.
                    const doneW = Math.max(barH, availW * done);
                    svg.push('<rect x="' + PAD + '" y="' + trackY + '" width="' + doneW +
                        '" height="' + barH + '" rx="' + (barH / 2) + '" fill="' + B.violet + '"/>');
                }

                if (m.caption) {
                    svg.push('<text x="' + PAD + '" y="' + (trackY + barH + 15) + '" fill="' +
                        B.muted + '" font-size="12">' + esc(m.caption) + '</text>');
                }
            }

            svg.push('</svg>');

            return Editor.generateHtml(
                '<div style="width:100%;background:' + B.bg + ';font-family:' + F + '">' +
                svg.join('') + '</div>'
            );
        },
    }),
};
