// ============================================================================
//  Вкладка Prepare — Advanced-чарт: индикатор (одно число крупно).
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

const SOURCE_KEY = 'gostech';

// Поле, по которому фильтруем, и поле со значением.
const FILTER_FIELD = 'Тип';
const VALUE_FIELD = 'Доля услуг Гостех';

const TITLE = 'Доля услуг Гостех';

// Фильтр «Тип: Услуг Гостех» — тот же, что у вас в визарде. Строка должна
// совпадать со значением в датасете точно; если не совпадёт, индикатор
// покажет прочерк и назовёт, чего не нашёл.
// Пустой список = без фильтра, берётся первая строка с непустым значением.
const FILTER_VALUES = ['Услуг Гостех'];

// Единица измерения дописывается, только если значение пришло числом:
// вычисляемое поле может уже отдавать готовую строку «45 %».
const VALUE_SUFFIX = ' %';

// Полоса выполнения под числом. false — только число.
const SHOW_PROGRESS = true;
// Значение, которое считается полной шкалой для полосы.
const PROGRESS_MAX = 100;

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

const matched = rows.filter(function (row) {
    if (!wanted.length) return true;
    return wanted.indexOf(String(row[FILTER_FIELD]).trim()) !== -1;
});

// Берём первую строку с непустым значением: строки, у которых показатель
// пуст, для индикатора бесполезны.
let raw = null;
for (let i = 0; i < matched.length; i++) {
    const v = matched[i][VALUE_FIELD];
    if (v !== null && v !== undefined && String(v).trim() !== '') {
        raw = v;
        break;
    }
}

const numeric = toNumber(raw);

// Формат «1 234,5»: узкий разделитель разрядов, запятая в дробной части.
function formatNumber(value) {
    const parts = String(value).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return parts.join(',');
}

const model = {
    title: TITLE,
    // Число показываем как есть, если поле уже отдало строку с единицей.
    text: raw === null ? '—'
        : (numeric === null ? String(raw)
            : formatNumber(numeric) + VALUE_SUFFIX),
    value: numeric,
    hasData: raw !== null,
    // Подсказка, когда фильтр ничего не нашёл: пустой индикатор без объяснения
    // выглядит как поломка.
    emptyHint: wanted.length
        ? 'Нет строки со значением «' + wanted.join('», «') + '» в поле «' +
            FILTER_FIELD + '»'
        : 'Нет данных',
    showProgress: SHOW_PROGRESS,
    progressMax: PROGRESS_MAX,
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
            const progressBlock = (m.showProgress && m.value !== null) ? barH + 22 : 0;

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
                svg.push('<text x="' + PAD + '" y="' + (valueY + 22) + '" fill="' + B.muted +
                    '" font-size="13">' + esc(m.emptyHint) + '</text>');
            } else if (m.showProgress && m.value !== null) {
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
            }

            svg.push('</svg>');

            return Editor.generateHtml(
                '<div style="width:100%;background:' + B.bg + ';font-family:' + F + '">' +
                svg.join('') + '</div>'
            );
        },
    }),
};
