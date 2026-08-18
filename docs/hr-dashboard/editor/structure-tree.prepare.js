/**
 * DataLens · Advanced-чарт · вкладка Prepare
 * Дерево структуры: Ответственный за направление → Проект → Руководитель → Продукт
 *
 * Полная инструкция по вкладкам — 10-structure-tree-howto.md.
 * Здесь содержимое ТОЛЬКО вкладки Prepare.
 *
 * Как устроено. Advanced-чарт исполняет функцию render в песочнице QuickJS
 * на стороне клиента: DOM там нет, браузерных API нет, доступны только
 * строки, Math и то, что передали аргументом. Поэтому разделение такое:
 *
 *   сервер (весь код вне wrapFn) — разбор ответа, дерево, раскладка,
 *                                  подрезка подписей; на выходе scene —
 *                                  плоский список готовых примитивов;
 *   клиент (fn внутри wrapFn)    — сборка SVG-строки из scene.
 *
 * Функция fn не видит переменных этого файла: всё приходит через args.
 *
 * ЕСЛИ ДАННЫЕ НЕ ПРИШЛИ, чарт не молчит: вместо дерева он рисует отчёт
 * о том, что именно вернул источник — какие ключи, какие поля, сколько
 * строк. Раньше в этом случае отрисовывалась одна легенда, и понять
 * причину было невозможно.
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
    font: 'Golos Text, Helvetica Neue, Arial, sans-serif',
    mono: 'JetBrains Mono, SFMono-Regular, Consolas, monospace'
};

// Порядок колонок должен совпадать со списком полей на вкладке Sources.
// Используется как запасной вариант, если имена не удалось взять из ответа.
var COLUMNS = [
    'Блок', 'Проект', 'Руководитель', 'Продукт кратко', 'риск',
    'R4', 'R3', 'R2', 'R1', 'R0', 'людей', 'вакансий', 'ФОТ_мес'
];

// --------------------------------------------------------------------------
// Разбор ответа источника
// --------------------------------------------------------------------------

/**
 * Форматы ответа между версиями DataLens отличаются, поэтому пробуем
 * все известные и записываем в журнал, какой сработал. Журнал попадает
 * в отчёт, если данных не окажется.
 */
function readSource(log) {
    var loaded;
    try {
        loaded = Editor.getLoadedData();
    } catch (e) {
        log.push('Editor.getLoadedData() бросил ошибку: ' + e.message);
        return { fields: COLUMNS, rows: [] };
    }

    var keys = Object.keys(loaded || {});
    log.push('Ключи источников: ' + (keys.length ? keys.join(', ') : '(пусто)'));
    if (!keys.length) {
        log.push('Источник не вернул ничего. Проверьте вкладки Meta и Sources.');
        return { fields: COLUMNS, rows: [] };
    }

    var src = loaded[keys[0]] || {};
    log.push('Ключи внутри «' + keys[0] + '»: ' + Object.keys(src).join(', '));

    var result = src.result || src;
    var data = result.data || {};
    var rows = [];
    var names = null;

    // 1. Документированный формат: result.data.Data + result.data.Type
    if (data.Data && data.Data.length) {
        rows = data.Data;
        log.push('Формат: result.data.Data, строк — ' + rows.length);
        try {
            names = data.Type[1][1].map(function (item) { return item[0]; });
        } catch (e) {
            log.push('Имена колонок из Type взять не удалось');
        }
    }

    // 2. Старый формат: result_data[0].rows = [{values: [...]}, ...]
    if (!rows.length && src.result_data && src.result_data[0]) {
        var raw = src.result_data[0].rows || [];
        rows = raw.map(function (r) { return r.values || r; });
        if (rows.length) { log.push('Формат: result_data[0].rows, строк — ' + rows.length); }
    }

    // 3. Плоский массив строк
    if (!rows.length && src.rows && src.rows.length) {
        rows = src.rows.map(function (r) { return r.values || r; });
        log.push('Формат: rows, строк — ' + rows.length);
    }

    // Имена колонок: из Type, иначе из описания полей, иначе объявленный порядок
    if (!names) {
        var fields = result.fields || src.fields;
        if (fields && fields.length) {
            names = fields.map(function (f) { return f.title || f.guid; });
            log.push('Имена колонок взяты из fields');
        }
    }
    if (!names) {
        names = COLUMNS;
        log.push('Имена колонок не найдены, используется порядок из COLUMNS');
    }

    if (!rows.length) {
        log.push('Ни один известный формат ответа не дал строк.');
        log.push('Колонки: ' + names.join(' · '));
        return { fields: names, rows: rows };
    }

    // Приводим строки к массивам значений. Известные виды строки:
    //   [значение, ...]                     — массив
    //   {values: [...]}                     — старый формат
    //   {data: [...], legend: [...]}        — текущий формат DataLens:
    //                                         значения в data, а legend —
    //                                         служебные id, не колонки
    //   {Блок: '...', Проект: '...'}        — объект с ключами-названиями
    //
    // Именно из-за формата с data вся строка раньше принималась за две
    // колонки «data» и «legend», и ни одно поле не находилось.
    var first = rows[0];
    if (Array.isArray(first)) {
        log.push('Строка — массив из ' + first.length + ' значений');
    } else if (first && Array.isArray(first.values)) {
        rows = rows.map(function (r) { return r.values; });
        log.push('Строка — объект values, значений: ' + rows[0].length);
    } else if (first && Array.isArray(first.data)) {
        rows = rows.map(function (r) { return r.data; });
        log.push('Строка — объект data + legend, значений: ' + rows[0].length);
    } else if (first && typeof first === 'object') {
        // Ключи объекта и есть настоящие названия колонок.
        var keys = Object.keys(first);
        names = keys;
        rows = rows.map(function (r) {
            return keys.map(function (k) { return r[k]; });
        });
        log.push('Строка — объект с ключами, значений: ' + keys.length);
    } else {
        log.push('Строка неизвестного вида: ' + (typeof first));
    }

    // Сверяем число колонок с числом значений. fields в ответе может
    // описывать весь датасет, а не только запрошенные поля, — тогда имена
    // не совпадут со значениями по позиции, и надёжнее взять порядок,
    // объявленный на вкладке Sources.
    var width = (rows[0] || []).length;
    if (names.length !== width) {
        log.push('Имён колонок ' + names.length + ', а значений в строке ' +
                 width + ' — беру порядок из COLUMNS');
        names = COLUMNS.slice(0, width);
    }

    log.push('Колонки: ' + names.join(' · '));
    log.push('Первая строка: ' + (rows[0] || []).map(function (v) {
        return v === null || v === undefined ? '(пусто)' : String(v);
    }).join(' · '));

    return { fields: names, rows: rows };
}

