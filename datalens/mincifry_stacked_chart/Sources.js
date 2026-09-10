// ============================================================================
//  Вкладка Sources — запрос данных из датасета.
//  Ключ объекта ('services') — имя источника; под этим же ключом данные
//  придут в Editor.getLoadedData() во вкладке Prepare.
//  ID датасета берётся из поля links вкладки Meta.
// ============================================================================

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
        datasetId: Editor.getId('servicesDataset'),
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
