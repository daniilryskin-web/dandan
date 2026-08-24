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
var PAD_TOP  = 52;    // легенда, строка итогов и служебная строка сверху
var PAD_SIDE = 12;    // поля слева и справа, px
var GAP      = 16;    // зазор между колонками, px

// Доли ширины по уровням. Сумма должна равняться 1: остаток ширины
// раздаётся пропорционально, поэтому дерево заполняет виджет целиком.
var COL_RATIO = [0.20, 0.21, 0.20, 0.39];

// Ниже этой ширины сетка не сжимается — включается горизонтальная прокрутка,
// иначе на узком виджете названия превращаются в многоточия.
var MIN_WIDTH = 900;

// Показать в шапке всё, что пришло в параметрах, с значениями. Включайте,
// когда селектор не фильтрует: сразу видно, под каким именем приезжает
// значение и приезжает ли вообще.
var DEBUG_PARAMS = false;

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

// Роль → уровень: нужно, чтобы в списке команды точка рядом с фамилией
// была того же цвета, что и сегмент этой роли в полосе состава.
var ROLE_TO_LEVEL = {
    'Руководитель проекта': 'R4',
    'Руководитель функции': 'R4',
    'Руководитель продукта': 'R3',
    'Аналитик': 'R3',
    'Исполнитель функции': 'R3',
    'Администратор проекта': 'R2',
    'Специалист': 'R1',
    'Стажер': 'R0'
};

var THEME = {
    ink: '#141C2B', inkSoft: '#4A5568', inkFaint: '#7C8899',
    sunk: '#EDF0F3', card: '#FFFFFF',
    block: '#16233A', project: '#2C4670',
    chief: '#EDF1F6', chiefLine: '#9FB3CA',
    link: '#B7C4D2', rule: '#DFE4EA',
    deputy: '#12665A', deputyBg: '#D5EBE5',
    hit: '#8A4B12', hitBg: '#FBEBD6',
    panelHead: '#F2F5F9', zebra: '#F7F9FB',
    warn: '#C79A4A', warnBg: '#F7EEDC',
    crit: '#A8382A', critBg: '#F6E3DF',
    white72: 'rgba(255,255,255,.72)',
    white60: 'rgba(255,255,255,.6)',
    font: 'Golos Text, Helvetica Neue, Arial, sans-serif',
    mono: 'JetBrains Mono, SFMono-Regular, Consolas, monospace'
};

var ROLE_COLOR = {};
Object.keys(ROLE_TO_LEVEL).forEach(function (role) {
    LEVELS.forEach(function (level) {
        if (level.key === ROLE_TO_LEVEL[role]) { ROLE_COLOR[role] = level.color; }
    });
});

// Ранг уровня: 0 — старший. Нужен, когда человек на разных продуктах числится
// в разных ролях: на узле выше продукта его учитываем по старшей.
var LEVEL_RANK = {};
LEVELS.forEach(function (level, index) { LEVEL_RANK[level.key] = index; });

// Порядок колонок должен совпадать со списком полей на вкладке Sources.
var COLUMNS = [
    'Блок', 'Проект', 'Руководитель', 'Продукт кратко', 'риск',
    'R4', 'R3', 'R2', 'R1', 'R0', 'людей', 'вакансий', 'ФОТ_мес',
    'заместитель', 'команда', 'Сотрудник'
];

// Колонки, без которых чарт работает: их может не быть в старой выгрузке.
var OPTIONAL = ['заместитель', 'команда', 'Сотрудник'];

// Параметр селектора → колонка, по которой он фильтрует.
//
// Имён у каждого фильтра несколько: DataLens подставляет в параметры то
// латинское имя, что объявлено на вкладке Params, то название поля датасета —
// зависит от того, как настроен селектор (на основе датасета или ручным
// вводом) и от версии. Принимаем оба варианта, чтобы селектор заработал
// при любой настройке.
// Если автоматическое распознавание не сработало, id полей можно прописать
// руками: откройте датасет, у нужного поля скопируйте ID и вставьте сюда.
// Пустая строка означает «не задано» — тогда работает автоопределение.
var FIELD_IDS = {
    'Блок': '',
    'Проект': '',
    'Руководитель': '',
    'Продукт кратко': '',
    'Сотрудник': ''
};

var FILTERS = [
    { keys: ['block',   'Блок'],           column: 'Блок',           label: 'направление' },
    { keys: ['project', 'Проект'],         column: 'Проект',         label: 'проект' },
    { keys: ['chief',   'Руководитель'],   column: 'Руководитель',   label: 'руководитель' },
    { keys: ['product', 'Продукт кратко'], column: 'Продукт кратко', label: 'продукт' },
    // Пятый селектор — выпадающий список сотрудников. Колонка «Сотрудник»
    // появилась в выгрузке ради него: одна строка на пару «продукт —
    // человек». Если её нет, фильтр просто пропускается.
    { keys: ['employee', 'Сотрудник', 'ФИО'], column: 'Сотрудник', label: 'сотрудник' }
];

