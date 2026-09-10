// ============================================================================
//  Вкладка Sources — запрос данных из датасета.
//  Ключ 'composition' совпадает с SOURCE_KEY во вкладке Prepare.
//  Измерения тут нет: чарт показывает одну полосу из трёх мер.
// ============================================================================

// Id датасета DataLens берёт из links вкладки Meta — вкладка Meta должна
// содержать {"links": {"compositionDataset": "<id датасета>"}}.
// Если ключа там нет, getId возвращает пустую строку, и чарт падает с
// «Source with id "" was not found in the meta links»; ловим это сразу и
// говорим, что именно не заполнено.
const META_KEY = 'compositionDataset';
const datasetId = Editor.getId(META_KEY);

if (!datasetId) {
    throw new Error(
        'Не задан id датасета. Впишите во вкладку Meta: {"links": {"' +
        META_KEY + '": "<id датасета из адреса .../datasets/ID>"}}'
    );
}

const fields = [
    {ref: {type: 'title', title: 'ЛиР (ниже не приводятся)'}},
    {ref: {type: 'title', title: 'Не требуется ДК'}},
    {ref: {type: 'title', title: 'Оставшиеся'}},
];

module.exports = {
    composition: {
        datasetId: datasetId,
        data: {
            fields: fields,
            filters: [],
            limit: 1000,
        },
    },
};
