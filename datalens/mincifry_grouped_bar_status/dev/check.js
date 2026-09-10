// ============================================================================
//  Проверка изоляции рендера.
//
//  Код внутри Editor.wrapFn исполняется в браузере отдельно от файла: он не
//  видит ни констант верхнего уровня, ни функций модуля — только свои
//  аргументы. Локальная заглушка Editor этого не воспроизводит (fn остаётся
//  замыканием), поэтому обращение к внешней переменной проходит незамеченным
//  и падает уже в DataLens.
//
//  Скрипт пересобирает fn из исходного текста в чистом контексте, где есть
//  только Editor, и вызывает её. Любая утечка замыкания даёт ReferenceError.
//
//  Запуск:  node dev/check.js
// ============================================================================

const vm = require('vm');
const path = require('path');

global.Editor = {
    getParams: function () { return require('../Params.js'); },
    getLoadedData: function () { return {status: require('./fixture.js')}; },
    getId: function (key) { return require('../Meta.json').links[key]; },
    generateHtml: function (html) { return html; },
    wrapFn: function (conf) { return conf; },
};

const wrapped = require('../Prepare.js').render;
const sandbox = {Editor: {generateHtml: function (html) { return html; }}};
const isolated = vm.runInNewContext('(' + wrapped.fn.toString() + ')', sandbox);

let failures = 0;

[[960, 540], [420, 420], [1600, 800], [320, 280]].forEach(function (size) {
    try {
        const html = isolated.apply(null, [{width: size[0], height: size[1]}].concat(wrapped.args || []));
        if (typeof html !== 'string' || html.indexOf('<svg') === -1) {
            throw new Error('рендер не вернул SVG');
        }
        console.log('  ok   ' + size[0] + '×' + size[1]);
    } catch (e) {
        failures++;
        console.log('  FAIL ' + size[0] + '×' + size[1] + ': ' + e.message);
    }
});

console.log(failures ? 'Провалено проверок: ' + failures : 'Рендер изолирован корректно.');
process.exit(failures ? 1 : 0);