function indexer(fields) {
    return function (name) {
        var i = fields.indexOf(name);
        if (i < 0) {
            throw new Error(
                'В ответе нет колонки «' + name + '». Пришли: ' + fields.join(' · ') +
                '. Проверьте, что названия полей на вкладке Sources совпадают ' +
                'с названиями в датасете побуквенно, включая регистр.'
            );
        }
        return i;
    };
}

// --------------------------------------------------------------------------
// Вспомогательное
// --------------------------------------------------------------------------

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

function vacancyMark(count) {
    return count ? ' +' + count + ' вак' : '';
}

// --------------------------------------------------------------------------
// Дерево и сцена
// --------------------------------------------------------------------------

function buildScene(source) {
    var at = indexer(source.fields);

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

        // Состав ветки — сумма составов её продуктов: у направления сразу
        // видно, на ком оно держится, без разворачивания.
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

    var scene = {
        width: COL_X[3] + NODE_W[3] + 24,
        height: leafRow * ROW + PAD_TOP + 12,
        background: THEME.sunk,
        font: THEME.font,
        mono: THEME.mono,
        linkColor: THEME.link,
        noteColor: THEME.inkFaint,
        note: 'рамка продукта: красная — один человек, жёлтая — двое',
        legend: LEVELS.map(function (level) {
            return { color: level.color, label: level.label };
        }),
        nodes: [],
        links: [],
        blocks: root.children.length,
        people: root.children.reduce(function (sum, b) { return sum + b.people; }, 0)
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
                strip.push({ x: stripX, w: Math.max(w - 1, 1), color: item.color });
                stripX += w;
            });
        }

        // Подрезаем название, чтобы оно не наехало на числа справа.
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
                    counts: chief.counts, fill: THEME.chief,
                    stroke: THEME.chiefLine, color: THEME.ink,
                    title: chief.name, meta: chief.people + ' чел'
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

    return scene;
}

// --------------------------------------------------------------------------
// Сборка
// --------------------------------------------------------------------------

var log = [];
var source = readSource(log);
var scene = null;
var failure = null;

