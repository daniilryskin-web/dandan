// ============================================================================
//  Вкладка Sources — запрос данных из датасета.
//  Ключ 'requests' совпадает с SOURCE_KEY во вкладке Prepare.
// ============================================================================

// Id датасета DataLens берёт из links вкладки Meta — вкладка Meta должна
// содержать {"links": {"requestsDataset": "<id датасета>"}}.
// Если ключа там нет, getId возвращает пустую строку, и чарт падает с
// «Source with id "" was not found in the meta links»; ловим это сразу и
// говорим, что именно не заполнено.
const META_KEY = 'requestsDataset';
const datasetId = Editor.getId(META_KEY);

if (!datasetId) {
    throw new Error(
        'Не задан id датасета. Впишите во вкладку Meta: {"links": {"' +
        META_KEY + '": "<id датасета из адреса .../datasets/ID>"}}'
    );
}

// Имена полей должны совпадать с датасетом дословно, вместе с суффиксом
// «(индикатор)» и двоеточием в конце третьего.
const fields = [
    {ref: {type: 'title', title: 'Тип'}},
    {ref: {type: 'title', title: '0. Заявка не подана (индикатор)'}},
    {ref: {type: 'title', title: '1. Заявка подана (индикатор)'}},
    {ref: {type: 'title', title: '2. Заявка исполнена: (индикатор)'}},
];

module.exports = {
    requests: {
        datasetId: datasetId,
        data: {
            fields: fields,
            filters: [],
            limit: 1000,
        },
    },
};
