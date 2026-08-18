/**
 * DataLens · Advanced-чарт · вкладка Prepare
 * Дерево структуры: Ответственный за направление → Проект → Руководитель → Продукт
 *
 * Полная инструкция по вкладкам — 10-structure-tree-howto.md.
 * Здесь содержимое ТОЛЬКО вкладки Prepare. Для Meta, Params, Sources
 * и Controls есть отдельные файлы structure-tree.<вкладка>.js.
 *
 * Как устроено. Advanced-чарт исполняет функцию render в песочнице QuickJS
 * на стороне клиента: DOM там нет, браузерных API нет, доступны только
 * строки, Math и то, что передали аргументом. Поэтому разделение такое:
 *
 *   сервер (этот файл, вне wrapFn) — разбор данных, дерево, раскладка,
 *                                    подрезка подписей; на выходе scene —
 *                                    плоский список готовых примитивов;
 *   клиент (fn внутри wrapFn)      — сборка SVG-строки из scene.
 *
 * Функция fn не видит переменных этого файла: всё, что ей нужно, приходит
 * через args. Поэтому внутри неё нет ни одной внешней ссылки.
 *
 * ИСТОЧНИК — датасет «HR · Иерархия» (datalens_dataset_tree.csv).
 * Порядок колонок задаётся на вкладке Sources и продублирован в COLUMNS.
 */

// --------------------------------------------------------------------------
// Настройки
// --------------------------------------------------------------------------

var ROW    = 34;                       // высота строки листа, px
var COL_X  = [0, 214, 434, 648];       // отступ уровня от левого края, px
var NODE_W = [200, 206, 200, 396];     // ширина узла по уровням, px
var NODE_H = 30;                       // высота узла, px
var STRIP  = 5;                        // толщина полосы состава, px
var PAD_TOP = 34;                      // полоса легенды сверху, px

// Ширину текста считаем по числу символов: в песочнице измерить её нечем.
var META_CH  = 5.6;
var TITLE_CH = 6.4;

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
    warn: '#C79A4A', warnBg: '#F7EEDC',
    crit: '#A8382A', critBg: '#F6E3DF',
    white72: 'rgba(255,255,255,.72)',
    white60: 'rgba(255,255,255,.6)',
    font: "Golos Text, Helvetica Neue, Arial, sans-serif",
    mono: "JetBrains Mono, SFMono-Regular, Consolas, monospace"
};

// Порядок колонок ОБЯЗАН совпадать с массивом columns на вкладке Sources:
// имена полей в ответе датасета приходят в Type, но подстраховываемся этим
// списком, если структура ответа окажется другой.
var COLUMNS = [
    'Блок', 'Проект', 'Руководитель', 'Продукт кратко', 'риск',
    'R4', 'R3', 'R2', 'R1', 'R0', 'людей', 'вакансий', 'ФОТ_мес'
];

// --------------------------------------------------------------------------
// Чтение данных
// --------------------------------------------------------------------------

function readSource() {
    var loaded = Editor.getLoadedData();
    var key = Object.keys(loaded)[0];
    var result = loaded[key].result || loaded[key];
    var data = result.data || {};

    // Имена колонок в порядке ответа лежат в Type:
    //   ["ListType", ["StructType", [["Блок", ...], ["Проект", ...], ...]]]
    var names = COLUMNS;
    try {
        var struct = data.Type[1][1];
        if (struct && struct.length) {
            names = struct.map(function (item) { return item[0]; });
        }
    } catch (e) {
        // Структура ответа другая — работаем по объявленному порядку колонок.
    }

    return { fields: names, rows: data.Data || [] };
}

