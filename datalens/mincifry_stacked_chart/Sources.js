// ============================================================================
//  Вкладка Sources — запрос данных из датасета.
//  Ключ объекта ('services') — имя источника; под этим же ключом данные
//  придут в Editor.getLoadedData() во вкладке Prepare.
//  ID датасета берётся из поля links вкладки Meta.
// ============================================================================

// Id датасета DataLens берёт из links вкладки Meta — вкладка Meta должна
// содержать {"links": {"servicesDataset": "<id датасета>"}}.
// Если ключа там нет, getId возвращает пустую строку, и чарт падает с
// «Source with id "" was not found in the meta links»; ловим это сразу и
// говорим, что именно не заполнено.
const META_KEY = 'servicesDataset';
const datasetId = Editor.getId(META_KEY);

if (!datasetId) {
    throw new Error(
        'Не задан id датасета. Впишите во вкладку Meta: {"links": {"' +
        META_KEY + '": "<id датасета из адреса .../datasets/ID>"}}'
    );
}

const params = Editor.getParams();

const fields = [
    {ref: {type: 'title', title: 'Год'}},
    {ref: {type: 'title', title: 'Онлайн'}},
    {ref: {type: 'title', title: 'Проактив'}},
    {ref: {type: 'title', title: 'Рефакторинг'}},
];

const filters = [];

// Фильтр из селектора «year», если он добавлен во вкладке Controls.
if (params.year && params.year[0]) {
    filters.push({
        ref: {type: 'title', title: 'Год'},
        operation: 'IN',
        values: params.year,
    });
}

module.exports = {
    services: {
        datasetId: datasetId,
        data: {
            fields: fields,
            filters: filters,
            order_by: [
                {ref: {type: 'title', title: 'Год'}, direction: 'asc'},
            ],
            limit: 1000,
        },
    },
};
