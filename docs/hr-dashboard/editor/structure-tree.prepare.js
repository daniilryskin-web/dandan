/**
 * DataLens · Advanced-чарт · вкладка Prepare
 * Дерево структуры: Ответственный за направление → Проект → Руководитель → Продукт
 *
 * Полная инструкция по вкладкам — 10-structure-tree-howto.md.
 *
 * Как устроено. Advanced-чарт исполняет функцию render в песочнице QuickJS
 * на стороне клиента: DOM там нет, браузерных API нет, доступны только
 * строки, Math и то, что передали аргументом. Поэтому разделение такое:
 *
 *   сервер (весь код вне wrapFn) — разбор ответа, фильтрация по параметрам,
 *                                  дерево, порядок строк; на выходе scene —
 *                                  узлы с номером уровня и номером строки;
 *   клиент (fn внутри wrapFn)    — пересчёт в пиксели под фактическую ширину
 *                                  виджета и сборка SVG-строки.
 *
 * Ширина колонок задана долями, а не пикселями: сетка растягивается на всю
 * ширину виджета, сколько бы её ни было. Пиксельные координаты считаются
 * на клиенте, потому что только там известен размер.
 *
 * ФИЛЬТРЫ. Четыре параметра — block, project, chief, product — приходят
 * из селекторов дашборда и отсекают строки до построения дерева. Пустой
 * параметр означает «все». Значения параметров всегда массивы строк.
 *
 * ЕСЛИ ДАННЫЕ НЕ ПРИШЛИ, вместо дерева рисуется отчёт: что вернул источник,
 * как устроена строка, какие колонки и что в них лежит.
 */

// --------------------------------------------------------------------------
// Настройки
// --------------------------------------------------------------------------

var ROW      = 34;    // высота строки листа, px
var NODE_H   = 30;    // высота узла, px
var STRIP    = 5;     // толщина полосы состава, px
var PAD_TOP  = 34;    // полоса легенды сверху, px
var PAD_SIDE = 12;    // поля слева и справа, px
var GAP      = 16;    // зазор между колонками, px

// Доли ширины по уровням. Сумма должна равняться 1: остаток ширины
// раздаётся пропорционально, поэтому дерево заполняет виджет целиком.
var COL_RATIO = [0.20, 0.21, 0.20, 0.39];

// Ниже этой ширины сетка не сжимается — включается горизонтальная прокрутка,
// иначе на узком виджете названия превращаются в многоточия.
var MIN_WIDTH = 900;

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
var COLUMNS = [
    'Блок', 'Проект', 'Руководитель', 'Продукт кратко', 'риск',
    'R4', 'R3', 'R2', 'R1', 'R0', 'людей', 'вакансий', 'ФОТ_мес'
];

// Параметр селектора → колонка, по которой он фильтрует.
//
// Имён у каждого фильтра несколько: DataLens подставляет в параметры то
// латинское имя, что объявлено на вкладке Params, то название поля датасета —
// зависит от того, как настроен селектор (на основе датасета или ручным
// вводом) и от версии. Принимаем оба варианта, чтобы селектор заработал
// при любой настройке.
var FILTERS = [
    { keys: ['block',   'Блок'],           column: 'Блок',           label: 'направление' },
    { keys: ['project', 'Проект'],         column: 'Проект',         label: 'проект' },
    { keys: ['chief',   'Руководитель'],   column: 'Руководитель',   label: 'руководитель' },
    { keys: ['product', 'Продукт кратко'], column: 'Продукт кратко', label: 'продукт' }
];

