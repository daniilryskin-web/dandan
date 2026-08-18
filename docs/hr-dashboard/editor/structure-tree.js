/**
 * DataLens · Расширенный чарт · вкладка 4 «Оргструктура»
 *
 * Дерево «Блок → Проект → Продукт»: узлы со связями, слева направо.
 * Толщина связи — численность ветки, цвет узла продукта — риск незаменимости.
 *
 * Зачем не штатный чарт: древовидная карта показывает вложенность площадью,
 * а не связями, и отношение «родитель — потомок» по ней не прочитать.
 * Здесь рисуется настоящий граф — то, что обычно и называют оргструктурой.
 *
 * ВАЖНО про дерево подчинённости. Это дерево СТРУКТУРЫ РАБОТ, а не людей.
 * Дерево «кто кому подчиняется» строится тем же кодом, но требует, чтобы
 * в исходнике появился столбец «ID руководителя» в той же нумерации, что и
 * «ФИО (штат)». Сейчас руководители записаны фамилиями, сотрудники —
 * идентификаторами, и рёбра между ними не смыкаются.
 *
 * Связи и узлы рисуются через chart.renderer — ядро Highcharts, никаких
 * дополнительных модулей.
 *
 * ИСТОЧНИК — датасет «HR · Иерархия» (datalens_dataset_tree.csv).
 *   Измерения:  Блок · Проект · Продукт кратко · риск
 *   Показатели: людей · ФОТ_мес
 *
 * Если чарт пустой — раскомментируйте строку DEBUG ниже.
 */

var ROW      = 30;    // высота строки листа, px
var COL_X    = [0, 250, 520];   // отступ уровня от левого края, px
var NODE_W   = [222, 240, 330]; // ширина узла по уровням, px
var NODE_H   = 26;

var THEME = {
    ink: '#141C2B', inkSoft: '#4A5568', inkFaint: '#7C8899',
    sunk: '#EDF0F3', card: '#FFFFFF',
    block: '#1F2E4D', project: '#35558A',
    link: '#B7C4D2',
    ok: '#DFE4EA', warn: '#C79A4A', crit: '#A8382A',
    warnBg: '#F7EEDC', critBg: '#F6E3DF',
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
    return ((Number(value) || 0) / 1e6).toFixed(2).replace('.', ',') + ' млн';
}

var source = readSource();

// DEBUG: раскомментируйте, если чарт пустой — увидите названия полей.
// module.exports = { title: { text: source.fields.join(' | ') } };

var at = indexer(source.fields);

// Собираем дерево. Узлы держим списками, а не словарями: порядок обхода
// должен совпадать с порядком строк на холсте.
var blocks = [];
var blockIndex = {};

source.rows.forEach(function (row) {
    var blockName = row[at('Блок')];
    var projectName = row[at('Проект')];
    if (!blockName || !projectName) { return; }

    if (blockIndex[blockName] === undefined) {
        blockIndex[blockName] = blocks.length;
        blocks.push({ name: blockName, projects: [], projectIndex: {}, people: 0, fot: 0 });
    }
    var block = blocks[blockIndex[blockName]];

    if (block.projectIndex[projectName] === undefined) {
        block.projectIndex[projectName] = block.projects.length;
        block.projects.push({ name: projectName, products: [], people: 0, fot: 0 });
    }
    var project = block.projects[block.projectIndex[projectName]];

    var product = {
        name: row[at('Продукт кратко')],
        people: Number(row[at('людей')]) || 0,
        fot: Number(row[at('ФОТ_мес')]) || 0,
        risk: String(row[at('риск')] || '')
    };
    project.products.push(product);
    project.people += product.people;
    project.fot += product.fot;
    block.people += product.people;
    block.fot += product.fot;
});

// Крупные ветки выше: дерево читают сверху вниз, и первым должно попасться
// то, где больше всего людей и денег.
blocks.sort(function (a, b) { return b.fot - a.fot; });
blocks.forEach(function (block) {
    block.projects.sort(function (a, b) { return b.fot - a.fot; });
    block.projects.forEach(function (project) {
        project.products.sort(function (a, b) { return b.people - a.people; });
    });
});

// Раскладка: листья занимают строки подряд, родитель встаёт по центру
// диапазона своих потомков.
var leafRow = 0;
blocks.forEach(function (block) {
    var blockFrom = leafRow;
    block.projects.forEach(function (project) {
        var projectFrom = leafRow;
        project.products.forEach(function (product) {
            product.row = leafRow;
            leafRow += 1;
        });
        project.row = (projectFrom + leafRow - 1) / 2;
    });
    block.row = (blockFrom + leafRow - 1) / 2;
});
var totalRows = leafRow;