// Имена параметра свободного поиска по ФИО — поля ввода со вкладки
// Controls. Имена «Сотрудник» и «ФИО» здесь намеренно не перечислены:
// они заняты фильтром выпадающего селектора выше, а он ищет точным
// совпадением, а не по куску строки.
var SEARCH_KEYS = ['search', 'поиск'];

// --------------------------------------------------------------------------
// Разбор ответа источника
// --------------------------------------------------------------------------

function readSource(log) {
    var loaded;
    try {
        loaded = Editor.getLoadedData();
    } catch (e) {
        log.push('Editor.getLoadedData() бросил ошибку: ' + e.message);
        return { fields: COLUMNS, rows: [], aliasToTitle: {} };
    }

    var keys = Object.keys(loaded || {});
    log.push('Ключи источников: ' + (keys.length ? keys.join(', ') : '(пусто)'));
    if (!keys.length) {
        log.push('Источник не вернул ничего. Проверьте вкладки Meta и Sources.');
        return { fields: COLUMNS, rows: [], aliasToTitle: {} };
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

    // Карта «идентификатор поля → название». Селектор на основе датасета
    // передаёт значение параметра под ID поля, а не под названием, и ключ,
    // в котором этот ID лежит, между версиями называется по-разному: guid,
    // id, fieldId. Поэтому не угадываем ключ, а собираем ВСЕ строковые
    // свойства описания поля и оставляем те значения, которые встречаются
    // ровно у одного поля. Так отсеиваются datasetId и data_type — они
    // одинаковы у всех полей и идентификаторами быть не могут.
    var fields = result.fields || src.fields;
    var aliasToTitle = {};
    if (fields && fields.length) {
        var seen = {};
        fields.forEach(function (f) {
            if (!f || !f.title) { return; }
            Object.keys(f).forEach(function (key) {
                if (key === 'title') { return; }
                var value = f[key];
                if (typeof value !== 'string' || !value) { return; }
                if (!seen[value]) { seen[value] = []; }
                if (seen[value].indexOf(f.title) < 0) { seen[value].push(f.title); }
            });
        });
        Object.keys(seen).forEach(function (value) {
            if (seen[value].length === 1) { aliasToTitle[value] = seen[value][0]; }
        });
        log.push('Идентификаторов полей распознано: ' +
                 Object.keys(aliasToTitle).length);
    }

    if (!names) {
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
        return { fields: names, rows: rows, aliasToTitle: aliasToTitle };
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

    return { fields: names, rows: rows, aliasToTitle: aliasToTitle };
}

function indexer(fields) {
    return function (name) {
        var i = fields.indexOf(name);
        if (i < 0 && OPTIONAL.indexOf(name) >= 0) { return -1; }
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
        return { rows: source.rows, active: [], unknown: [], search: null,
                 skipped: [], dump: 'getParams() недоступен' };
    }

    var at = indexer(source.fields);
    var rows = source.rows;
    var active = [];
    var used = {};

    // Идентификатор поля → название колонки, которую он фильтрует.
    var aliases = source.aliasToTitle || {};

    // Кого выбрали в выпадающем селекторе «Сотрудник»: этих людей потом
    // подсвечиваем в составе команд и показываем строкой результата.
    var picked = [];
    // Фильтры, которые пришлось пропустить: колонки нет в выгрузке.
    var skipped = [];

    FILTERS.forEach(function (filter) {
        var values = [];
        // Латинское имя, название поля и все его идентификаторы: селектор
        // может прислать значение под любым из них.
        var accepted = filter.keys.slice();
        if (FIELD_IDS[filter.column]) { accepted.push(FIELD_IDS[filter.column]); }
        Object.keys(aliases).forEach(function (alias) {
            if (aliases[alias] === filter.column && accepted.indexOf(alias) < 0) {
                accepted.push(alias);
            }
        });

        accepted.forEach(function (key) {
            if (params[key] === undefined) { return; }
            used[key] = true;
            asList(params[key]).forEach(function (v) {
                if (values.indexOf(v) < 0) { values.push(v); }
            });
        });
        if (!values.length) { return; }

        var column = at(filter.column);
        // Колонки может не быть в старой выгрузке — тогда фильтр по ней
        // отсекал бы всё подряд. Пропускаем и говорим об этом вслух.
        if (column < 0) {
            skipped.push(filter.label + ' (нет колонки «' + filter.column + '»)');
            log.push('Фильтр ' + filter.keys[0] + ' пропущен: в выгрузке нет ' +
                     'колонки «' + filter.column + '»');
            return;
        }

        rows = rows.filter(function (row) {
            return values.indexOf(String(row[column])) >= 0;
        });
        if (filter.column === 'Сотрудник') { picked = values.slice(); }
        active.push(filter.label + ': ' + values.join(', '));
        log.push('Фильтр ' + filter.keys[0] + ' → ' + values.join(', ') +
                 ', осталось строк: ' + rows.length);
    });

    // Поиск по ФИО. Ищем не только в составе команд, но и среди
    // руководителей и заместителей: человека ищут целиком, а не по роли.
    // Регистр и «ё» не важны, достаточно куска фамилии или табельного
    // номера — совпадение по вхождению подстроки.
    var query = '';
    SEARCH_KEYS.forEach(function (key) {
        if (params[key] === undefined) { return; }
        used[key] = true;
        var raw = params[key];
        var text = (Array.isArray(raw) ? raw.join(' ') : String(raw)).trim();
        text = text.replace(/^__[a-z]+_/, '').trim();
        if (!query && text && text !== 'null' && text !== 'undefined' &&
            text !== '_ALL_') {
            query = text;
        }
    });

    var search = null;
    if (query) {
        var needle = fold(query);
        // Сотрудники обезличены табельными номерами, и поиск по вхождению
        // на них ведёт себя плохо: «11» цепляет 110…119. Чисто цифровой
        // запрос ищем совпадением целиком, всё остальное — по вхождению,
        // чтобы хватало куска фамилии.
        var exact = /^\d+$/.test(needle);
        var matches = function (value) {
            var text = fold(value);
            return exact ? text === needle : text.indexOf(needle) >= 0;
        };
        var hits = {};
        var teamAt = at('команда');
        var deputyAt = at('заместитель');
        var chiefAt = at('Руководитель');

        rows = rows.filter(function (row) {
            var found = [];
            parseRoster(cell(row, teamAt)).forEach(function (member) {
                if (matches(member.name)) {
                    found.push({ name: member.name, role: member.role });
                }
            });
            var chief = String(row[chiefAt] || '').trim();
            if (chief && matches(chief)) {
                found.push({ name: chief, role: 'руководитель' });
            }
            var deputy = String(cell(row, deputyAt) || '').trim();
            if (deputy && matches(deputy)) {
                found.push({ name: deputy, role: 'заместитель' });
            }
            found.forEach(function (item) {
                if (!hits[item.name]) { hits[item.name] = item.role; }
            });
            return found.length > 0;
        });

        search = { query: query, hits: hits, names: Object.keys(hits).sort(),
                   kind: 'поиск' };
        active.push('поиск: ' + query);
        log.push('Поиск «' + query + '» → совпало людей: ' + search.names.length +
                 ', строк: ' + rows.length);
    }

    // Выбор в выпадающем селекторе показываем так же, как результат поиска:
    // строкой сверху и подсветкой в составе команды. Фильтр уже применён
    // выше по колонке «Сотрудник», здесь остаётся только достать роли —
    // в колонке их нет, они лежат в составе команды.
    if (picked.length && !search) {
        var roles = {};
        var rosterAt = at('команда');
        picked.forEach(function (name) { roles[name] = ''; });
        rows.forEach(function (row) {
            parseRoster(cell(row, rosterAt)).forEach(function (member) {
                if (roles[member.name] === '') { roles[member.name] = member.role; }
            });
        });
        search = { query: picked.join(', '), hits: roles, names: picked.slice(),
                   kind: 'выбор' };
    }

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

    // Полный список того, что пришло, — для строки отладки в шапке.
    var dump = Object.keys(params).map(function (key) {
        var raw = params[key];
        var text = Array.isArray(raw) ? raw.join(', ') : String(raw);
        return key + ' = ' + (text || '(пусто)');
    }).join('   ·   ');
    log.push('Параметры: ' + (dump || '(ни одного)'));

    return { rows: rows, active: active, unknown: unknown, search: search,
             skipped: skipped,
             dump: dump || 'ни одного параметра не пришло' };
}

// --------------------------------------------------------------------------
// Вспомогательное
// --------------------------------------------------------------------------

// Значение по индексу, полученному от indexer: -1 означает, что колонки
// нет в выгрузке — необязательные поля просто пустые.
function cell(row, index) {
    return index < 0 ? '' : row[index];
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

// Приведение к виду, в котором ищем: регистр и «ё» не должны мешать найти
// человека, а лишние пробелы в выгрузке встречаются регулярно.
function fold(text) {
    return String(text === null || text === undefined ? '' : text)
        .toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function plural(count, one, few, many) {
    var n = Math.abs(count) % 100;
    var tail = n % 10;
    if (n > 10 && n < 20) { return count + ' ' + many; }
    if (tail > 1 && tail < 5) { return count + ' ' + few; }
    if (tail === 1) { return count + ' ' + one; }
    return count + ' ' + many;
}

// --------------------------------------------------------------------------
// Состав по людям, а не по назначениям
// --------------------------------------------------------------------------

// «Фамилия — Роль; Фамилия — Роль» → список участников продукта.
function parseRoster(text) {
    var out = [];
    String(text || '').split(';').forEach(function (item) {
        var line = item.trim();
        if (!line) { return; }
        var cut = line.indexOf(' — ');
        var name = (cut < 0 ? line : line.slice(0, cut)).trim();
        var role = cut < 0 ? '' : line.slice(cut + 3).trim();
        if (!name) { return; }
        out.push({ name: name, role: role, level: ROLE_TO_LEVEL[role] || '' });
    });
    return out;
}

// Слияние составов веток: один человек — одна запись. Если на разных
// продуктах у него разные роли, остаётся старшая.
function mergeMembers(target, members) {
    members.forEach(function (member) {
        var known = target[member.name];
        if (!known) {
            target[member.name] = member;
            return;
        }
        var rank = LEVEL_RANK[member.level];
        var kept = LEVEL_RANK[known.level];
        if (rank !== undefined && (kept === undefined || rank < kept)) {
            target[member.name] = member;
        }
    });
}

// Полоса состава по уникальным людям: каждый попадает ровно в один сегмент.
function countsOfMembers(members) {
    var counts = emptyCounts();
    Object.keys(members).forEach(function (name) {
        var level = members[name].level;
        if (counts[level] !== undefined) { counts[level] += 1; }
    });
    return counts;
}

// --------------------------------------------------------------------------
// Дерево и сцена
// --------------------------------------------------------------------------

function millions(value) {
    var n = Number(value) || 0;
    if (n >= 1e6) { return (n / 1e6).toFixed(2).replace('.', ',') + ' млн ₽'; }
    return money(n) + ' ₽';
}

function buildScene(fields, rows, active, unknown, dump, search, skipped) {
    var at = indexer(fields);

    // В выгрузке одна строка на пару «продукт — сотрудник»: так устроен
    // выпадающий селектор «Сотрудник». Дереву нужен продукт, поэтому строки
    // схлопываем обратно по ключу ветки. Показатели продукта на всех его
    // строках одинаковы, берём первую.
    if (at('Сотрудник') >= 0) {
        var seenPath = {};
        var unique = [];
        var path = [at('Блок'), at('Проект'), at('Руководитель'),
                    at('Продукт кратко')];
        rows.forEach(function (row) {
            var key = path.map(function (i) { return String(row[i]); }).join(' ');
            if (seenPath[key]) { return; }
            seenPath[key] = true;
            unique.push(row);
        });
        rows = unique;
    }

    // Колонки «людей» и R4…R0 приходят по продуктам. Складывать их вверх по
    // дереву нельзя: человек, занятый на двух продуктах, даст двойку и на
    // руководителе, и на проекте, и на направлении. Настоящую численность
    // даёт только перебор фамилий из колонки «команда».
    var rosterKnown = at('команда') >= 0;
    var rosters = rows.map(function (row) {
        return rosterKnown ? parseRoster(cell(row, at('команда'))) : [];
    });

    // Пересчёт по фамилиям делаем, только если состав читается целиком:
    // у каждого участника распознана роль и число фамилий совпадает с
    // колонкой «людей». Иначе честнее оставить суммы — они хотя бы не
    // потеряют людей.
    var rosterUsable = rosterKnown;
    rosters.forEach(function (members, index) {
        if (!rosterUsable) { return; }
        if (members.length !== (Number(rows[index][at('людей')]) || 0)) {
            rosterUsable = false;
            return;
        }
        members.forEach(function (member) {
            if (!member.level) { rosterUsable = false; }
        });
    });

    var uniquePeople = {};
    rosters.forEach(function (members) { mergeMembers(uniquePeople, members); });
    var uniqueCount = Object.keys(uniquePeople).length;

    function makeNode(name) {
        return {
            name: name, children: [], childIndex: {}, members: {},
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

    rows.forEach(function (row, index) {
        var counts = emptyCounts();
        LEVELS.forEach(function (level) {
            counts[level.key] = Number(row[at(level.key)]) || 0;
        });

        var team = String(cell(row, at('команда')) || '')
            .split(';')
            .map(function (item) { return item.trim(); })
            .filter(function (item) { return item.length > 0; });

        var product = {
            team: team,
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
        // Заместитель — атрибут руководителя: первое непустое значение
        // по его ветке.
        if (!chief.deputy) {
            chief.deputy = String(cell(row, at('заместитель')) || '').trim();
        }

        chief.children.push(product);

        // Состав ветки: у направления сразу видно, на ком оно держится, без
        // разворачивания. ФОТ аллоцирован по назначениям, поэтому его как раз
        // складываем — сумма долей и есть месячный ФОТ ветки.
        [chief, project, block].forEach(function (node) {
            addCounts(node.counts, counts);
            node.people += product.people;
            node.vacancies += product.vacancies;
            node.fot += product.fot;
            mergeMembers(node.members, rosters[index]);
        });
    });

    // Замена сумм на пересчёт по уникальным фамилиям — на всех узлах выше
    // продукта. Лист трогать не нужно: там «людей» уже уникальные.
    function dedupe(node) {
        node.people = Object.keys(node.members).length;
        node.counts = countsOfMembers(node.members);
    }
    if (rosterUsable) {
        root.children.forEach(function (block) {
            dedupe(block);
            block.children.forEach(function (project) {
                dedupe(project);
                project.children.forEach(dedupe);
            });
        });
    }

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

    var totals = {
        blocks: root.children.length,
        projects: 0,
        chiefs: 0,
        products: 0,
        assignments: 0,
        vacancies: 0,
        fot: 0
    };
    root.children.forEach(function (block) {
        totals.projects += block.children.length;
        totals.assignments += block.people;
        totals.vacancies += block.vacancies;
        totals.fot += block.fot;
        block.children.forEach(function (project) {
            totals.chiefs += project.children.length;
            project.children.forEach(function (chief) {
                totals.products += chief.children.length;
            });
        });
    });

    // Строка итогов: сколько объектов и людей в текущем срезе.
    var summary = [
        totals.blocks + ' направл.',
        totals.projects + ' проект.',
        totals.chiefs + ' руковод.',
        totals.products + ' продукт.',
        rosterKnown
            ? uniqueCount + ' сотрудников'
            : totals.assignments + ' назначений',
        millions(totals.fot)
    ];
    if (totals.vacancies) { summary.push('+' + totals.vacancies + ' вакансий'); }

    // Строка результата поиска. Показывает, кого нашли и в скольких местах:
    // человек на двух продуктах — это не два человека, а один в двух местах,
    // и увидеть это нужно сразу, не пересчитывая карточки глазами.
    var searchLine = '';
    var hitNames = {};
    if (search) {
        search.names.forEach(function (name) { hitNames[name] = true; });
        var picked = search.kind === 'выбор';
        var count = search.names.length;

        // Один человек — с ролью: «68 — Руководитель проекта». Несколько —
        // просто перечислением, роли в строку не влезут.
        var who;
        if (!count) {
            who = 'никого не нашли';
        } else if (count === 1) {
            var only = search.names[0];
            who = only + (search.hits[only] ? ' — ' + search.hits[only] : '');
        } else {
            who = search.names.slice(0, 8).join(', ') + (count > 8 ? ' …' : '');
            if (!picked) {
                who = plural(count, 'совпадение', 'совпадения', 'совпадений') +
                      ': ' + who;
            }
        }

        var head;
        if (picked) {
            head = count === 1 ? 'выбран:  ' : 'выбрано ' + count + ':  ';
        } else {
            head = 'поиск «' + search.query + '»:  ';
        }

        searchLine = head + who;
        if (count) {
            searchLine += '  ·  ' +
                plural(totals.products, 'продукт', 'продукта', 'продуктов') +
                '  ·  ' +
                plural(totals.blocks, 'направление', 'направления', 'направлений');
        }
    }
    var padTop = PAD_TOP + (searchLine ? 14 : 0);

    var scene = {
        rows: leafRow,
        summary: 'в срезе:  ' + summary.join('  ·  '),
        searchLine: searchLine,
        hitNames: hitNames,
        hitColor: THEME.hit,
        hitBg: THEME.hitBg,
        height: leafRow * ROW + padTop + 12,
        warnRoom: (unknown && unknown.length) || (skipped && skipped.length) ||
                  (DEBUG_PARAMS ? 1 : 0) ? 16 : 0,
        rowH: ROW, nodeH: NODE_H, stripH: STRIP,
        padTop: padTop, padSide: PAD_SIDE, gap: GAP,
        ratio: COL_RATIO, minWidth: MIN_WIDTH,
        metaCh: META_CH, titleCh: TITLE_CH,
        background: THEME.sunk,
        font: THEME.font,
        mono: THEME.mono,
        linkColor: THEME.link,
        noteColor: THEME.inkFaint,
        deputyColor: THEME.deputy,
        deputyBg: THEME.deputyBg,
        panelBg: THEME.card,
        headBg: THEME.panelHead,
        zebra: THEME.zebra,
        roleColor: ROLE_COLOR,
        panelLine: THEME.chiefLine,
        panelInk: THEME.ink,
        note: 'клик по продукту — состав команды',
        filters: active,
        unknown: unknown || [],
        skipped: skipped || [],
        debugParams: DEBUG_PARAMS ? String(dump || '') : '',
        warnColor: THEME.crit,
        legend: LEVELS.map(function (level) {
            return { color: level.color, label: level.label };
        }),
        nodes: [],
        links: [],
        blocks: root.children.length,
        people: rosterUsable
            ? uniqueCount
            : root.children.reduce(function (sum, b) { return sum + b.people; }, 0)
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
            id: options.id || '',
            deputy: options.deputy || '',
            team: options.team || [],
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
            meta: block.people + ' чел · ' + millions(block.fot),
            metaColor: THEME.white72, badgeColor: THEME.white60
        });

        block.children.forEach(function (project) {
            var projectBox = pushNode(1, project.row, {
                counts: project.counts, fill: THEME.project, color: '#FFFFFF',
                title: project.name,
                meta: project.people + ' чел · ' + millions(project.fot),
                metaColor: THEME.white72, badgeColor: THEME.white60
            });
            pushLink(blockBox, projectBox);

            project.children.forEach(function (chief) {
                var chiefBox = pushNode(2, chief.row, {
                    counts: chief.counts, fill: THEME.chief,
                    stroke: THEME.chiefLine, color: THEME.ink,
                    title: chief.name,
                    meta: chief.people + ' чел · ' + millions(chief.fot),
                    deputy: chief.deputy
                });
                pushLink(projectBox, chiefBox);

                chief.children.forEach(function (product) {
                    // Подсветка по нехватке людей убрана по просьбе заказчика:
                    // риск незаменимости считается на листе «Иерархия» и
                    // разбирается отдельным чартом, а в дереве цвет только
                    // мешал читать состав.
                    var fill = THEME.card;
                    var stroke = THEME.rule;
                    var color = THEME.ink;
                    var productBox = pushNode(3, product.row, {
                        id: 'p' + scene.nodes.length,
                        team: product.team,
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
// Пустой результат поиска — не поломка, а нормальный ответ. Показываем его
// короткой запиской, без технической выкладки и списка «что проверить»:
// иначе человек, опечатавшийся в фамилии, идёт чинить вкладку Sources.
var quiet = false;

if (source.rows.length) {
    try {
        var filtered = applyFilters(source, log);
        if (!filtered.rows.length && filtered.search) {
            quiet = true;
            failure = 'По запросу «' + filtered.search.query + '» никого не нашли. ' +
                      'Хватит куска фамилии или табельного номера целиком, ' +
                      'регистр и «ё» не важны. Если кроме поиска стоят ' +
                      'селекторы — поиск идёт внутри их среза, снимите лишние.';
        } else if (!filtered.rows.length) {
            failure = 'Под выбранные фильтры не попало ни одной строки. ' +
                      'Снимите часть значений в селекторах.';
        } else {
            scene = buildScene(source.fields, filtered.rows, filtered.active,
                               filtered.unknown, filtered.dump, filtered.search,
                               filtered.skipped);
            log.push('Построено узлов: ' + scene.nodes.length +
                     ', направлений: ' + scene.blocks +
                     ', людей в срезе: ' + scene.people);

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
    heading: quiet ? 'Никого не нашли' : 'Дерево не построено',
    headColor: quiet ? THEME.hit : THEME.crit,
    lines: quiet ? [] : log,
    hint: quiet ? [] : [
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
                        report.headColor + ';margin-bottom:8px">' +
                        esc(report.heading) + '</div>' +
                        '<div style="font-size:12px;color:' + report.ink +
                        ';margin-bottom:12px">' + esc(report.title) + '</div>' +
                        (lines
                            ? '<div style="font-family:' + report.mono +
                              ';font-size:11px;color:' + report.inkSoft +
                              ';border-top:1px solid ' + report.rule +
                              ';padding-top:10px;margin-bottom:12px">' + lines + '</div>'
                            : '') +
                        (hints
                            ? '<div style="font-size:12px;color:' + report.ink + '">' +
                              hints + '</div>'
                            : '') +
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
            var canvasH = scene.height;

            function nodeY(row) {
                return scene.padTop + row * scene.rowH + scene.rowH / 2 - scene.nodeH / 2;
            }

            // Тело собираем отдельно от тега svg: его высота известна только
            // после того, как посчитана раскрытая панель.
            var parts = [];

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
            parts.push(
                '<text x="' + lx + '" y="16" font-family="' + scene.font +
                '" font-size="11" fill="' + scene.noteColor + '">' +
                esc(note) + '</text>'
            );

            // Строка итогов среза — вторая сверху, всегда.
            parts.push(
                '<text x="' + scene.padSide + '" y="34" font-family="' + scene.mono +
                '" font-size="10.5" fill="' + scene.panelInk + '">' +
                esc(scene.summary) + '</text>'
            );

            // Результат поиска по ФИО — третьей строкой, сразу под итогами.
            var afterSummary = 48;
            if (scene.searchLine) {
                parts.push(
                    '<text x="' + scene.padSide + '" y="' + afterSummary +
                    '" font-family="' + scene.mono + '" font-size="10.5" ' +
                    'font-weight="600" fill="' + scene.hitColor + '">' +
                    esc(scene.searchLine) + '</text>'
                );
                afterSummary += 14;
            }

            // Служебная строка отдельно от легенды: приписанная в конец
            // первой строки, она уезжала за край и оставалась незамеченной.
            var service = '';
            var alarm = scene.unknown.length > 0 || scene.skipped.length > 0;
            if (scene.unknown.length) {
                service = '⚠ параметр пришёл, но фильтра под него нет: ' +
                          scene.unknown.join(', ') +
                          '  — добавьте это имя в FILTERS и Params';
            } else if (scene.skipped.length) {
                service = '⚠ фильтр пропущен: ' + scene.skipped.join(', ') +
                          '  — перегенерируйте выгрузку и добавьте поле ' +
                          'на вкладку Sources';
            } else if (scene.debugParams) {
                service = 'параметры: ' + scene.debugParams;
            }
            if (service) {
                parts.push(
                    '<text x="' + scene.padSide + '" y="' + afterSummary +
                    '" font-family="' + scene.mono + '" font-size="10" fill="' +
                    (alarm ? scene.warnColor : scene.noteColor) +
                    '">' + esc(service) + '</text>'
                );
            }

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

            // Что раскрыто по клику. Состояние живёт в самом чарте: клик
            // кладёт в него id продукта, render читает и дорисовывает панель.
            var state = {};
            try {
                if (typeof Chart !== 'undefined' && Chart.getState) {
                    state = Chart.getState() || {};
                }
            } catch (e) { state = {}; }
            var openId = state.open || '';
            var openNode = null;

            // Узлы
            scene.nodes.forEach(function (node) {
                var x = colX[node.level];
                var w = colW[node.level];
                var y = nodeY(node.row);

                // data-id вешаем на каждый элемент карточки: клик может
                // прийтись и на подпись, и на полосу состава, а не только
                // на прямоугольник.
                var tag = node.id ? ' data-id="' + node.id + '"' : '';
                if (node.id === openId) { openNode = { node: node, x: x, y: y, w: w }; }

                parts.push(
                    '<rect x="' + x + '" y="' + y + '" width="' + w +
                    '" height="' + scene.nodeH + '" rx="4" fill="' + node.fill +
                    '" stroke="' + (node.id === openId ? scene.panelInk : node.stroke) +
                    '" stroke-width="' + (node.id === openId ? 2 : node.sw) + '"' +
                    tag + (node.id ? ' cursor="pointer"' : '') + '/>'
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
                    '"' + tag + '>' + esc(title) + '</text>'
                );

                if (node.meta) {
                    parts.push(
                        '<text x="' + (x + w - 9) + '" y="' + (y + 13) +
                        '" text-anchor="end" font-family="' + scene.mono +
                        '" font-size="10" fill="' + node.metaColor + '">' +
                        esc(node.meta) + '</text>'
                    );
                }

                // Заместитель — в свободном месте между именем и счётчиком.
                if (node.deputy) {
                    var afterTitle = x + 9 + title.length * scene.titleCh + 12;
                    var beforeMeta = x + w - 9 - metaWidth - 6;
                    var room = beforeMeta - afterTitle;
                    if (room > 60) {
                        var dep = 'зам. ' + node.deputy;
                        var depMax = Math.floor((room - 12) / scene.metaCh);
                        if (dep.length > depMax) {
                            dep = dep.slice(0, Math.max(depMax - 1, 5)) + '…';
                        }
                        // Плашка, а не просто серый текст: на светлой карточке
                        // руководителя серое по серому не читалось.
                        var depW = dep.length * scene.metaCh + 12;
                        parts.push(
                            '<rect x="' + afterTitle + '" y="' + (y + 4) +
                            '" width="' + depW + '" height="16" rx="8" fill="' +
                            scene.deputyBg + '"/>'
                        );
                        parts.push(
                            '<text x="' + (afterTitle + 6) + '" y="' + (y + 15) +
                            '" font-family="' + scene.font + '" font-size="10" ' +
                            'font-weight="600" fill="' + scene.deputyColor + '">' +
                            esc(dep) + '</text>'
                        );
                    }
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
                        '" rx="1" fill="' + segment.color + '"' + tag + '/>'
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

            // Панель команды рисуется последней — она ложится поверх узлов
            // ниже по дереву, не сдвигая раскладку.
            if (openNode && openNode.node.team.length) {
                var node = openNode.node;
                var members = node.team.map(function (item) {
                    var cut = item.indexOf(' — ');
                    return cut < 0
                        ? { name: item, role: '' }
                        : { name: item.slice(0, cut), role: item.slice(cut + 3) };
                });

                var lineH = 19;
                var headH = 52;
                var panelH = headH + members.length * lineH + 10;
                var panelW = openNode.w;
                var panelX = openNode.x;
                // Панель всегда под узлом, а полотно растёт под неё. Раньше
                // при фильтре по одному продукту высота считалась только по
                // дереву — панель не помещалась, и состав был не виден.
                var panelY = openNode.y + scene.nodeH + 6;
                canvasH = Math.max(canvasH, panelY + panelH + 12);

                parts.push(
                    '<rect x="' + panelX + '" y="' + panelY + '" width="' + panelW +
                    '" height="' + panelH + '" rx="6" fill="' + scene.panelBg +
                    '" stroke="' + scene.panelInk + '" stroke-width="1.5"/>'
                );

                // Шапка панели: название продукта и его числа
                parts.push(
                    '<rect x="' + panelX + '" y="' + panelY + '" width="' + panelW +
                    '" height="' + headH + '" rx="6" fill="' + scene.headBg + '"/>'
                );
                parts.push(
                    '<rect x="' + panelX + '" y="' + (panelY + headH - 6) + '" width="' +
                    panelW + '" height="6" fill="' + scene.headBg + '"/>'
                );
                parts.push(
                    '<text x="' + (panelX + 12) + '" y="' + (panelY + 20) +
                    '" font-family="' + scene.font + '" font-size="12" font-weight="700" ' +
                    'fill="' + scene.panelInk + '">' + esc(node.title) + '</text>'
                );
                parts.push(
                    '<text x="' + (panelX + 12) + '" y="' + (panelY + 38) +
                    '" font-family="' + scene.mono + '" font-size="10" fill="' +
                    scene.noteColor + '">' + esc(node.meta) + '</text>'
                );

                // Крестик: закрыть можно, не попадая в сам продукт. При фильтре
                // по одному продукту панель перекрывала его, и свернуть список
                // было нечем.
                var cx = panelX + panelW - 20;
                var cy = panelY + 18;
                parts.push(
                    '<rect x="' + (cx - 11) + '" y="' + (cy - 11) + '" width="22" ' +
                    'height="22" rx="11" fill="' + scene.panelBg + '" stroke="' +
                    scene.panelLine + '" stroke-width="1" data-id="close" ' +
                    'cursor="pointer"/>'
                );
                parts.push(
                    '<path d="M' + (cx - 4) + ' ' + (cy - 4) + 'L' + (cx + 4) + ' ' +
                    (cy + 4) + 'M' + (cx + 4) + ' ' + (cy - 4) + 'L' + (cx - 4) + ' ' +
                    (cy + 4) + '" stroke="' + scene.panelInk + '" stroke-width="1.6" ' +
                    'stroke-linecap="round" data-id="close" cursor="pointer"/>'
                );

                // Строки состава: полоска через всю ширину под чётными,
                // цветная точка уровня роли, фамилия и роль.
                members.forEach(function (member, i) {
                    var rowY = panelY + headH + i * lineH;
                    // Найденный поиском — своей заливкой на всю строку: в
                    // команде из двадцати человек нужного иначе не выхватить.
                    var isHit = scene.hitNames[member.name] === true;
                    if (isHit) {
                        parts.push(
                            '<rect x="' + (panelX + 1) + '" y="' + rowY + '" width="' +
                            (panelW - 2) + '" height="' + lineH + '" fill="' +
                            scene.hitBg + '"/>'
                        );
                    } else if (i % 2 === 1) {
                        parts.push(
                            '<rect x="' + (panelX + 1) + '" y="' + rowY + '" width="' +
                            (panelW - 2) + '" height="' + lineH + '" fill="' +
                            scene.zebra + '"/>'
                        );
                    }
                    var color = scene.roleColor[member.role] || scene.noteColor;
                    parts.push(
                        '<circle cx="' + (panelX + 18) + '" cy="' + (rowY + 10) +
                        '" r="4" fill="' + color + '"/>'
                    );
                    parts.push(
                        '<text x="' + (panelX + 30) + '" y="' + (rowY + 14) +
                        '" font-family="' + scene.font + '" font-size="11" ' +
                        'font-weight="' + (isHit ? 700 : 600) + '" fill="' +
                        (isHit ? scene.hitColor : scene.panelInk) + '">' +
                        esc(member.name) + '</text>'
                    );
                    parts.push(
                        '<text x="' + (panelX + panelW - 12) + '" y="' + (rowY + 14) +
                        '" text-anchor="end" font-family="' + scene.font +
                        '" font-size="11" fill="' +
                        (isHit ? scene.hitColor : scene.noteColor) + '">' +
                        esc(member.role) + '</text>'
                    );
                });
            }

            var svg =
                '<svg width="' + canvasW + '" height="' + canvasH + '" ' +
                'viewBox="0 0 ' + canvasW + ' ' + canvasH + '" ' +
                'xmlns="http://www.w3.org/2000/svg">' + parts.join('') + '</svg>';

            return Editor.generateHtml(
                '<div style="width:' + options.width + 'px;height:' + options.height +
                'px;overflow:auto;background:' + scene.background + '">' + svg + '</div>'
            );
        },
        args: [scene, report]
    }),

    // Клик по продукту раскрывает состав его команды. Состояние хранится
    // в самом чарте: setState вызывает повторный render, и панель появляется
    // или исчезает. Повторный клик по тому же продукту сворачивает список.
    events: {
        click: Editor.wrapFn({
            fn: function (event) {
                var target = event && event.target;
                var id = null;
                // Клик мог прийтись на подпись внутри карточки — поднимаемся
                // к ближайшему предку с data-id.
                for (var i = 0; target && i < 4; i += 1) {
                    if (target.getAttribute) { id = target.getAttribute('data-id'); }
                    if (id) { break; }
                    target = target.parentNode;
                }
                if (!id) { return; }

                var api = (typeof Chart !== 'undefined' && Chart.setState)
                    ? Chart : null;
                if (!api) { return; }

                if (id === 'close') { api.setState({ open: '' }); return; }

                var current = (api.getState && api.getState()) || {};
                api.setState({ open: current.open === id ? '' : id });
            }
        })
    }
};
