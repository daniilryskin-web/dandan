/**
 * DataLens · Расширенный чарт · вкладка 2 «Люди и зарплаты»
 *
 * Разброс зарплат по проектным ролям: ящик с усами плюс точки людей.
 *
 * Зачем не штатный чарт: в DataLens нет типа «ящик с усами», а именно он
 * отвечает на главный вопрос вкладки — «эта зарплата вообще типична для
 * роли?». Раньше вместо него собирался чарт из пяти отдельных серий по
 * заранее посчитанным квартилям; здесь квартили считаются на лету, точки
 * людей лежат на той же шкале, а выбросы видно без сверки с таблицей.
 *
 * Коробка рисуется через chart.renderer — это ядро Highcharts, модуль
 * highcharts-more не нужен и его наличие в вашей инсталляции роли не играет.
 *
 * ИСТОЧНИК — основная таблица, одна строка на человека.
 *   Фильтр:     [В анализе справедливости] = 1
 *   Измерения:  Проектная роль · Уровень роли № · Сотрудник · Группа оценки
 *   Показатель: ЗП
 *
 * Если чарт пустой — раскомментируйте строку DEBUG ниже.
 */

var JITTER   = 0.26;   // разброс точек по горизонтали, доли шага роли
var BOX_HALF = 0.19;   // полуширина коробки, доли шага роли

var THEME = {
    ink: '#141C2B', inkSoft: '#4A5568', inkFaint: '#7C8899',
    plot: '#FFFFFF', sunk: '#EDF0F3', grid: '#E4E9EE',
    box: '#C9D6E4', boxLine: '#4A6B94', median: '#1F2E4D',
    under: '#2C7BB6', match: '#A7B2BF', over: '#D7791F',
    font: "'Golos Text', 'Helvetica Neue', Arial, sans-serif"
};

