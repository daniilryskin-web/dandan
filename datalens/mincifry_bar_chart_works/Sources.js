// ============================================================================
//  Вкладка Sources — запрос данных из датасета.
//  Ключ 'works' совпадает с SOURCE_KEY во вкладке Prepare.
// ============================================================================

// Id датасета DataLens берёт из links вкладки Meta — вкладка Meta должна
// содержать {"links": {"worksDataset": "<id датасета>"}}.
// Если ключа там нет, getId возвращает пустую строку, и чарт падает с
// «Source with id "" was not found in the meta links»; ловим это сразу и
// говорим, что именно не заполнено.
const META_KEY = 'worksDataset';
const datasetId = Editor.getId(META_KEY);

if (!datasetId) {
    throw new Error(
        'Не задан id датасета. Впишите во вкладку Meta: {"links": {"' +
        META_KEY + '": "<id датасета из адреса .../datasets/ID>"}}'
    );
}

// Имена полей должны совпадать с датасетом дословно, включая «(индикатор)».
const fields = [
    {ref: {type: 'title', title: 'Тип'}},
    {ref: {type: 'title', title: '0. Данные уточняются (индикатор)'}},
    {ref: {type: 'title', title: '1. Работы не начаты (индикатор)'}},
    {ref: {type: 'title', title: '2. В работе (индикатор)'}},
    {ref: {type: 'title', title: '3. Реализовано (индикатор)'}},
];

module.exports = {
    works: {
        datasetId: datasetId,
        data: {
            fields: fields,
            filters: [],
            limit: 1000,
        },
    },
};
