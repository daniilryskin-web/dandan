// ============================================================================
//  Вкладка Controls — селекторы над чартом.
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
    ],
};
