// ============================================================================
//  Вкладка Sources — запрос данных из датасета.
//  Ключ 'kpi' совпадает с SOURCE_KEY во вкладке Prepare.
// ============================================================================

// Id датасета DataLens берёт из links вкладки Meta — вкладка Meta должна
// содержать {"links": {"gostechDataset": "<id датасета>"}}.
// Если ключа там нет, getId возвращает пустую строку, и чарт падает с
// «Source with id "" was not found in the meta links»; ловим это сразу и
// говорим, что именно не заполнено.
const META_KEY = 'gostechDataset';
const datasetId = Editor.getId(META_KEY);

if (!datasetId) {
    throw new Error(
        'Не задан id датасета. Впишите во вкладку Meta: {"links": {"' +
        META_KEY + '": "<id датасета из адреса .../datasets/ID>"}}'
    );
}

const fields = [
    {ref: {type: 'title', title: 'Тип'}},
    {ref: {type: 'title', title: 'Доля услуг Гостех'}},
];

// Фильтр «Тип: Услуг Гостех» из вашего визарда сделан во вкладке Prepare:
// строк здесь единицы, а имена операций BI API публично не документированы и
// расходятся между версиями — ошибка в фильтре роняет весь чарт, как было с
// direction: 'ASC'. Если данных станет много и отбор понадобится на стороне
// источника, добавьте в filters:
//    {ref: {type: 'title', title: 'Тип'}, operation: 'IN',
//     values: ['Услуг Гостех']}
// и очистите FILTER_VALUES в Prepare, чтобы не фильтровать дважды.
module.exports = {
    gostech: {
        datasetId: datasetId,
        data: {
            fields: fields,
            filters: [],
            limit: 1000,
        },
    },
};
