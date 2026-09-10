// ============================================================================
//  Вкладка Sources — запрос данных из датасета.
//  Ключ 'status' совпадает с SOURCE_KEY во вкладке Prepare.
// ============================================================================

// Id датасета DataLens берёт из links вкладки Meta — вкладка Meta должна
// содержать {"links": {"statusDataset": "<id датасета>"}}.
// Если ключа там нет, getId возвращает пустую строку, и чарт падает с
// «Source with id "" was not found in the meta links»; ловим это сразу и
// говорим, что именно не заполнено.
const META_KEY = 'statusDataset';
const datasetId = Editor.getId(META_KEY);

if (!datasetId) {
    throw new Error(
        'Не задан id датасета. Впишите во вкладку Meta: {"links": {"' +
        META_KEY + '": "<id датасета из адреса .../datasets/ID>"}}'
    );
}

// Имена полей должны совпадать с датасетом дословно.
const fields = [
    {ref: {type: 'title', title: 'Статус'}},
    {ref: {type: 'title', title: 'ОЦС2 (индикатор)'}},
    {ref: {type: 'title', title: 'ДК2 (индикатор)'}},
];

// Фильтр «Статус не принадлежит множеству» из вашего визарда сделан во
// вкладке Prepare (EXCLUDE_CATEGORIES): строк тут единицы, а имена операций
// BI API публично не документированы и расходятся между версиями — ошибка в
// фильтре роняет весь чарт. Если данных станет много, отбор можно перенести
// сюда, добавив в filters:
//    {ref: {type: 'title', title: 'Статус'}, operation: 'NIN',
//     values: ['Уровень достижения, %']}
// и очистив EXCLUDE_CATEGORIES в Prepare.
module.exports = {
    status: {
        datasetId: datasetId,
        data: {
            fields: fields,
            filters: [],
            limit: 1000,
        },
    },
};
