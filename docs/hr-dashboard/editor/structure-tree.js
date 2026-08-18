/**
 * DataLens · Расширенный чарт · дерево структуры
 *
 * Четыре уровня со связями, слева направо:
 *
 *     Ответственный за направление → Проект → Руководитель → Продукт
 *
 * На каждом узле — состав команды по уровням ролей: полоса R4…R0 и те же
 * пять чисел, что стоят в бейджах drawio-схемы. У продукта состав свой,
 * у руководителя, проекта и направления — сумма по ветке.
 *
 * Почему руководитель — полноценный уровень, а не подпись: по данным каждый
 * из 18 руководителей относится ровно к одному направлению и одному проекту,
 * а у продукта руководитель один (кроме единственного продукта на двоих —
 * он честно попадает в обе ветки).
 *
 * ВАЖНО. Это дерево структуры работ. Дерево «кто кому подчиняется» строится
 * тем же кодом, но требует, чтобы в исходнике появился столбец «ID
 * руководителя» в той же нумерации, что и «ФИО (штат)»: сейчас руководители
 * записаны фамилиями, сотрудники — идентификаторами, и рёбра не смыкаются.
 *
 * Узлы и связи рисуются через chart.renderer — ядро Highcharts, никаких
 * дополнительных модулей.
 *
 * ИСТОЧНИК — датасет «HR · Иерархия» (datalens_dataset_tree.csv).
 *   Измерения:  Блок · Проект · Руководитель · Продукт кратко · риск
 *   Показатели: R4 · R3 · R2 · R1 · R0 · людей · вакансий · ФОТ_мес
 *
 * Если чарт пустой — раскомментируйте строку DEBUG ниже.
 */

// --------------------------------------------------------------------------
// Оформление
// --------------------------------------------------------------------------

var ROW    = 34;                       // высота строки листа, px
var COL_X  = [0, 214, 434, 648];       // отступ уровня от левого края, px
var NODE_W = [200, 206, 200, 396];     // ширина узла по уровням, px
var NODE_H = 30;                       // высота узла, px
var STRIP  = 5;                        // толщина полосы состава, px

// Высота видимой области на дашборде. Полное дерево из 57 строк — около
// 2000 px, и виджет обычной высоты его обрежет. Если полотно выше этого
// значения, чарт остаётся заданной высоты, а дерево прокручивается внутри
// него. Поставьте 0, чтобы всегда рисовать целиком (для выгрузки в PDF).
var VIEW_HEIGHT = 720;

// Порядковая шкала ролей: один тон, разная светлота. Нижнюю ступень не
// доводим до почти-белого — иначе сегмент стажёров читается как пустое место.
var LEVELS = [
    { key: 'R4', color: '#1F2E4D', label: 'R4 руководство' },
    { key: 'R3', color: '#35558A', label: 'R3 ведение продукта' },
    { key: 'R2', color: '#5B83B4', label: 'R2 администрирование' },
    { key: 'R1', color: '#8AAAD0', label: 'R1 исполнение' },
    { key: 'R0', color: '#B9CEE6', label: 'R0 стажировка' }
];

var THEME = {
    ink: '#141C2B', inkSoft: '#4A5568', inkFaint: '#7C8899',
    sunk: '#EDF0F3', card: '#FFFFFF',
    block: '#16233A', project: '#2C4670',
    chief: '#EDF1F6', chiefLine: '#9FB3CA',
    link: '#B7C4D2', rule: '#DFE4EA',
    amber: '#A9631F',
    warn: '#C79A4A', warnBg: '#F7EEDC',
    crit: '#A8382A', critBg: '#F6E3DF',
    font: "'Golos Text', 'Helvetica Neue', Arial, sans-serif",
    mono: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace"
};

// --------------------------------------------------------------------------
// Чтение данных
// --------------------------------------------------------------------------

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

function emptyCounts() {
    var counts = {};
    LEVELS.forEach(function (level) { counts[level.key] = 0; });
    return counts;
}

function addCounts(target, source) {
    LEVELS.forEach(function (level) { target[level.key] += source[level.key]; });
}

// Тот же вид, что в бейджах drawio: пять чисел от старших ролей к младшим.
function compose(counts) {
    return LEVELS.map(function (level) { return counts[level.key]; }).join('-');
}

var source = readSource();

// DEBUG: раскомментируйте, если чарт пустой — увидите названия полей.
// module.exports = { title: { text: source.fields.join(' | ') } };

var at = indexer(source.fields);

// --------------------------------------------------------------------------
// Дерево
// --------------------------------------------------------------------------

