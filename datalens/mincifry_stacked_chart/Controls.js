// ============================================================================
//  Вкладка Controls — селекторы над чартом.
//  Влияют только на этот чарт; состояние не сохраняется после перезагрузки.
// ============================================================================

module.exports = {
    controls: [
        {
            type: 'select',
            param: 'stacking',
            label: 'Режим',
            labelPlacement: 'left',
            updateOnChange: true,
            width: 160,
            content: [
                {title: 'Сумма', value: 'abs'},
                {title: 'Доли, %', value: 'percent'},
            ],
        },
        {
            type: 'select',
            param: 'totals',
            label: 'Итоги',
            labelPlacement: 'left',
            updateOnChange: true,
            width: 160,
            content: [
                {title: 'Показать', value: 'on'},
                {title: 'Скрыть', value: 'off'},
            ],
        },
    ],
};
