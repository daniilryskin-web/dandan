/**
 * DataLens · Расширенный чарт · вкладка 0 «Обзор»
 *
 * Скоркарта направлений: плитка на проект, в каждой — деньги, численность,
 * полоса оценки зарплат и предупреждения (вакансии, хрупкие продукты,
 * стоимость выравнивания).
 *
 * Зачем не штатный чарт: в одной плитке уживаются метрики разной природы —
 * рубли, доли, счётчики и текстовые предупреждения. Сводная таблица покажет
 * те же числа, но состояние направления по ней не читается взглядом.
 *
 * ИСТОЧНИК — датасет основной таблицы, агрегированный до проекта.
 *   Измерения:  Блок · Проект
 *   Показатели: Сотрудников          COUNTD([Сотрудник])
 *               ФОТ                  SUM([ФОТ аллоцированный])
 *               Недоплата            COUNTD(IF([Группа оценки]='Недоплата',[Сотрудник],NULL))
 *               Соответствует        COUNTD(IF([Группа оценки]='Соответствует роли',[Сотрудник],NULL))
 *               Переплата            COUNTD(IF([Группа оценки]='Переплата',[Сотрудник],NULL))
 *               Вакансий             SUM([Вакансия])
 *               Хрупких продуктов    COUNTD(IF([Людей на продукте]<=2,[Продукт ключ],NULL))
 *               Доплата              SUM([Доплата до порога])
 *
 * Если чарт пустой — раскомментируйте строку DEBUG ниже.
 */

var TILE_W  = 268;   // ширина плитки, px
var TILE_H  = 190;   // шаг по вертикали, px
                     // (плитка с тремя предупреждениями — самая высокая)
var COLUMNS = 4;     // плиток в ряду

var THEME = {
    ink: '#141C2B', inkSoft: '#4A5568', inkFaint: '#7C8899',
    card: '#FFFFFF', rule: '#DFE4EA', sunk: '#EDF0F3',
    under: '#2C7BB6',      // недоплата — холодный
    match: '#A7B2BF',      // соответствует — нейтральный
    over:  '#D7791F',      // переплата — тёплый
    alarm: '#A8382A', amber: '#A9631F',
    font: "'Golos Text', 'Helvetica Neue', Arial, sans-serif",
    mono: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace"
};

function readSource() {
    var loaded = Editor.getLoadedData();
    var src = loaded[Object.keys(loaded)[0]];
    return {
        fields: (src.fields || []).map(function (f) {
            return f.title || f.legend_item_id || f.guid;
        }),
        rows: (src.result_data[0].rows || []).map(function (r) { return r.values; })
    };
}

function indexer(fields) {
    return function (name) {
        var i = fields.indexOf(name);
        if (i < 0) {
            throw new Error('Нет поля «' + name + '». Пришли: ' + fields.join(', '));
        }
        return i;
    };
}