function makeNode(name) {
    return {
        name: name, children: [], childIndex: {},
        counts: emptyCounts(), people: 0, vacancies: 0, fot: 0
    };
}

function childOf(parent, name) {
    if (parent.childIndex[name] === undefined) {
        parent.childIndex[name] = parent.children.length;
        parent.children.push(makeNode(name));
    }
    return parent.children[parent.childIndex[name]];
}

var root = makeNode('');

source.rows.forEach(function (row) {
    var counts = emptyCounts();
    LEVELS.forEach(function (level) {
        counts[level.key] = Number(row[at(level.key)]) || 0;
    });

    var product = {
        name: row[at('Продукт кратко')],
        counts: counts,
        people: Number(row[at('людей')]) || 0,
        vacancies: Number(row[at('вакансий')]) || 0,
        fot: Number(row[at('ФОТ_мес')]) || 0,
        risk: String(row[at('риск')] || ''),
        children: []
    };

    var block = childOf(root, row[at('Блок')]);
    var project = childOf(block, row[at('Проект')]);
    var chief = childOf(project, row[at('Руководитель')] || '—');

    chief.children.push(product);

    // Состав ветки — сумма составов её продуктов: у направления сразу видно,
    // на ком оно держится, без разворачивания.
    [chief, project, block].forEach(function (node) {
        addCounts(node.counts, counts);
        node.people += product.people;
        node.vacancies += product.vacancies;
        node.fot += product.fot;
    });
});

// Крупные ветки выше: дерево читают сверху вниз.
function sortBranch(node, depth) {
    node.children.sort(function (a, b) {
        return depth === 2 ? (b.people - a.people) : (b.fot - a.fot);
    });
    if (depth < 2) {
        node.children.forEach(function (child) { sortBranch(child, depth + 1); });
    }
}
sortBranch(root, 0);

// Раскладка: листья занимают строки подряд, родитель встаёт по центру
// диапазона своих потомков.
var leafRow = 0;
root.children.forEach(function (block) {
    var blockFrom = leafRow;
    block.children.forEach(function (project) {
        var projectFrom = leafRow;
        project.children.forEach(function (chief) {
            var chiefFrom = leafRow;
            chief.children.forEach(function (product) {
                product.row = leafRow;
                leafRow += 1;
            });
            chief.row = (chiefFrom + leafRow - 1) / 2;
        });
        project.row = (projectFrom + leafRow - 1) / 2;
    });
    block.row = (blockFrom + leafRow - 1) / 2;
});
var totalRows = leafRow;

// --------------------------------------------------------------------------
// Отрисовка
// --------------------------------------------------------------------------

// Ширину текста прикидываем по числу символов: в обработчике render элемент
// ещё не измерен браузером, и getBBox() отдаёт ноль.
var META_CH  = 5.6;
var TITLE_CH = 6.4;   // с запасом: при 6.0 «Недвижимость и имущество»
                      // на пиксель налезала на счётчик справа