function nodeBox(chart, level, row, options) {
    var x = chart.plotLeft + COL_X[level];
    var y = chart.plotTop + row * ROW + ROW / 2 - options.height / 2;
    var group = chart.renderer.g().add(chart.treeGroup);

    chart.renderer.rect(x, y, NODE_W[level], options.height, 4)
        .attr({
            fill: options.fill,
            stroke: options.stroke || 'none',
            'stroke-width': options.stroke ? 1.5 : 0
        })
        .add(group);

    // Ширину прикидываем по числу символов, а не через getBBox: в момент
    // события render элемент ещё не измеряется браузером и getBBox отдаёт
    // ноль — из-за этого длинные названия налезали на числа справа.
    var META_CH  = 5.6;   // ширина знака моноширинного 10 px
    var TITLE_CH = 6.0;   // средняя ширина знака Golos Text 11 px

    if (options.meta) {
        chart.renderer.text(options.meta, x + NODE_W[level] - 10, y + 16)
            .attr({ align: 'right' })
            .css({ color: options.metaColor || THEME.inkFaint, fontSize: '10px',
                   fontFamily: THEME.mono })
            .add(group);
    }

    var metaWidth = options.meta ? options.meta.length * META_CH + 10 : 0;
    var maxChars = Math.floor((NODE_W[level] - 20 - metaWidth) / TITLE_CH);
    var titleText = options.title.length > maxChars
        ? options.title.slice(0, Math.max(maxChars - 1, 3)) + '…'
        : options.title;

    chart.renderer.text(titleText, x + 10, y + 16)
        .css({
            color: options.color, fontSize: options.size || '11px',
            fontWeight: options.weight || '600', fontFamily: THEME.font
        })
        .add(group);

    return { x: x, y: y, width: NODE_W[level], height: options.height };
}

function elbow(chart, from, to) {
    var x1 = from.x + from.width;
    var y1 = from.y + from.height / 2;
    var x2 = to.x;
    var y2 = to.y + to.height / 2;
    var mid = x1 + (x2 - x1) / 2;
    chart.renderer
        .path(['M', x1, y1, 'L', mid, y1, 'L', mid, y2, 'L', x2, y2])
        .attr({ stroke: THEME.link, 'stroke-width': 1.2, fill: 'none' })
        .add(chart.treeGroup);
}

function drawTree() {
    var chart = this;
    if (chart.treeGroup) { chart.treeGroup.destroy(); }
    chart.treeGroup = chart.renderer.g('tree').attr({ zIndex: 2 }).add();

    blocks.forEach(function (block) {
        var blockBox = nodeBox(chart, 0, block.row, {
            height: NODE_H + 4, fill: THEME.block, color: '#FFFFFF',
            title: block.name, size: '12px', weight: '700',
            meta: block.people + ' чел · ' + millions(block.fot),
            metaColor: 'rgba(255,255,255,.75)'
        });

        block.projects.forEach(function (project) {
            var projectBox = nodeBox(chart, 1, project.row, {
                height: NODE_H, fill: THEME.project, color: '#FFFFFF',
                title: project.name,
                meta: project.people + ' чел',
                metaColor: 'rgba(255,255,255,.75)'
            });
            elbow(chart, blockBox, projectBox);

            project.products.forEach(function (product) {
                var fill = THEME.card;
                var stroke = THEME.ok;
                var color = THEME.ink;
                if (product.risk.indexOf('Критично') === 0) {
                    fill = THEME.critBg; stroke = THEME.crit; color = THEME.crit;
                } else if (product.risk.indexOf('Риск') === 0) {
                    fill = THEME.warnBg; stroke = THEME.warn; color = THEME.inkSoft;
                }
                var productBox = nodeBox(chart, 2, product.row, {
                    height: NODE_H - 2, fill: fill, stroke: stroke, color: color,
                    title: product.name, weight: '500',
                    meta: product.people + ' чел · ' + money(product.fot) + ' ₽'
                });
                elbow(chart, projectBox, productBox);
            });
        });
    });
}

module.exports = {
    chart: {
        type: 'scatter',
        height: totalRows * ROW + 56,
        backgroundColor: THEME.sunk,
        marginTop: 34, marginBottom: 12, marginLeft: 12, marginRight: 12,
        scrollablePlotArea: {
            minWidth: COL_X[2] + NODE_W[2] + 40,
            scrollPositionX: 0
        },
        events: { render: drawTree }
    },
    title: { text: null },
    subtitle: {
        useHTML: true, align: 'left', floating: true, x: 4, y: 16,
        text: '<div style="font-family:' + THEME.font + ';font-size:11px;color:' +
              THEME.inkFaint + '">Структура работ · рамка продукта: ' +
              '<span style="color:' + THEME.crit + '">красная — один человек</span>, ' +
              '<span style="color:' + THEME.warn + '">жёлтая — двое</span></div>'
    },
    credits: { enabled: false },
    legend: { enabled: false },
    xAxis: { min: 0, max: 1, lineWidth: 0, tickLength: 0, gridLineWidth: 0,
             labels: { enabled: false } },
    yAxis: { min: 0, max: 1, title: { text: null }, gridLineWidth: 0,
             labels: { enabled: false } },
    tooltip: { enabled: false },
    plotOptions: { scatter: { marker: { enabled: false } } },
    series: [{ name: 'Структура', data: [], enableMouseTracking: false }]
};