function money(value) {
    return String(Math.round(Number(value) || 0))
        .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function millions(value) {
    var n = Number(value) || 0;
    return (n / 1e6).toFixed(2).replace('.', ',') + ' млн ₽';
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Полоса оценки: три сегмента, ширина пропорциональна числу людей.
function ratingBar(item) {
    var total = item.under + item.match + item.over;
    if (!total) { return ''; }
    var parts = [
        { n: item.under, color: THEME.under },
        { n: item.match, color: THEME.match },
        { n: item.over,  color: THEME.over }
    ].filter(function (p) { return p.n > 0; })
     .map(function (p) {
        return '<i style="display:block;flex:' + p.n + ';background:' + p.color + '"></i>';
     }).join('');

    var share = Math.round((item.under + item.over) / total * 100);
    return '' +
      '<div style="display:flex;height:9px;gap:1px;border-radius:2px;overflow:hidden;' +
        'margin:8px 0 5px">' + parts + '</div>' +
      '<div style="font-family:' + THEME.mono + ';font-size:10px;color:' + THEME.inkFaint + '">' +
        '<span style="color:' + THEME.under + '">' + item.under + '</span> · ' +
        item.match + ' · ' +
        '<span style="color:' + THEME.over + '">' + item.over + '</span>' +
        '<span style="float:right">отклонений ' + share + '%</span>' +
      '</div>';
}

// Предупреждения показываем только когда есть о чём: пустые чипы создают
// впечатление, что направление проверено и с ним всё в порядке.
function warnings(item) {
    var chips = [];
    if (item.fragile) {
        chips.push('<span style="color:' + THEME.alarm + '">▲ ' + item.fragile +
                   ' прод. на 1–2 людях</span>');
    }
    if (item.vacancies) {
        chips.push('<span style="color:' + THEME.amber + '">+' + item.vacancies +
                   ' вакансий</span>');
    }
    if (item.topup) {
        chips.push('<span style="color:' + THEME.inkSoft + '">доплата ' +
                   money(item.topup) + ' ₽</span>');
    }
    if (!chips.length) { return ''; }
    return '<div style="font-family:' + THEME.mono + ';font-size:10px;line-height:1.55;' +
           'margin-top:6px;border-top:1px solid ' + THEME.rule + ';padding-top:5px">' +
           chips.join('<br>') + '</div>';
}

function tile(item) {
    return '' +
    '<div style="width:' + TILE_W + 'px;box-sizing:border-box;background:' + THEME.card +
        ';border:1px solid ' + THEME.rule + ';border-radius:6px;padding:10px 11px;' +
        'font-family:' + THEME.font + ';text-align:left;white-space:normal;line-height:1.3">' +
      '<div style="font-size:9px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;' +
        'color:' + THEME.inkFaint + '">' + escapeHtml(item.block) + '</div>' +
      '<div style="font-size:14px;font-weight:700;color:' + THEME.ink + ';margin-top:2px">' +
        escapeHtml(item.project) + '</div>' +
      '<div style="font-family:' + THEME.mono + ';font-size:11px;color:' + THEME.inkSoft +
        ';margin-top:4px">' + millions(item.fot) + ' · ' + item.people + ' чел</div>' +
      ratingBar(item) +
      warnings(item) +
    '</div>';
}

var source = readSource();

// DEBUG: раскомментируйте, если чарт пустой — увидите названия полей.
// module.exports = { title: { text: source.fields.join(' | ') } };

var at = indexer(source.fields);
var items = source.rows.map(function (row) {
    return {
        block: row[at('Блок')],
        project: row[at('Проект')],
        people: Number(row[at('Сотрудников')]) || 0,
        fot: Number(row[at('ФОТ')]) || 0,
        under: Number(row[at('Недоплата')]) || 0,
        match: Number(row[at('Соответствует')]) || 0,
        over: Number(row[at('Переплата')]) || 0,
        vacancies: Number(row[at('Вакансий')]) || 0,
        fragile: Number(row[at('Хрупких продуктов')]) || 0,
        topup: Number(row[at('Доплата')]) || 0
    };
}).sort(function (a, b) { return b.fot - a.fot; });

var points = items.map(function (item, i) {
    return { x: i % COLUMNS, y: Math.floor(i / COLUMNS), label: tile(item), name: item.project };
});
var rows = Math.ceil(items.length / COLUMNS);

var legend =
    '<span style="margin-right:14px"><i style="display:inline-block;width:11px;height:8px;' +
      'border-radius:2px;background:' + THEME.under + ';margin-right:4px"></i>недоплата</span>' +
    '<span style="margin-right:14px"><i style="display:inline-block;width:11px;height:8px;' +
      'border-radius:2px;background:' + THEME.match + ';margin-right:4px"></i>соответствует роли</span>' +
    '<span><i style="display:inline-block;width:11px;height:8px;border-radius:2px;background:' +
      THEME.over + ';margin-right:4px"></i>переплата</span>';

module.exports = {
    chart: {
        type: 'scatter',
        height: rows * TILE_H + 44,
        backgroundColor: THEME.sunk,
        marginTop: 34, marginBottom: 8, marginLeft: 10, marginRight: 10,
        scrollablePlotArea: { minWidth: COLUMNS * TILE_W + 20, scrollPositionX: 0 }
    },
    title: { text: null },
    subtitle: {
        useHTML: true, align: 'left', floating: true, x: 4, y: 16,
        text: '<div style="font-family:' + THEME.font + ';font-size:11px;color:' +
              THEME.inkFaint + '">' + legend + '</div>'
    },
    credits: { enabled: false },
    legend: { enabled: false },
    xAxis: {
        // startOnTick/endOnTick по умолчанию включены: Highcharts расширяет
        // min/max до целых делений, и шаг слота становится меньше заданного
        // (в первой сборке 190 px превращались в 143). Отключаем.
        startOnTick: false, endOnTick: false,
        min: -0.5, max: COLUMNS - 0.5, tickInterval: 1,
        lineWidth: 0, tickLength: 0, gridLineWidth: 0, labels: { enabled: false }
    },
    yAxis: {
        startOnTick: false, endOnTick: false,
        reversed: true, min: -0.5, max: Math.max(rows - 0.5, 0.5), tickInterval: 1,
        title: { text: null }, labels: { enabled: false }, gridLineWidth: 0
    },
    tooltip: { enabled: false },
    plotOptions: {
        scatter: {
            marker: { enabled: false },
            states: { inactive: { opacity: 1 } },
            dataLabels: {
                enabled: true, useHTML: true, allowOverlap: true,
                // Выравниваем по верхнему краю слота, а не по центру: плитки
                // разной высоты, и центрированная высокая наезжает на соседа
                // сверху.
                align: 'center', verticalAlign: 'top', y: -TILE_H / 2 + 6,
                padding: 0,
                style: { textOutline: 'none', fontWeight: 'normal' },
                formatter: function () { return this.point.label; }
            }
        }
    },
    series: [{ name: 'Направления', data: points, enableMouseTracking: false }]
};