// --------------------------------------------------------------------------
// Разбор ответа источника
// --------------------------------------------------------------------------

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

    if (data.Data && data.Data.length) {
        rows = data.Data;
        log.push('Формат: result.data.Data, строк — ' + rows.length);
        try {
            names = data.Type[1][1].map(function (item) { return item[0]; });
        } catch (e) {
            log.push('Имена колонок из Type взять не удалось');
        }
    }

    if (!rows.length && src.result_data && src.result_data[0]) {
        rows = src.result_data[0].rows || [];
        if (rows.length) {
            log.push('Формат: result_data[0].rows, строк — ' + rows.length);
        }
    }

    if (!rows.length && src.rows && src.rows.length) {
        rows = src.rows;
        log.push('Формат: rows, строк — ' + rows.length);
    }

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

    // Известные виды строки:
    //   [значение, ...]                — массив
    //   {values: [...]}                — старый формат
    //   {data: [...], legend: [...]}   — текущий формат DataLens: значения
    //                                    в data, legend — служебные id
    //   {Блок: '…', Проект: '…'}       — объект с ключами-названиями
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
        var keys2 = Object.keys(first);
        names = keys2;
        rows = rows.map(function (r) {
            return keys2.map(function (k) { return r[k]; });
        });
        log.push('Строка — объект с ключами, значений: ' + keys2.length);
    } else {
        log.push('Строка неизвестного вида: ' + (typeof first));
    }

    // fields в ответе может описывать весь датасет, а не только запрошенные
    // поля — тогда имена не совпадут со значениями по позиции.
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
// Фильтры селекторов
// --------------------------------------------------------------------------

// Значения параметров — всегда массивы строк. Пустая строка, «null» и
// служебное «_ALL_» означают «все»: селектор в таком состоянии не должен
// отсекать ничего.
//
// Селектор передаёт значение с префиксом операции: «__in_Транспорт» при
// множественном выборе, «__eq_Транспорт» при выборе одного значения.
// Без снятия префикса ни одно значение не совпало бы с данными.
function asList(value) {
    if (value === undefined || value === null) { return []; }
    var list = Array.isArray(value) ? value : [value];
    var out = [];
    list.forEach(function (item) {
        var text = String(item === null || item === undefined ? '' : item).trim();
        text = text.replace(/^__[a-z]+_/, '');
        if (text && text !== 'null' && text !== 'undefined' && text !== '_ALL_') {
            out.push(text);
        }
    });
    return out;
}

