// ============================================================================
//  Локальный предпросмотр без DataLens: подставляет заглушку объекта Editor,
//  выполняет Prepare.js и сохраняет результат рендера в preview.html.
//
//  Запуск:  node dev/preview.js [ширина] [высота]
//  Затем открыть preview.html в браузере.
// ============================================================================

const fs = require('fs');
const path = require('path');

const WIDTH = Number(process.argv[2]) || 960;
const HEIGHT = Number(process.argv[3]) || 460;

// Заглушка Editor: повторяет контракт методов, которыми пользуется Prepare.
global.Editor = {
    getParams: function () {
        return require('../Params.js');
    },
    getLoadedData: function () {
        return {works: require('./fixture.js')};
    },
    getId: function (key) {
        return require('../Meta.json').links[key];
    },
    // В DataLens возвращает безопасную разметку; здесь достаточно тождества.
    generateHtml: function (html) {
        return html;
    },
    // В DataLens сериализует функцию для исполнения в браузере;
    // здесь просто сохраняем её и аргументы, чтобы вызвать локально.
    wrapFn: function (conf) {
        return conf;
    },
};

const chart = require('../Prepare.js');
const wrapped = chart.render;
const html = wrapped.fn.apply(null, [{width: WIDTH, height: HEIGHT}].concat(wrapped.args || []));

const page = [
    '<!doctype html>',
    '<html lang="ru"><head><meta charset="utf-8">',
    '<title>Предпросмотр — Стадии работ, стиль Минцифры</title>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Ubuntu:wght@400;500;700&display=swap">',
    '<style>body{margin:0;padding:24px;background:#F5F7FA;',
    'font-family:Ubuntu,"Segoe UI","Helvetica Neue",Arial,sans-serif}',
    '.card{max-width:' + (WIDTH + 16) + 'px;margin:0 auto;background:#fff;border:1px solid #E4E8EE;',
    'border-radius:12px;padding:8px;box-shadow:0 2px 8px rgba(11,31,51,.06)}</style>',
    '</head><body><div class="card">',
    html,
    '</div></body></html>',
].join('');

const out = path.join(__dirname, '..', 'preview.html');
fs.writeFileSync(out, page);
console.log('preview.html обновлён:', out, WIDTH + '×' + HEIGHT);
