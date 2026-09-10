// ============================================================================
//  Вкладка Sources — запрос данных из датасета.
//  Ключ 'levels' совпадает с SOURCE_KEY во вкладке Prepare.
// ============================================================================

const params = Editor.getParams();

const fields = [
    {ref: {type: 'title', title: 'Год'}},
    {ref: {type: 'title', title: 'Федеральный'}},
    {ref: {type: 'title', title: 'Региональный'}},
    {ref: {type: 'title', title: 'Федеральный/Региональный'}},
    {ref: {type: 'title', title: 'Региональный/Муниципальный'}},
];

const filters = [];

if (params.year && params.year[0]) {
    filters.push({
        ref: {type: 'title', title: 'Год'},
        operation: 'IN',
        values: params.year,
    });
}

module.exports = {
    levels: {
        datasetId: Editor.getId('levelsDataset'),
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