if (source.rows.length) {
    try {
        scene = buildScene(source);
        log.push('Построено узлов: ' + scene.nodes.length +
                 ', направлений: ' + scene.blocks +
                 ', людей суммарно: ' + scene.people);

        if (!scene.nodes.length) {
            failure = 'Строки пришли, но ни одного узла не построилось.';
        } else if (scene.blocks === 1 && source.rows.length > 5 && !scene.people) {
            // Ровно этот случай выглядел как «дерево нарисовалось, но пустое»:
            // значения из строк не читались, всё схлопывалось в одну ветку.
            failure = 'Строки пришли, но значения в них не читаются: ' +
                      'всё схлопнулось в одну ветку, людей — ноль. ' +
                      'Скорее всего названия колонок в ответе отличаются ' +
                      'от ожидаемых — сверьте список ниже.';
        }
    } catch (e) {
        failure = e.message;
    }
    if (failure) { scene = null; }
} else {
    failure = 'Источник не вернул ни одной строки.';
}

var report = {
    title: failure || '',
    lines: log,
    hint: [
        'Проверьте по порядку:',
        '1. Meta — id датасета скопирован целиком и без пробелов.',
        '2. Sources — названия полей совпадают с датасетом побуквенно, ' +
            'включая регистр: «людей», «вакансий», «риск» со строчной буквы, ' +
            '«ФОТ_мес» с подчёркиванием.',
        '3. Датасет открывается и показывает 57 строк.',
        '4. Кнопка «Выполнить» нажата после правки вкладок.'
    ],
    background: THEME.sunk,
    font: THEME.font,
    mono: THEME.mono,
    ink: THEME.ink,
    inkSoft: THEME.inkSoft,
    crit: THEME.crit,
    card: THEME.card,
    rule: THEME.rule
};

module.exports = {
    render: Editor.wrapFn({
        // options — размеры виджета от DataLens, дальше значения из args
        fn: function (options, scene, report) {
            function esc(value) {
                return String(value === null || value === undefined ? '' : value)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
            }

            // ---- отчёт вместо дерева, когда данных нет --------------------
            if (!scene) {
                var rows = report.lines.map(function (line) {
                    return '<div style="margin:2px 0">' + esc(line) + '</div>';
                }).join('');
                var hints = report.hint.map(function (line) {
                    return '<div style="margin:3px 0">' + esc(line) + '</div>';
                }).join('');

                return Editor.generateHtml(
                    '<div style="width:' + options.width + 'px;height:' +
                    options.height + 'px;overflow:auto;background:' +
                    report.background + ';padding:16px;box-sizing:border-box;' +
                    'font-family:' + report.font + '">' +
                      '<div style="background:' + report.card + ';border:1px solid ' +
                      report.rule + ';border-radius:6px;padding:14px 16px;max-width:820px">' +
                        '<div style="font-size:14px;font-weight:700;color:' +
                        report.crit + ';margin-bottom:8px">Дерево не построено</div>' +
                        '<div style="font-size:12px;color:' + report.ink +
                        ';margin-bottom:12px">' + esc(report.title) + '</div>' +
                        '<div style="font-family:' + report.mono +
                        ';font-size:11px;color:' + report.inkSoft +
                        ';border-top:1px solid ' + report.rule +
                        ';padding-top:10px;margin-bottom:12px">' + rows + '</div>' +
                        '<div style="font-size:12px;color:' + report.ink + '">' +
                        hints + '</div>' +
                      '</div>' +
                    '</div>'
                );
            }

            // ---- дерево ---------------------------------------------------
            var parts = [];

            parts.push(
                '<svg width="' + scene.width + '" height="' + scene.height + '" ' +
                'viewBox="0 0 ' + scene.width + ' ' + scene.height + '" ' +
                'xmlns="http://www.w3.org/2000/svg">'
            );

            var lx = 12;
            scene.legend.forEach(function (item) {
                parts.push(
                    '<rect x="' + lx + '" y="10" width="11" height="6" rx="1" fill="' +
                    item.color + '"/>'
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

            scene.links.forEach(function (d) {
                parts.push(
                    '<path d="' + d + '" fill="none" stroke="' + scene.linkColor +
                    '" stroke-width="1.2"/>'
                );
            });

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

            // Дерево выше и шире виджета — прокручиваем внутри обёртки,
            // иначе DataLens обрежет полотно по размеру ячейки.
            return Editor.generateHtml(
                '<div style="width:' + options.width + 'px;height:' + options.height +
                'px;overflow:auto;background:' + scene.background + '">' +
                parts.join('') + '</div>'
            );
        },
        args: [scene, report]
    })
};
