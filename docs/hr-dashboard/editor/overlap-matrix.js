/**
 * DataLens · Расширенный чарт · вкладка 3 «Загрузка и пересечения»
 *
 * Матрица пересечений проектов: сколько людей работает одновременно
 * в каждой паре направлений. По диагонали — численность самого проекта.
 *
 * Зачем не штатный чарт: пересечение — это связь между двумя значениями
 * одного и того же измерения. Сводная таблица так не умеет: положить
 * «Проект» и в строки, и в столбцы можно, но в ячейке окажется пересечение
 * строки с самой собой, то есть диагональ и пустота вокруг. Здесь пары
 * считаются в коде по списку «сотрудник — проект».
 *
 * ИСТОЧНИК — основная таблица, без агрегации.
 *   Фильтр:    [Вакансия] = 0
 *   Измерения: Сотрудник · Проект
 *
 * Если чарт пустой — раскомментируйте строку DEBUG ниже.
 */

var CELL      = 44;    // сторона ячейки, px
var LABEL_W   = 190;   // место под названия проектов слева, px
var LABEL_TOP = 150;   // место под названия сверху, px

var THEME = {
    ink: '#141C2B', inkSoft: '#4A5568', inkFaint: '#7C8899',
    plot: '#FFFFFF', sunk: '#EDF0F3', grid: '#E4E9EE',
    diag: '#E7EBF0',                       // диагональ — не пересечение
    ramp: ['#DCE6F0', '#B4CBE2', '#7FA5CC', '#4C7CAF', '#27548C'],
    font: "'Golos Text', 'Helvetica Neue', Arial, sans-serif"
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

var source = readSource();

// DEBUG: раскомментируйте, если чарт пустой — увидите названия полей.
// module.exports = { title: { text: source.fields.join(' | ') } };

var at = indexer(source.fields);
var projectsOf = {};      // сотрудник → список проектов
var projectSize = {};     // проект → сколько человек

source.rows.forEach(function (row) {
    var person = row[at('Сотрудник')];
    var project = row[at('Проект')];
    if (!person || !project) { return; }
    if (!projectsOf[person]) { projectsOf[person] = []; }
    if (projectsOf[person].indexOf(project) < 0) {
        projectsOf[person].push(project);
        projectSize[project] = (projectSize[project] || 0) + 1;
    }
});

var projects = Object.keys(projectSize).sort(function (a, b) {
    return projectSize[b] - projectSize[a] || a.localeCompare(b);
});
var index = {};
projects.forEach(function (name, i) { index[name] = i; });

// Матрица пар. Каждого человека раскладываем по всем сочетаниям его проектов.
var matrix = projects.map(function () {
    return projects.map(function () { return 0; });
});
Object.keys(projectsOf).forEach(function (person) {
    var list = projectsOf[person];
    for (var i = 0; i < list.length; i++) {
        for (var j = i + 1; j < list.length; j++) {
            var a = index[list[i]];
            var b = index[list[j]];
            matrix[a][b] += 1;
            matrix[b][a] += 1;
        }
    }
});

var maxOverlap = 0;
matrix.forEach(function (row, i) {
    row.forEach(function (value, j) {
        if (i !== j && value > maxOverlap) { maxOverlap = value; }
    });
});

function rampColor(value) {
    if (!value) { return null; }
    var step = Math.min(
        THEME.ramp.length - 1,
        Math.floor((value - 1) / Math.max(maxOverlap, 1) * THEME.ramp.length)
    );
    return THEME.ramp[step];
}

var cells = [];
projects.forEach(function (rowName, i) {
    projects.forEach(function (colName, j) {
        if (i === j) {
            cells.push({
                x: j, y: i, value: projectSize[rowName], self: true,
                rowName: rowName, colName: colName
            });
        } else if (matrix[i][j] > 0) {
            cells.push({
                x: j, y: i, value: matrix[i][j], self: false,
                rowName: rowName, colName: colName
            });
        }
    });
});

var shared = Object.keys(projectsOf).filter(function (person) {
    return projectsOf[person].length > 1;
}).length;

// Деления перечисляем явно: при min/max в -0.5 и n-0.5 Highcharts дорисовывает
// подписи «-1» и «n» — значения, которым не соответствует ни один проект.
var ticks = projects.map(function (_, i) { return i; });

function drawGrid() {
    var chart = this;
    var xAxis = chart.xAxis[0];
    var yAxis = chart.yAxis[0];

    if (chart.cellGroup) { chart.cellGroup.destroy(); }
    chart.cellGroup = chart.renderer.g('cells').attr({ zIndex: 2 }).add();

    var size = Math.min(
        xAxis.toPixels(1) - xAxis.toPixels(0),
        Math.abs(yAxis.toPixels(1) - yAxis.toPixels(0))
    ) - 3;

    cells.forEach(function (cell) {
        var cx = xAxis.toPixels(cell.x);
        var cy = yAxis.toPixels(cell.y);
        var fill = cell.self ? THEME.diag : rampColor(cell.value);
        if (!fill) { return; }

        chart.renderer.rect(cx - size / 2, cy - size / 2, size, size, 3)
            .attr({ fill: fill })
            .add(chart.cellGroup);

        // Порог светлоты подобран по шкале: на двух верхних ступенях
        // тёмный текст уже не читается.
        var dark = !cell.self && THEME.ramp.indexOf(fill) >= 3;
        chart.renderer.text(String(cell.value), cx, cy + 4)
            .attr({ align: 'center' })
            .css({
                color: cell.self ? THEME.inkFaint : (dark ? '#FFFFFF' : THEME.ink),
                fontSize: '11px',
                fontWeight: cell.self ? '400' : '600',
                fontFamily: THEME.font
            })
            .add(chart.cellGroup);
    });
}

module.exports = {
    chart: {
        type: 'scatter',
        height: projects.length * CELL + LABEL_TOP + 40,
        backgroundColor: THEME.sunk,
        plotBackgroundColor: THEME.plot,
        marginLeft: LABEL_W,
        marginTop: LABEL_TOP,
        marginRight: 24,
        marginBottom: 40,
        scrollablePlotArea: {
            minWidth: projects.length * CELL + LABEL_W + 40,
            scrollPositionX: 0
        },
        events: { render: drawGrid }
    },
    title: { text: null },
    subtitle: {
        useHTML: true, align: 'left', floating: true, x: 4, y: 14,
        text: '<div style="font-family:' + THEME.font + ';font-size:11px;color:' +
              THEME.inkFaint + '">Число людей, работающих в обоих направлениях · ' +
              'по диагонали — численность направления · ' + shared +
              ' человек заняты более чем в одном</div>'
    },
    credits: { enabled: false },
    legend: { enabled: false },
    xAxis: {
        // startOnTick/endOnTick по умолчанию включены: Highcharts расширяет
        // min/max до целых делений, и шаг слота становится меньше заданного
        // (в первой сборке 190 px превращались в 143). Отключаем.
        startOnTick: false, endOnTick: false,
        categories: projects,
        min: -0.5, max: projects.length - 0.5, tickPositions: ticks,
        opposite: true,
        lineWidth: 0, tickLength: 0, gridLineWidth: 0,
        labels: {
            rotation: -55, align: 'left', y: -8,
            style: { fontFamily: THEME.font, fontSize: '10px', color: THEME.inkSoft }
        }
    },
    yAxis: {
        startOnTick: false, endOnTick: false,
        categories: projects,
        reversed: true,
        min: -0.5, max: projects.length - 0.5, tickPositions: ticks,
        title: { text: null }, gridLineWidth: 0,
        labels: {
            style: { fontFamily: THEME.font, fontSize: '11px', color: THEME.ink }
        }
    },
    tooltip: { enabled: false },
    plotOptions: { scatter: { marker: { enabled: false }, states: { inactive: { opacity: 1 } } } },
    series: [{ name: 'Пересечения', data: [], enableMouseTracking: false }]
};