function applyFilters(source, log) {
    var params;
    try {
        params = Editor.getParams() || {};
    } catch (e) {
        log.push('Editor.getParams() недоступен, фильтры пропущены');
        return { rows: source.rows, active: [], unknown: [] };
    }

    var at = indexer(source.fields);
    var rows = source.rows;
    var active = [];
    var used = {};

    FILTERS.forEach(function (filter) {
        var values = [];
        filter.keys.forEach(function (key) {
            if (params[key] === undefined) { return; }
            used[key] = true;
            asList(params[key]).forEach(function (v) {
                if (values.indexOf(v) < 0) { values.push(v); }
            });
        });
        if (!values.length) { return; }

        var column = at(filter.column);
        rows = rows.filter(function (row) {
            return values.indexOf(String(row[column])) >= 0;
        });
        active.push(filter.label + ': ' + values.join(', '));
        log.push('Фильтр ' + filter.keys[0] + ' → ' + values.join(', ') +
                 ', осталось строк: ' + rows.length);
    });

    // Параметр пришёл, но ни под один фильтр не подошёл — почти всегда это
    // опечатка в имени. Молчать нельзя: чарт нарисуется целиком, и человек
    // решит, что селектор просто не работает.
    var unknown = [];
    Object.keys(params).forEach(function (key) {
        if (used[key]) { return; }
        if (!asList(params[key]).length) { return; }
        unknown.push(key);
    });
    if (unknown.length) {
        log.push('Параметры без фильтра: ' + unknown.join(', '));
    }

    return { rows: rows, active: active, unknown: unknown };
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

function segments(counts) {
    var out = [];
    LEVELS.forEach(function (level) {
        var n = counts[level.key];
        if (n) { out.push({ n: n, color: level.color }); }
    });
    return out;
}

function vacancyMark(count) {
    return count ? ' +' + count + ' вак' : '';
}

// --------------------------------------------------------------------------
// Дерево и сцена
// --------------------------------------------------------------------------

function buildScene(fields, rows, active, unknown) {
    var at = indexer(fields);

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

    rows.forEach(function (row) {
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

    // Раскладка по строкам: листья идут подряд, родитель встаёт по центру
    // диапазона своих потомков. В пиксели это переводится уже на клиенте.
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
        rows: leafRow,
        height: leafRow * ROW + PAD_TOP + 12,
        rowH: ROW, nodeH: NODE_H, stripH: STRIP,
        padTop: PAD_TOP, padSide: PAD_SIDE, gap: GAP,
        ratio: COL_RATIO, minWidth: MIN_WIDTH,
        metaCh: META_CH, titleCh: TITLE_CH,
        background: THEME.sunk,
        font: THEME.font,
        mono: THEME.mono,
        linkColor: THEME.link,
        noteColor: THEME.inkFaint,
        note: 'рамка продукта: красная — один человек, жёлтая — двое',
        filters: active,
        unknown: unknown || [],
        legend: LEVELS.map(function (level) {
            return { color: level.color, label: level.label };
        }),
        nodes: [],
        links: [],
        blocks: root.children.length,
        people: root.children.reduce(function (sum, b) { return sum + b.people; }, 0)
    };

    function pushNode(level, row, options) {
        var node = {
            level: level, row: row,
            fill: options.fill,
            stroke: options.stroke || 'none',
            sw: options.stroke ? 1.5 : 0,
            title: options.title,
            titleColor: options.color,
            titleSize: options.size || 11,
            titleWeight: options.weight || 600,
            meta: options.meta || '',
            metaColor: options.metaColor || THEME.inkFaint,
            badge: compose(options.counts),
            badgeColor: options.badgeColor || THEME.inkFaint,
            strip: segments(options.counts)
        };
        scene.nodes.push(node);
        return node;
    }

    function pushLink(from, to) {
        scene.links.push({
            fromLevel: from.level, fromRow: from.row,
            toLevel: to.level, toRow: to.row
        });
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
        var filtered = applyFilters(source, log);
        if (!filtered.rows.length) {
            failure = 'Под выбранные фильтры не попало ни одной строки. ' +
                      'Снимите часть значений в селекторах.';
        } else {
            scene = buildScene(source.fields, filtered.rows,
                               filtered.active, filtered.unknown);
            log.push('Построено узлов: ' + scene.nodes.length +
                     ', направлений: ' + scene.blocks +
                     ', людей суммарно: ' + scene.people);

            if (!scene.nodes.length) {
                failure = 'Строки пришли, но ни одного узла не построилось.';
            } else if (scene.blocks === 1 && filtered.rows.length > 5 && !scene.people) {
                failure = 'Строки пришли, но значения в них не читаются: ' +
                          'всё схлопнулось в одну ветку, людей — ноль. ' +
                          'Скорее всего названия колонок в ответе отличаются ' +
                          'от ожидаемых — сверьте список ниже.';
            }
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
    background: THEME.sunk, font: THEME.font, mono: THEME.mono,
    ink: THEME.ink, inkSoft: THEME.inkSoft, crit: THEME.crit,
    card: THEME.card, rule: THEME.rule
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
                var lines = report.lines.map(function (line) {
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
                        ';padding-top:10px;margin-bottom:12px">' + lines + '</div>' +
                        '<div style="font-size:12px;color:' + report.ink + '">' +
                        hints + '</div>' +
                      '</div>' +
                    '</div>'
                );
            }

            // ---- сетка под фактическую ширину виджета ---------------------
            // Ширина известна только здесь, поэтому пиксели считаются на
            // клиенте: на сервере у узла есть лишь номер уровня и строки.
            var inner = options.width - scene.padSide * 2 - scene.gap * 3;
            var avail = Math.max(inner, scene.minWidth);
            var colW = scene.ratio.map(function (r) { return Math.round(avail * r); });
            var colX = [];
            var cursor = scene.padSide;
            for (var i = 0; i < colW.length; i += 1) {
                colX.push(cursor);
                cursor += colW[i] + scene.gap;
            }
            var canvasW = cursor - scene.gap + scene.padSide;

            function nodeY(row) {
                return scene.padTop + row * scene.rowH + scene.rowH / 2 - scene.nodeH / 2;
            }

            var parts = [];
            parts.push(
                '<svg width="' + canvasW + '" height="' + scene.height + '" ' +
                'viewBox="0 0 ' + canvasW + ' ' + scene.height + '" ' +
                'xmlns="http://www.w3.org/2000/svg">'
            );

            // Легенда и строка активных фильтров
            var lx = scene.padSide;
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
            var note = scene.filters.length
                ? 'фильтр — ' + scene.filters.join(' · ')
                : scene.note;
            if (scene.unknown.length) {
                note += '   ⚠ параметры без фильтра: ' + scene.unknown.join(', ');
            }
            parts.push(
                '<text x="' + lx + '" y="16" font-family="' + scene.font +
                '" font-size="11" fill="' + scene.noteColor + '">' +
                esc(note) + '</text>'
            );

            // Связи
            scene.links.forEach(function (link) {
                var x1 = colX[link.fromLevel] + colW[link.fromLevel];
                var y1 = nodeY(link.fromRow) + scene.nodeH / 2;
                var x2 = colX[link.toLevel];
                var y2 = nodeY(link.toRow) + scene.nodeH / 2;
                var mid = x1 + (x2 - x1) / 2;
                parts.push(
                    '<path d="M' + x1 + ' ' + y1 + 'L' + mid + ' ' + y1 +
                    'L' + mid + ' ' + y2 + 'L' + x2 + ' ' + y2 +
                    '" fill="none" stroke="' + scene.linkColor + '" stroke-width="1.2"/>'
                );
            });

            // Узлы
            scene.nodes.forEach(function (node) {
                var x = colX[node.level];
                var w = colW[node.level];
                var y = nodeY(node.row);

                parts.push(
                    '<rect x="' + x + '" y="' + y + '" width="' + w +
                    '" height="' + scene.nodeH + '" rx="4" fill="' + node.fill +
                    '" stroke="' + node.stroke + '" stroke-width="' + node.sw + '"/>'
                );

                // Подрезаем название под фактическую ширину колонки.
                var metaWidth = node.meta ? node.meta.length * scene.metaCh + 10 : 0;
                var maxChars = Math.floor((w - 18 - metaWidth) / scene.titleCh);
                var title = node.title.length > maxChars
                    ? node.title.slice(0, Math.max(maxChars - 1, 3)) + '…'
                    : node.title;

                parts.push(
                    '<text x="' + (x + 9) + '" y="' + (y + 13) +
                    '" font-family="' + scene.font + '" font-size="' + node.titleSize +
                    '" font-weight="' + node.titleWeight + '" fill="' + node.titleColor +
                    '">' + esc(title) + '</text>'
                );

                if (node.meta) {
                    parts.push(
                        '<text x="' + (x + w - 9) + '" y="' + (y + 13) +
                        '" text-anchor="end" font-family="' + scene.mono +
                        '" font-size="10" fill="' + node.metaColor + '">' +
                        esc(node.meta) + '</text>'
                    );
                }

                var total = 0;
                node.strip.forEach(function (s) { total += s.n; });
                if (!total) { return; }

                var badgeWidth = node.badge.length * scene.metaCh + 8;
                var stripY = y + scene.nodeH - scene.stripH - 5;
                var stripX = x + 9;
                var stripW = w - 18 - badgeWidth;

                node.strip.forEach(function (segment) {
                    var sw = stripW * segment.n / total;
                    parts.push(
                        '<rect x="' + stripX + '" y="' + stripY +
                        '" width="' + Math.max(sw - 1, 1) + '" height="' + scene.stripH +
                        '" rx="1" fill="' + segment.color + '"/>'
                    );
                    stripX += sw;
                });

                parts.push(
                    '<text x="' + (x + w - 9) + '" y="' + (stripY + scene.stripH) +
                    '" text-anchor="end" font-family="' + scene.mono +
                    '" font-size="9" fill="' + node.badgeColor + '">' +
                    esc(node.badge) + '</text>'
                );
            });

            parts.push('</svg>');

            return Editor.generateHtml(
                '<div style="width:' + options.width + 'px;height:' + options.height +
                'px;overflow:auto;background:' + scene.background + '">' +
                parts.join('') + '</div>'
            );
        },
        args: [scene, report]
    })
};
