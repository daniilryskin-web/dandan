/**
 * DataLens · Расширенный чарт (Advanced Chart) · вкладка JS
 *
 * Доска «Блок → Проект → Продукт»: колонка на проект, карточка на продукт,
 * полоска состава команды по уровням ролей R4…R0.
 *
 * ИСТОЧНИК
 *   Датасет: HR · Иерархия (файл datalens_dataset_tree.csv)
 *   На вкладке «Источники» добавьте поля — порядок значения не имеет,
 *   код ищет их по названию:
 *       Блок · Проект · Продукт кратко · R4 · R3 · R2 · R1 · R0
 *       людей · вакансий · ФОТ_мес · риск
 *
 * ЕСЛИ ЧАРТ ПУСТОЙ
 *   Раскомментируйте строку DEBUG ниже и сохраните: чарт покажет, какие
 *   названия полей реально пришли из датасета. Формат ответа между версиями
 *   DataLens немного отличается, и подстроить нужно только функцию readSource.
 */

// ---------------------------------------------------------------------------
// Оформление
// ---------------------------------------------------------------------------

var COL_WIDTH  = 236;   // ширина колонки проекта, px
var CARD_WIDTH = 212;   // ширина карточки, px
var SLOT       = 94;    // шаг по вертикали между карточками, px
                        // (учитывает карточку с названием в две строки)
var HEAD_ROOM  = 96;    // место под шапку колонки, px

// Порядковая шкала: от старших ролей к младшим. Один тон, разная светлота —
// шкала уровней порядковая, и различать её оттенками одного цвета правильнее,
// чем радугой (и безопаснее для дальтоников).
// Нижнюю ступень не доводим до почти-белого: на белой карточке сегмент
// R0 в #D3DEEC читался как пустое место, а не как стажёры.
var LEVELS = [
    { key: 'R4', color: '#1F2E4D', label: 'R4 руководство' },
    { key: 'R3', color: '#35558A', label: 'R3 ведение' },
    { key: 'R2', color: '#5B83B4', label: 'R2 администрирование' },
    { key: 'R1', color: '#8AAAD0', label: 'R1 исполнение' },
    { key: 'R0', color: '#B9CEE6', label: 'R0 стажировка' }
];

var THEME = {
    ink: '#141C2B', inkSoft: '#4A5568', inkFaint: '#7C8899',
    card: '#FFFFFF', rule: '#DFE4EA', sunk: '#EDF0F3',
    amber: '#A9631F',
    warn: '#96631A', warnBg: '#F3E7CF',
    crit: '#A8382A', critBg: '#F4DEDA',
    font: "'Golos Text', 'Helvetica Neue', Arial, sans-serif",
    mono: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace"
};

// ---------------------------------------------------------------------------
// Чтение данных
// ---------------------------------------------------------------------------

function readSource() {
    var loaded = Editor.getLoadedData();
    var key = Object.keys(loaded)[0];
    var src = loaded[key];

    var fields = (src.fields || []).map(function (f) {
        return f.title || f.legend_item_id || f.guid;
    });
    var rows = (src.result_data[0].rows || []).map(function (r) {
        return r.values;
    });
    return { fields: fields, rows: rows };
}

function indexer(fields) {
    return function (name) {
        var i = fields.indexOf(name);
        if (i < 0) {
            throw new Error(
                'Нет поля «' + name + '». Пришли: ' + fields.join(', ')
            );
        }
        return i;
    };
}

