// ============================================================================
//  Вкладка «Элементы управления» (UI) — селекторы над чартом.
//  Значения попадают в ChartEditor.getParams() как массивы.
// ============================================================================

module.exports = [
    {
        type: 'select',
        param: 'stacking',
        label: 'Режим',
        updateOnChange: true,
        content: [
            {title: 'Сумма', value: 'normal'},
            {title: 'Доли, %', value: 'percent'},
        ],
    },
    {
        type: 'select',
        param: 'total_line',
        label: 'Линия итогов',
        updateOnChange: true,
        content: [
            {title: 'Скрыть', value: 'off'},
            {title: 'Показать', value: 'on'},
        ],
    },
];