var GROUP_COLOR = {
    'Недоплата': THEME.under,
    'Соответствует роли': THEME.match,
    'Переплата': THEME.over
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

// Квартиль с линейной интерполяцией — тот же метод, что КВАРТИЛЬ.ВКЛ в Excel
// и quantile() в скрипте подготовки. Другие методы дадут другие числа, и
// чарт разойдётся с листом «Роли».
function quantile(sorted, p) {
    if (!sorted.length) { return null; }
    var pos = (sorted.length - 1) * p;
    var base = Math.floor(pos);
    var rest = pos - base;
    if (sorted[base + 1] === undefined) { return sorted[base]; }
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

var source = readSource();

// DEBUG: раскомментируйте, если чарт пустой — увидите названия полей.
// module.exports = { title: { text: source.fields.join(' | ') } };

var at = indexer(source.fields);
var byRole = {};
var order = [];

source.rows.forEach(function (row) {
    var role = row[at('Проектная роль')];
    var salary = Number(row[at('ЗП')]);
    if (!role || !isFinite(salary)) { return; }
    if (!byRole[role]) {
        byRole[role] = {
            role: role,
            level: Number(row[at('Уровень роли №')]) || 0,
            salaries: [],
            people: []
        };
        order.push(role);
    }
    byRole[role].salaries.push(salary);
    byRole[role].people.push({
        salary: salary,
        group: row[at('Группа оценки')],
        name: row[at('Сотрудник')]
    });
});

// Роли слева направо по старшинству: шкала уровней порядковая, и любой
// другой порядок (алфавит, размер группы) ломает чтение чарта.
var roles = order.map(function (name) { return byRole[name]; })
    .sort(function (a, b) { return a.level - b.level || a.role.localeCompare(b.role); });

roles.forEach(function (item) {
    var sorted = item.salaries.slice().sort(function (a, b) { return a - b; });
    item.sorted = sorted;
    item.q1 = quantile(sorted, 0.25);
    item.median = quantile(sorted, 0.5);
    item.q3 = quantile(sorted, 0.75);
    var iqr = item.q3 - item.q1;
    item.flat = iqr <= 0;               // плоский тариф: правило IQR неприменимо
    var lowFence = item.q1 - 1.5 * iqr;
    var highFence = item.q3 + 1.5 * iqr;
    // Усы тянем до крайних значений внутри забора, а не до самого забора —
    // иначе ус висит там, где никто не получает.
    item.low = sorted.filter(function (v) { return v >= lowFence; })[0];
    var inside = sorted.filter(function (v) { return v <= highFence; });
    item.high = inside[inside.length - 1];
    if (item.low === undefined) { item.low = sorted[0]; }
    if (item.high === undefined) { item.high = sorted[sorted.length - 1]; }
});

// Точки людей раскидываем по горизонтали детерминированно: случайный джиттер
// прыгал бы при каждой перерисовке, и одну и ту же зарплату было бы не найти.
var dots = [];
roles.forEach(function (item, x) {
    var n = item.people.length;
    item.people.forEach(function (person, i) {
        var offset = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2 * JITTER;
        dots.push({
            x: x + offset,
            y: person.salary,
            color: GROUP_COLOR[person.group] || THEME.inkFaint,
            role: item.role,
            person: person.name,
            group: person.group
        });
    });
});

function drawBoxes() {
    var chart = this;
    var xAxis = chart.xAxis[0];
    var yAxis = chart.yAxis[0];

    if (chart.boxGroup) { chart.boxGroup.destroy(); }
    chart.boxGroup = chart.renderer.g('boxes').attr({ zIndex: 2 }).add();

    roles.forEach(function (item, x) {
        var left = xAxis.toPixels(x - BOX_HALF);
        var right = xAxis.toPixels(x + BOX_HALF);
        var mid = xAxis.toPixels(x);
        var width = right - left;

        var yLow = yAxis.toPixels(item.low);
        var yHigh = yAxis.toPixels(item.high);
        var yQ1 = yAxis.toPixels(item.q1);
        var yQ3 = yAxis.toPixels(item.q3);
        var yMed = yAxis.toPixels(item.median);

        if (!item.flat) {
            // Ус: вертикаль от нижнего края до верхнего плюс засечки
            chart.renderer.path(['M', mid, yLow, 'L', mid, yHigh])
                .attr({ stroke: THEME.boxLine, 'stroke-width': 1 })
                .add(chart.boxGroup);
            [yLow, yHigh].forEach(function (y) {
                chart.renderer.path(['M', mid - width / 4, y, 'L', mid + width / 4, y])
                    .attr({ stroke: THEME.boxLine, 'stroke-width': 1 })
                    .add(chart.boxGroup);
            });
            chart.renderer.rect(left, yQ3, width, yQ1 - yQ3, 2)
                .attr({ fill: THEME.box, stroke: THEME.boxLine, 'stroke-width': 1, opacity: 0.85 })
                .add(chart.boxGroup);
        }

        chart.renderer.path(['M', left, yMed, 'L', right, yMed])
            .attr({ stroke: THEME.median, 'stroke-width': 2.5 })
            .add(chart.boxGroup);

        // Плашкой, а не голым текстом: медиана приходится на самое плотное
        // место облака точек, и без подложки число не читается.
        var label = chart.renderer
            .label(money(item.median) + ' \u20BD', 0, 0, null, null, null, false, false)
            .attr({ fill: 'rgba(255,255,255,.95)', stroke: THEME.grid,
                    'stroke-width': 1, padding: 3, r: 2, zIndex: 4 })
            .css({ color: THEME.ink, fontSize: '10px', fontFamily: THEME.font,
                   fontWeight: '600' })
            .add(chart.boxGroup);
        // Ставим над верхней гранью коробки, а не над медианой: у кучных
        // ролей медиана приходится ровно на центр облака точек.
        label.attr({ x: mid - label.getBBox().width / 2,
                     y: Math.min(yQ3, yMed) - 20 });
    });
}

module.exports = {
    chart: {
        type: 'scatter',
        height: 520,
        backgroundColor: THEME.sunk,
        plotBackgroundColor: THEME.plot,
        spacing: [16, 16, 8, 8],
        marginBottom: 88,
        // Название роли в две строки требует ~150 px на роль. Если чарт стоит
        // в узкой ячейке дашборда, DataLens включит горизонтальную прокрутку
        // вместо того, чтобы обрезать подписи многоточием.
        scrollablePlotArea: { minWidth: roles.length * 150 + 96, scrollPositionX: 0 },
        events: { render: drawBoxes }
    },
    title: { text: null },
    credits: { enabled: false },
    legend: {
        enabled: true, align: 'right', verticalAlign: 'top', floating: true,
        y: -6, itemStyle: { fontFamily: THEME.font, fontSize: '11px', fontWeight: '400' }
    },
    xAxis: {
        // Без этого Highcharts расширяет диапазон до целых делений и рисует
        // по краям лишние подписи «-1» и «8».
        startOnTick: false, endOnTick: false,
        min: -0.6, max: roles.length - 0.4, tickInterval: 1,
        categories: roles.map(function (item) { return item.role; }),
        lineColor: THEME.grid, tickLength: 0, gridLineWidth: 0,
        labels: {
            useHTML: true, y: 20,
            // style.width здесь НЕ ставим: с ним Highcharts включает
            // собственное обрезание многоточием поверх HTML. Ширину и перенос
            // задаёт только внутренний div.
            formatter: function () {
                var item = roles[this.pos];
                if (!item) { return ''; }
                return '<div style="text-align:center;font-family:' + THEME.font +
                    ';width:134px;line-height:1.25;white-space:normal">' +
                    '<div style="font-size:11px;color:' + THEME.ink + '">' +
                    item.role + '</div>' +
                    '<div style="font-size:10px;color:' + THEME.inkFaint + '">' +
                    item.people.length + ' чел' +
                    (item.flat ? ' · плоский тариф' : '') + '</div></div>';
            }
        }
    },
    yAxis: {
        title: { text: null },
        gridLineColor: THEME.grid,
        labels: {
            style: { fontFamily: THEME.font, fontSize: '10px', color: THEME.inkFaint },
            formatter: function () { return money(this.value); }
        }
    },
    tooltip: {
        useHTML: true,
        formatter: function () {
            return '<span style="font-family:' + THEME.font + ';font-size:11px">' +
                   '<b>' + this.point.person + '</b><br>' + this.point.role + '<br>' +
                   money(this.y) + ' ₽ · ' + this.point.group + '</span>';
        }
    },
    plotOptions: {
        scatter: {
            marker: { radius: 4, symbol: 'circle', lineWidth: 1, lineColor: '#FFFFFF' },
            states: { inactive: { opacity: 1 } }
        }
    },
    series: [
        { name: 'Сотрудники', data: dots, showInLegend: false, zIndex: 3 },
        { name: 'недоплата', color: THEME.under, data: [], marker: { symbol: 'circle' } },
        { name: 'соответствует роли', color: THEME.match, data: [], marker: { symbol: 'circle' } },
        { name: 'переплата', color: THEME.over, data: [], marker: { symbol: 'circle' } }
    ]
};