function money(value) {
    var n = Math.round(Number(value) || 0);
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Разметка
// ---------------------------------------------------------------------------

function strip(counts, total) {
    if (!total) { return ''; }
    var segments = LEVELS.map(function (level) {
        var n = counts[level.key];
        if (!n) { return ''; }
        return '<i style="display:block;flex:' + n + ';background:' +
               level.color + '"></i>';
    }).join('');
    return '<div style="display:flex;height:8px;gap:1px;border-radius:2px;' +
           'overflow:hidden;margin:6px 0">' + segments + '</div>';
}

function card(item) {
    var border = THEME.rule;
    var background = THEME.card;
    var accent = THEME.ink;
    var weight = '1px';

    if (item.risk.indexOf('Критично') === 0) {
        border = THEME.crit; background = THEME.critBg;
        accent = THEME.crit; weight = '1.5px';
    } else if (item.risk.indexOf('Риск') === 0) {
        border = THEME.warn; background = THEME.warnBg; accent = THEME.warn;
    }

    var vacancies = item.vacancies
        ? '<span style="color:' + THEME.amber + ';font-weight:600;margin-left:6px">+' +
          item.vacancies + ' вак.</span>'
        : '';

    return '' +
    '<div style="width:' + CARD_WIDTH + 'px;box-sizing:border-box;background:' +
        background + ';border:' + weight + ' solid ' + border + ';border-radius:5px;' +
        'padding:8px 9px;font-family:' + THEME.font + ';text-align:left;' +
        'white-space:normal;line-height:1.3">' +
      '<div style="font-size:12px;font-weight:600;color:' + THEME.ink + '">' +
        escapeHtml(item.product) +
      '</div>' +
      strip(item.counts, item.people) +
      '<div style="display:flex;font-family:' + THEME.mono + ';font-size:10px">' +
        '<span style="font-weight:600;color:' + accent + '">' + item.people + ' чел</span>' +
        vacancies +
        '<span style="margin-left:auto;color:' + THEME.inkFaint + '">' +
          money(item.fot) + ' ₽</span>' +
      '</div>' +
    '</div>';
}

function columnHeader(column) {
    return '' +
    '<div style="width:' + CARD_WIDTH + 'px;box-sizing:border-box;background:' +
        THEME.card + ';border:1px solid ' + THEME.rule + ';border-top:3px solid ' +
        THEME.amber + ';border-radius:6px 6px 4px 4px;padding:8px 9px;' +
        'font-family:' + THEME.font + ';text-align:left;white-space:normal">' +
      '<div style="font-size:9px;font-weight:600;letter-spacing:.06em;' +
        'text-transform:uppercase;color:' + THEME.inkFaint + '">' +
        escapeHtml(column.block) +
      '</div>' +
      '<div style="font-size:13px;font-weight:700;color:' + THEME.ink +
        ';margin-top:2px">' + escapeHtml(column.project) + '</div>' +
      '<div style="font-family:' + THEME.mono + ';font-size:10px;color:' +
        THEME.inkSoft + ';margin-top:4px">' +
        column.items.length + ' прод · ' + column.people + ' чел · ' +
        money(column.fot) + ' ₽</div>' +
    '</div>';
}

// ---------------------------------------------------------------------------
// Сборка
// ---------------------------------------------------------------------------

function buildColumns(source) {
    var at = indexer(source.fields);
    var order = [];
    var byProject = {};

    source.rows.forEach(function (row) {
        var project = row[at('Проект')];
        if (!byProject[project]) {
            byProject[project] = {
                project: project,
                block: row[at('Блок')],
                items: [], people: 0, fot: 0
            };
            order.push(project);
        }

        var counts = {};
        LEVELS.forEach(function (level) {
            counts[level.key] = Number(row[at(level.key)]) || 0;
        });

        var item = {
            product: row[at('Продукт кратко')],
            counts: counts,
            people: Number(row[at('людей')]) || 0,
            vacancies: Number(row[at('вакансий')]) || 0,
            fot: Number(row[at('ФОТ_мес')]) || 0,
            risk: String(row[at('риск')] || '')
        };

        byProject[project].items.push(item);
        byProject[project].people += item.people;
        byProject[project].fot += item.fot;
    });

    // Внутри колонки — крупные продукты сверху; сами колонки — по деньгам.
    order.forEach(function (project) {
        byProject[project].items.sort(function (a, b) {
            return b.people - a.people || b.fot - a.fot;
        });
    });

    return order
        .map(function (project) { return byProject[project]; })
        .sort(function (a, b) { return b.fot - a.fot; });
}

var source = readSource();

// DEBUG: раскомментируйте, если чарт пустой — увидите названия полей.
// module.exports = { title: { text: source.fields.join(' | ') } };

var columns = buildColumns(source);
var maxRows = columns.reduce(function (acc, column) {
    return Math.max(acc, column.items.length);
}, 0);

// Шапки колонок — такие же точки серии, только на строке y = -1. Через
// подписи оси их сделать не получается: HTML-подпись оси позиционируется
// по базовой линии текста, и карточка в 80 px наезжает на первый ряд.
var points = [];
columns.forEach(function (column, x) {
    points.push({ x: x, y: -1, label: columnHeader(column), name: column.project });
    column.items.forEach(function (item, y) {
        points.push({ x: x, y: y, label: card(item), name: item.product });
    });
});

var legend = LEVELS.map(function (level) {
    return '<span style="margin-right:14px;white-space:nowrap">' +
           '<i style="display:inline-block;width:11px;height:8px;border-radius:2px;' +
           'background:' + level.color + ';margin-right:4px"></i>' + level.label +
           '</span>';
}).join('');

// Ось Y размечена в слотах: одна единица — одна карточка. Высоту холста
// считаем от числа слотов, поэтому шаг между карточками всегда SLOT пикселей,
// сколько бы продуктов ни оказалось в самой длинной колонке.
var slots = maxRows + 1.1;          // +1 ряд под шапку колонки
var MARGIN_TOP = 30;                // полоса легенды
var MARGIN_BOTTOM = 10;

module.exports = {
    chart: {
        type: 'scatter',
        height: Math.round(slots * SLOT) + MARGIN_TOP + MARGIN_BOTTOM,
        backgroundColor: THEME.sunk,
        marginTop: MARGIN_TOP,
        marginBottom: MARGIN_BOTTOM,
        marginLeft: 12,
        marginRight: 12,
        spacing: [8, 12, 8, 12],
        scrollablePlotArea: {
            minWidth: Math.max(columns.length * COL_WIDTH + 24, 640),
            scrollPositionX: 0
        }
    },
    title: { text: null },
    subtitle: {
        useHTML: true,
        align: 'left',
        floating: true,
        x: 4,
        y: 16,
        text: '<div style="font-family:' + THEME.font + ';font-size:11px;color:' +
              THEME.inkFaint + '">' + legend + '</div>'
    },
    credits: { enabled: false },
    legend: { enabled: false },
    xAxis: {
        min: -0.5,
        max: columns.length - 0.5,
        tickInterval: 1,
        lineWidth: 0,
        tickLength: 0,
        gridLineWidth: 0,
        labels: { enabled: false }
    },
    yAxis: {
        reversed: true,
        min: -1.6,
        max: Math.max(maxRows - 0.5, 0.5),
        tickInterval: 1,
        title: { text: null },
        labels: { enabled: false },
        gridLineWidth: 0
    },
    tooltip: { enabled: false },
    plotOptions: {
        scatter: {
            marker: { enabled: false, states: { hover: { enabled: false } } },
            states: { inactive: { opacity: 1 } },
            dataLabels: {
                enabled: true,
                useHTML: true,
                allowOverlap: true,
                align: 'center',
                verticalAlign: 'middle',
                padding: 0,
                style: { textOutline: 'none', fontWeight: 'normal' },
                formatter: function () { return this.point.label; }
            }
        }
    },
    series: [{ name: 'Продукты', data: points, enableMouseTracking: false }]
};