function indexer(fields) {
    return function (name) {
        var i = fields.indexOf(name);
        if (i < 0) {
            throw new Error('Нет колонки «' + name + '». Пришли: ' + fields.join(', '));
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

// ОТЛАДКА. Если чарт пустой, раскомментируйте — увидите имена колонок
// и число строк, которые реально пришли из датасета.
// module.exports = {
//     render: Editor.wrapFn({
//         fn: function (options, info) { return info; },
//         args: [source.fields.join(' | ') + ' — строк: ' + source.rows.length]
//     })
// };

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
        name: String(row[at('Продукт кратко')] || ''),
        counts: counts,
        people: Number(row[at('людей')]) || 0,
        vacancies: Number(row[at('вакансий')]) || 0,
        fot: Number(row[at('ФОТ_мес')]) || 0,
        risk: String(row[at('риск')] || ''),
        children: []
    };

    var block = childOf(root, String(row[at('Блок')] || '—'));
    var project = childOf(block, String(row[at('Проект')] || '—'));
    var chief = childOf(project, String(row[at('Руководитель')] || '—'));

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
// Сцена: плоский список примитивов для отрисовки
// --------------------------------------------------------------------------

var scene = {
    width: COL_X[3] + NODE_W[3] + 24,
    height: totalRows * ROW + PAD_TOP + 12,
    padTop: PAD_TOP,
    background: THEME.sunk,
    font: THEME.font,
    mono: THEME.mono,
    legend: LEVELS.map(function (level) {
        return { color: level.color, label: level.label };
    }),
    note: 'рамка продукта: красная — один человек, жёлтая — двое',
    noteCrit: THEME.crit,
    noteWarn: THEME.warn,
    noteColor: THEME.inkFaint,
    nodes: [],
    links: []
};

function pushNode(level, row, options) {
    var x = 12 + COL_X[level];
    var y = PAD_TOP + row * ROW + ROW / 2 - NODE_H / 2;
    var width = NODE_W[level];

    var badge = null;
    var strip = [];
    var total = LEVELS.reduce(function (sum, item) {
        return sum + options.counts[item.key];
    }, 0);

    if (total > 0) {
        badge = compose(options.counts);
        var badgeWidth = badge.length * META_CH + 8;
        var stripX = x + 9;
        var stripW = width - 18 - badgeWidth;
        LEVELS.forEach(function (item) {
            var n = options.counts[item.key];
            if (!n) { return; }
            var w = stripW * n / total;
            strip.push({
                x: stripX, w: Math.max(w - 1, 1), color: item.color
            });
            stripX += w;
        });
    }

    // Подрезаем название так, чтобы оно не наехало на числа справа.
    var metaWidth = options.meta ? options.meta.length * META_CH + 10 : 0;
    var maxChars = Math.floor((width - 18 - metaWidth) / TITLE_CH);
    var title = options.title.length > maxChars
        ? options.title.slice(0, Math.max(maxChars - 1, 3)) + '…'
        : options.title;

    var node = {
        x: x, y: y, w: width, h: NODE_H,
        fill: options.fill,
        stroke: options.stroke || 'none',
        sw: options.stroke ? 1.5 : 0,
        title: title,
        titleColor: options.color,
        titleSize: options.size || 11,
        titleWeight: options.weight || 600,
        meta: options.meta || '',
        metaColor: options.metaColor || THEME.inkFaint,
        badge: badge,
        badgeColor: options.badgeColor || THEME.inkFaint,
        stripY: y + NODE_H - STRIP - 5,
        stripH: STRIP,
        strip: strip
    };
    scene.nodes.push(node);
    return node;
}

function pushLink(from, to) {
    var x1 = from.x + from.w;
    var y1 = from.y + from.h / 2;
    var x2 = to.x;
    var y2 = to.y + to.h / 2;
    var mid = x1 + (x2 - x1) / 2;
    scene.links.push(
        'M' + x1 + ' ' + y1 + 'L' + mid + ' ' + y1 +
        'L' + mid + ' ' + y2 + 'L' + x2 + ' ' + y2
    );
}

function vacancyMark(count) {
    return count ? ' +' + count + ' вак' : '';
}

root.children.forEach(function (block) {
    var blockBox = pushNode(0, block.row, {
        counts: block.counts, fill: THEME.block, color: '#FFFFFF',
        title: block.name, size: 12, weight: 700,
        meta: block.people + ' чел',
        metaColor: THEME.white72, badgeColor: THEME.white60
    });

    block.children.forEach(function (project) {
        var projectBox = pushNode(1, project.row, {
            counts: project.counts, fill: THEME.project, color: '#FFFFFF',
            title: project.name, meta: project.people + ' чел',
            metaColor: THEME.white72, badgeColor: THEME.white60
        });
        pushLink(blockBox, projectBox);

        project.children.forEach(function (chief) {
            var chiefBox = pushNode(2, chief.row, {
                counts: chief.counts, fill: THEME.chief, stroke: THEME.chiefLine,
                color: THEME.ink, title: chief.name,
                meta: chief.people + ' чел'
            });
            pushLink(projectBox, chiefBox);

            chief.children.forEach(function (product) {
                var fill = THEME.card;
                var stroke = THEME.rule;
                var color = THEME.ink;
                if (product.risk.indexOf('Критично') === 0) {
                    fill = THEME.critBg; stroke = THEME.crit; color = THEME.crit;
                } else if (product.risk.indexOf('Риск') === 0) {
                    fill = THEME.warnBg; stroke = THEME.warn; color = THEME.inkSoft;
                }
                var productBox = pushNode(3, product.row, {
                    counts: product.counts, fill: fill, stroke: stroke,
                    color: color, title: product.name, weight: 500,
                    meta: product.people + ' чел' + vacancyMark(product.vacancies) +
                          ' · ' + money(product.fot) + ' ₽'
                });
                pushLink(chiefBox, productBox);
            });
        });
    });
});

scene.linkColor = THEME.link;

// --------------------------------------------------------------------------
// Отрисовка (клиент, песочница QuickJS)
// --------------------------------------------------------------------------

module.exports = {
    render: Editor.wrapFn({
        // options — размеры виджета от DataLens, дальше идут значения из args
        fn: function (options, scene) {
            function esc(value) {
                return String(value === null || value === undefined ? '' : value)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
            }

            var parts = [];

            parts.push(
                '<svg width="' + scene.width + '" height="' + scene.height + '" ' +
                'viewBox="0 0 ' + scene.width + ' ' + scene.height + '" ' +
                'xmlns="http://www.w3.org/2000/svg">'
            );

            // Легенда
            var lx = 12;
            scene.legend.forEach(function (item) {
                parts.push(
                    '<rect x="' + lx + '" y="10" width="11" height="6" rx="1" ' +
                    'fill="' + item.color + '"/>'
                );
                parts.push(
                    '<text x="' + (lx + 16) + '" y="16" font-family="' + scene.font +
                    '" font-size="11" fill="' + scene.noteColor + '">' +
                    esc(item.label) + '</text>'
                );
                lx += 22 + item.label.length * 6.2;
            });
            parts.push(
                '<text x="' + lx + '" y="16" font-family="' + scene.font +
                '" font-size="11" fill="' + scene.noteColor + '">' +
                esc(scene.note) + '</text>'
            );

            // Связи
            scene.links.forEach(function (d) {
                parts.push(
                    '<path d="' + d + '" fill="none" stroke="' + scene.linkColor +
                    '" stroke-width="1.2"/>'
                );
            });

            // Узлы
            scene.nodes.forEach(function (node) {
                parts.push(
                    '<rect x="' + node.x + '" y="' + node.y + '" width="' + node.w +
                    '" height="' + node.h + '" rx="4" fill="' + node.fill +
                    '" stroke="' + node.stroke + '" stroke-width="' + node.sw + '"/>'
                );

                parts.push(
                    '<text x="' + (node.x + 9) + '" y="' + (node.y + 13) +
                    '" font-family="' + scene.font + '" font-size="' + node.titleSize +
                    '" font-weight="' + node.titleWeight + '" fill="' + node.titleColor +
                    '">' + esc(node.title) + '</text>'
                );

                if (node.meta) {
                    parts.push(
                        '<text x="' + (node.x + node.w - 9) + '" y="' + (node.y + 13) +
                        '" text-anchor="end" font-family="' + scene.mono +
                        '" font-size="10" fill="' + node.metaColor + '">' +
                        esc(node.meta) + '</text>'
                    );
                }

                node.strip.forEach(function (segment) {
                    parts.push(
                        '<rect x="' + segment.x + '" y="' + node.stripY +
                        '" width="' + segment.w + '" height="' + node.stripH +
                        '" rx="1" fill="' + segment.color + '"/>'
                    );
                });

                if (node.badge) {
                    parts.push(
                        '<text x="' + (node.x + node.w - 9) + '" y="' +
                        (node.stripY + node.stripH) + '" text-anchor="end" ' +
                        'font-family="' + scene.mono + '" font-size="9" fill="' +
                        node.badgeColor + '">' + esc(node.badge) + '</text>'
                    );
                }
            });

            parts.push('</svg>');

            // Дерево выше и шире виджета — прокручиваем его внутри обёртки,
            // иначе DataLens просто обрежет полотно по размеру ячейки.
            return Editor.generateHtml(
                '<div style="width:' + options.width + 'px;height:' + options.height +
                'px;overflow:auto;background:' + scene.background + '">' +
                parts.join('') + '</div>'
            );
        },
        args: [scene]
    })
};