function nodeBox(chart, level, row, options) {
    var x = chart.plotLeft + COL_X[level];
    var y = chart.plotTop + row * ROW + ROW / 2 - NODE_H / 2;
    var width = NODE_W[level];
    var group = chart.renderer.g().add(chart.treeGroup);

    chart.renderer.rect(x, y, width, NODE_H, 4)
        .attr({
            fill: options.fill,
            stroke: options.stroke || 'none',
            'stroke-width': options.stroke ? 1.5 : 0
        })
        .add(group);

    if (options.meta) {
        chart.renderer.text(options.meta, x + width - 9, y + 13)
            .attr({ align: 'right' })
            .css({ color: options.metaColor || THEME.inkFaint, fontSize: '10px',
                   fontFamily: THEME.mono })
            .add(group);
    }

    var metaWidth = options.meta ? options.meta.length * META_CH + 10 : 0;
    var maxChars = Math.floor((width - 18 - metaWidth) / TITLE_CH);
    var title = options.title.length > maxChars
        ? options.title.slice(0, Math.max(maxChars - 1, 3)) + '…'
        : options.title;

    chart.renderer.text(title, x + 9, y + 13)
        .css({
            color: options.color, fontSize: options.size || '11px',
            fontWeight: options.weight || '600', fontFamily: THEME.font
        })
        .add(group);

    // Полоса состава по нижней кромке узла — визуальный аналог бейджа
    // «4-3-2-3-0» из drawio-схемы, и рядом сам бейдж.
    var total = LEVELS.reduce(function (sum, item) {
        return sum + options.counts[item.key];
    }, 0);
    if (total <= 0) { return { x: x, y: y, width: width, height: NODE_H }; }

    var badge = compose(options.counts);
    var badgeWidth = badge.length * META_CH + 8;
    var stripY = y + NODE_H - STRIP - 5;
    var stripX = x + 9;
    var stripW = width - 18 - badgeWidth;

    LEVELS.forEach(function (item) {
        var n = options.counts[item.key];
        if (!n) { return; }
        var w = stripW * n / total;
        chart.renderer.rect(stripX, stripY, Math.max(w - 1, 1), STRIP, 1)
            .attr({ fill: item.color })
            .add(group);
        stripX += w;
    });

    chart.renderer.text(badge, x + width - 9, stripY + STRIP)
        .attr({ align: 'right' })
        .css({ color: options.badgeColor || THEME.inkFaint,
               fontSize: '9px', fontFamily: THEME.mono })
        .add(group);

    return { x: x, y: y, width: width, height: NODE_H };
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

function vacancyMark(count) {
    return count ? ' +' + count + ' вак' : '';
}

function drawTree() {
    var chart = this;
    if (chart.treeGroup) { chart.treeGroup.destroy(); }
    chart.treeGroup = chart.renderer.g('tree').attr({ zIndex: 2 }).add();

    root.children.forEach(function (block) {
        var blockBox = nodeBox(chart, 0, block.row, {
            counts: block.counts, fill: THEME.block, color: '#FFFFFF',
            title: block.name, size: '12px', weight: '700',
            meta: block.people + ' чел',
            metaColor: 'rgba(255,255,255,.72)',
            badgeColor: 'rgba(255,255,255,.6)'
        });

        block.children.forEach(function (project) {
            var projectBox = nodeBox(chart, 1, project.row, {
                counts: project.counts, fill: THEME.project, color: '#FFFFFF',
                title: project.name,
                meta: project.people + ' чел',
                metaColor: 'rgba(255,255,255,.72)',
                badgeColor: 'rgba(255,255,255,.6)'
            });
            elbow(chart, blockBox, projectBox);

            project.children.forEach(function (chief) {
                var chiefBox = nodeBox(chart, 2, chief.row, {
                    counts: chief.counts, fill: THEME.chief, stroke: THEME.chiefLine,
                    color: THEME.ink, title: chief.name, weight: '600',
                    meta: chief.people + ' чел'
                });
                elbow(chart, projectBox, chiefBox);

                chief.children.forEach(function (product) {
                    var fill = THEME.card;
                    var stroke = THEME.rule;
                    var color = THEME.ink;
                    if (product.risk.indexOf('Критично') === 0) {
                        fill = THEME.critBg; stroke = THEME.crit; color = THEME.crit;
                    } else if (product.risk.indexOf('Риск') === 0) {
                        fill = THEME.warnBg; stroke = THEME.warn; color = THEME.inkSoft;
                    }
                    var productBox = nodeBox(chart, 3, product.row, {
                        counts: product.counts, fill: fill, stroke: stroke,
                        color: color, title: product.name, weight: '500',
                        meta: product.people + ' чел' + vacancyMark(product.vacancies) +
                              ' · ' + money(product.fot) + ' ₽'
                    });
                    elbow(chart, chiefBox, productBox);
                });
            });
        });
    });
}

var legend = LEVELS.map(function (item) {
    return '<span style="margin-right:12px;white-space:nowrap">' +
        '<i style="display:inline-block;width:11px;height:6px;border-radius:1px;' +
        'background:' + item.color + ';margin-right:4px"></i>' + item.label +
        '</span>';
}).join('');

var fullHeight = totalRows * ROW + 62;
var viewHeight = (VIEW_HEIGHT && fullHeight > VIEW_HEIGHT) ? VIEW_HEIGHT : fullHeight;

module.exports = {
    chart: {
        type: 'scatter',
        height: viewHeight,
        backgroundColor: THEME.sunk,
        marginTop: 40, marginBottom: 12, marginLeft: 12, marginRight: 12,
        scrollablePlotArea: {
            minWidth: COL_X[3] + NODE_W[3] + 40,
            minHeight: fullHeight,
            scrollPositionX: 0,
            scrollPositionY: 0,
            opacity: 1
        },
        events: { render: drawTree }
    },
    title: { text: null },
    subtitle: {
        useHTML: true, align: 'left', floating: true, x: 4, y: 14,
        text: '<div style="font-family:' + THEME.font + ';font-size:11px;color:' +
              THEME.inkFaint + ';line-height:1.6">' + legend +
              '<span>рамка продукта: <b style="color:' + THEME.crit +
              '">красная — один человек</b>, <b style="color:' + THEME.warn +
              '">жёлтая — двое</b></span></div>'
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
