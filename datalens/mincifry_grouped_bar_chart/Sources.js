// ============================================================================
//  Вкладка Sources — запрос данных из датасета.
//  Ключ 'grouped' совпадает с SOURCE_KEY во вкладке Prepare.
// ============================================================================

// Id датасета DataLens берёт из links вкладки Meta — вкладка Meta должна
// содержать {"links": {"groupedDataset": "<id датасета>"}}.
// Если ключа там нет, getId возвращает пустую строку, и чарт падает с
// «Source with id "" was not found in the meta links»; ловим это сразу и
// говорим, что именно не заполнено.
const META_KEY = 'groupedDataset';
const datasetId = Editor.getId(META_KEY);

if (!datasetId) {
    throw new Error(
        'Не задан id датасета. Впишите во вкладку Meta: {"links": {"' +
        META_KEY + '": "<id датасета из адреса .../datasets/ID>"}}'
    );
}

const params = Editor.getParams();

// «Год» — так поле называется в датасете, хотя лежат в нём ЖС / ЛиР / ТМУ.
// Меры названы годами: 2025, 2026, 2027.
const fields = [
    {ref: {type: 'title', title: 'Год'}},
    {ref: {type: 'title', title: '2025'}},
    {ref: {type: 'title', title: '2026'}},
    {ref: {type: 'title', title: '2027'}},
];

const filters = [];

if (params.category && params.category[0]) {
    filters.push({
        ref: {type: 'title', title: 'Год'},
        operation: 'IN',
        values: params.category,
    });
}

module.exports = {
    grouped: {
        datasetId: datasetId,
        data: {
            fields: fields,
            filters: filters,
            limit: 1000,
        },
    },
};
