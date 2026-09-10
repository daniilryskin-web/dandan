// ============================================================================
//  Вкладка «Источники» (Urls) — забор данных из датасета через BI API.
//  Нужна только когда в 03_prepare.js выключен DEMO-режим (DEMO = false).
// ============================================================================

// ID датасета: возьмите из URL датасета в DataLens
// https://datalens.yandex.ru/datasets/<DATASET_ID>
const DATASET_ID = 'PUT_YOUR_DATASET_ID_HERE';

const params = ChartEditor.getParams();

// Поля запрашиваем по заголовку — так код читается и не ломается при
// пересоздании поля. Если в вашем инстансе ref по title не поддерживается,
// замените на {type: 'id', id: '<guid поля>'}.
function byTitle(title, role) {
    return {
        ref: {type: 'title', title: title},
        role_spec: {role: role},
    };
}

const body = {
    fields: [
        byTitle('Год', 'row'),
        byTitle('Онлайн', 'row'),
        byTitle('Проактив', 'row'),
        byTitle('Рефакторинг', 'row'),
    ],
    order_by: [
        {ref: {type: 'title', title: 'Год'}, direction: 'ASC'},
    ],
    filters: [],
    limit: 1000,
    autofill_legend: true,
};

// Фильтр по годам из вкладки «Элементы управления» (если селектор задан).
if (params.year && params.year.length && params.year[0] !== '') {
    body.filters.push({
        ref: {type: 'title', title: 'Год'},
        operation: 'IN',
        values: params.year,
    });
}

module.exports = {
    data: {
        url: '/_bi/api/data/v1/datasets/' + DATASET_ID + '/versions/draft/result',
        method: 'POST',
        cache: 60,
        body: body,
    },
};
