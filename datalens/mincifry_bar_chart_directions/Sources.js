// ============================================================================
//  Вкладка Sources — запрос данных из датасета.
//  Ключ 'directions' совпадает с SOURCE_KEY во вкладке Prepare.
// ============================================================================

// Id датасета DataLens берёт из links вкладки Meta — вкладка Meta должна
// содержать {"links": {"directionsDataset": "<id датасета>"}}.
// Если ключа там нет, getId возвращает пустую строку, и чарт падает с
// «Source with id "" was not found in the meta links»; ловим это сразу и
// говорим, что именно не заполнено.
const META_KEY = 'directionsDataset';
const datasetId = Editor.getId(META_KEY);

if (!datasetId) {
    throw new Error(
        'Не задан id датасета. Впишите во вкладку Meta: {"links": {"' +
        META_KEY + '": "<id датасета из адреса .../datasets/ID>"}}'
    );
}

// Поле категории — то самое вычисляемое поле с CONCAT, которое в визарде
// стоит по оси Y. Подставьте его точное имя из датасета.
const fields = [
    {ref: {type: 'title', title: 'Направление'}},
    {ref: {type: 'title', title: 'Рефакторинг'}},
    {ref: {type: 'title', title: 'Онлайн'}},
    {ref: {type: 'title', title: 'Проактив'}},
];

module.exports = {
    directions: {
        datasetId: datasetId,
        data: {
            fields: fields,
            filters: [],
            limit: 1000,
        },
    },
};
